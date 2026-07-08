import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { readFileSync } from "fs";
import * as path from "path";
import { ProxyStackProps } from "../types";

export class ProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ProxyStackProps) {
    super(scope, id, props);

    const envName = props.envTarget.name;
    const qualifiedName = `${props.namePrefix}-${envName}`;

    // -------------------------------------------------------------------------
    // Network: Vpc.fromLookup — identical to the original squid-aws-proxy.
    // Requires cdk.context.json to be populated (committed to the repo).
    // This gives full subnet metadata at synth time so:
    //   - vpc.availabilityZones works for the ASG forEach loop
    //   - SubnetType.PUBLIC works for ASG subnet selection
    //   - subnet.routeTable.routeTableId works for the RouteTableIds tag
    // -------------------------------------------------------------------------
    const vpc = ec2.Vpc.fromLookup(this, "Vpc", {
      vpcId: props.networkLookup.vpcId,
    });

    // -------------------------------------------------------------------------
    // S3 bucket for Squid config / whitelist files
    // -------------------------------------------------------------------------

    const configBucket = new s3.Bucket(this, "ProxyConfigBucket", {
      bucketName: `${qualifiedName}-proxy-config`,
      encryption: s3.BucketEncryption.KMS_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: props.proxy.removalPolicy,
      autoDeleteObjects: props.proxy.removalPolicy === cdk.RemovalPolicy.DESTROY,
    });

    const configFilesPath = path.resolve(props.proxy.configFilesPath);
    new s3deploy.BucketDeployment(this, "ConfigDeploy", {
      destinationBucket: configBucket,
      sources: [s3deploy.Source.asset(configFilesPath)],
    });

    // -------------------------------------------------------------------------
    // IAM role for proxy EC2 instances
    // -------------------------------------------------------------------------

    const instanceRole = new iam.Role(this, "ProxyInstanceRole", {
      roleName: `${qualifiedName}-proxy-instance`,
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentServerPolicy"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonEC2RoleforSSM"),
      ],
    });

    // Allow source-dest-check disable
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ec2:ModifyInstanceAttribute"],
        resources: ["*"],
      })
    );

    // EIP allocation, association, tagging, and SSM publishing.
    // DescribeTags + CreateTags are required by the user-data tag-copy logic
    // (instance tags → EIP). Without them the copy fails silently (|| true)
    // and EIPs come up untagged.
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ec2:AllocateAddress",
          "ec2:AssociateAddress",
          "ec2:DescribeAddresses",
          "ec2:DescribeTags",
          "ec2:CreateTags",
          "ssm:GetParameter",
          "ssm:PutParameter",
        ],
        resources: ["*"],
      })
    );

    // Read-only: instances only ever `s3 sync` bucket → local. A compromised
    // proxy must not be able to rewrite the whitelist that governs the whole
    // VPC's egress.
    configBucket.grantRead(instanceRole);

    // -------------------------------------------------------------------------
    // CloudWatch log groups (one pair shared across all AZ instances)
    // -------------------------------------------------------------------------

    const accessLogGroup = new logs.LogGroup(this, "AccessLogGroup", {
      logGroupName: `${props.proxy.logGroupPrefix}/${qualifiedName}/access`,
      removalPolicy: props.proxy.removalPolicy,
    });

    const cacheLogGroup = new logs.LogGroup(this, "CacheLogGroup", {
      logGroupName: `${props.proxy.logGroupPrefix}/${qualifiedName}/cache`,
      removalPolicy: props.proxy.removalPolicy,
    });

    // -------------------------------------------------------------------------
    // SNS topic for CloudWatch alarms → Lambda
    // -------------------------------------------------------------------------

    const alarmTopic = new sns.Topic(this, "ProxyAlarmTopic", {
      displayName: `${qualifiedName} Proxy Alarm Topic`,
    });

    // -------------------------------------------------------------------------
    // Lambda — updates route tables when an alarm fires or clears
    // -------------------------------------------------------------------------

    const lambdaRole = new iam.Role(this, "LambdaRole", {
      roleName: `${qualifiedName}-proxy-lambda`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "autoscaling:CompleteLifecycleAction",
          "autoscaling:Describe*",
          "autoscaling:DescribeAutoScalingGroups",
          "autoscaling:SetInstanceHealth",
          "cloudwatch:Describe*",
          "ec2:CreateRoute",
          "ec2:CreateTags",
          "ec2:Describe*",
          "ec2:ReplaceRoute",
        ],
        resources: ["*"],
      })
    );

    const alarmFn = new lambda.Function(this, "AlarmFunction", {
      functionName: `${qualifiedName}-proxy-alarm`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "lambda-handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../../assets/lambda")),
      role: lambdaRole,
      environment: {
        TOPIC_ARN: alarmTopic.topicArn,
      },
      timeout: cdk.Duration.seconds(30),
    });

    alarmFn.addPermission("SnsInvoke", {
      principal: new iam.ServicePrincipal("sns.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: alarmTopic.topicArn,
    });

    alarmTopic.addSubscription(new snsSubs.LambdaSubscription(alarmFn));

    // -------------------------------------------------------------------------
    // One ASG per AZ (max-capacity 1 — each proxy is a singleton per AZ)
    // -------------------------------------------------------------------------

    const squidAsgs: autoscaling.AutoScalingGroup[] = [];

    vpc.availabilityZones.forEach((az, index) => {
      // Security group for this proxy instance
      const sg = new ec2.SecurityGroup(this, `ProxySg${index}`, {
        vpc,
        allowAllOutbound: true,
        description: `Squid proxy SG for ${qualifiedName} AZ${index + 1}`,
      });
      sg.addIngressRule(
        ec2.Peer.ipv4(props.networkLookup.vpcCidr),
        ec2.Port.tcp(80),
        "HTTP from VPC"
      );
      sg.addIngressRule(
        ec2.Peer.ipv4(props.networkLookup.vpcCidr),
        ec2.Port.tcp(443),
        "HTTPS from VPC"
      );
      sg.addIngressRule(
        ec2.Peer.ipv4(props.networkLookup.vpcCidr),
        ec2.Port.tcp(3128),
        "Squid explicit proxy from VPC"
      );
      sg.addIngressRule(
        ec2.Peer.ipv4(props.networkLookup.vpcCidr),
        ec2.Port.tcp(22),
        "SSH from VPC"
      );

      // Give the ASG an explicit concrete name.
      // This is the key fix for the circular dependency:
      //   alarm name → asg.autoScalingGroupName (CFN Ref) → ASG → lifecycle hook
      //   → SNS topic → (Lambda subscription) → alarm action → alarm → cycle
      // By setting an explicit name, asg.autoScalingGroupName becomes a plain
      // string (no CFN Ref), so the alarm name is also concrete — cycle broken.
      const asgName = `${qualifiedName}-proxy-az${index}`;

      const asg = new autoscaling.AutoScalingGroup(this, `ProxyAsg${index}`, {
        autoScalingGroupName: asgName,
        vpc,
        instanceType: new ec2.InstanceType(props.proxy.instanceType),
        machineImage: ec2.MachineImage.latestAmazonLinux2023({
          edition: ec2.AmazonLinuxEdition.STANDARD,
        }),
        role: instanceRole,
        securityGroup: sg,
        desiredCapacity: 1,
        minCapacity: 1,
        maxCapacity: 1,
        // AL2023 AMIs default to IMDSv2-required, but make it explicit so a
        // future machineImage swap can't silently weaken it. The user-data
        // already uses token-based IMDS calls.
        requireImdsv2: true,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PUBLIC,
          availabilityZones: [az],
        },
        healthChecks: autoscaling.HealthChecks.ec2({
          gracePeriod: cdk.Duration.minutes(8),
        }),
        // NOTE: We do NOT use autoscaling.Signals.waitForAll() here.
        // CDK's Signals implementation adds DependsOn edges between every ASG
        // in the stack to enforce signal ordering — this creates the circular
        // dependency with lifecycle hooks and alarms that CFN rejects.
        // cfn-signal is called directly in user-data (EXIT trap), and the raw
        // CreationPolicy / UpdatePolicy below make CFN wait for it.
      });

      const cfnAsg = asg.node.defaultChild as autoscaling.CfnAutoScalingGroup;
      const asgLogicalId = cfnAsg.logicalId;

      // CFN waits for the cfn-signal issued by the user-data EXIT trap.
      cfnAsg.cfnOptions.creationPolicy = {
        resourceSignal: { count: 1, timeout: "PT30M" },
      };

      // Rolling update so launch-template changes (new AL2023 AMI resolved at
      // deploy time, user-data edits) actually replace the running instance.
      // Without this, CFN updates the LT and the old instance keeps running
      // on the old AMI indefinitely.
      //
      // waitOnResourceSignals: a replacement that fails to signal rolls the
      // ASG back to the previous launch template version — critical for a
      // proxy whose outage cascades into EKS node bootstrap failures.
      //
      // Trade-offs with min=max=1:
      //   - minInstancesInService must be 0, so each AMI rollout causes a few
      //     minutes of egress downtime in this AZ.
      //   - Both per-AZ ASGs live in this stack and update roughly
      //     concurrently. If simultaneous downtime across AZs is unacceptable
      //     in prod, pin the AMI (cachedInContext) and bump it deliberately.
      cfnAsg.cfnOptions.updatePolicy = {
        autoScalingRollingUpdate: {
          minInstancesInService: 0,
          maxBatchSize: 1,
          waitOnResourceSignals: true,
          pauseTime: "PT15M",
        },
      };

      // Build user-data using ONLY concrete strings — no CDK tokens allowed.
      //
      // When asg.addUserData() receives a string containing CFN tokens (e.g.
      // this.region, asg.autoScalingGroupName as a Ref), CDK wraps the entire
      // UserData in Fn::Sub. CFN's Fn::Sub then rejects any bare bash dollar
      // signs ($((...)), ${VAR}) as malformed intrinsic function arguments —
      // even though they are valid bash syntax.
      //
      // this.stackName is safe here: with an explicit `stackName` prop (or
      // the default derived name) it is a concrete string at synth time for a
      // top-level stack. Do NOT use this.artifactId — that is the cloud
      // assembly artifact id (derived from the construct id), which diverges
      // from the deployed stack name whenever stackName is set explicitly,
      // sending cfn-signal to a stack that doesn't exist and forcing every
      // deploy into the full PT30M timeout + rollback.
      const userDataTemplate = readFileSync(
        path.join(__dirname, "../../assets/user_data/squid_user_data.sh"),
        "utf-8"
      );

      // Plain string replacement — no Fn::Sub, no CDK tokens.
      // ${aws:AutoScalingGroupName} in the CW agent config is inside a
      // single-quoted heredoc (<< 'EOF') so the shell never expands it;
      // the CW agent resolves it at runtime via EC2 instance metadata.
      const eipSsmParam = `${props.ssmPrefix}/${props.project}/${props.application}/${envName}/proxy-eip-${index}`;

      const userDataStr = userDataTemplate
        .replace(/__REGION__/g, props.envTarget.region)
        .replace(/__STACK_NAME__/g, this.stackName)
        .replace(/__ASG__/g, asgLogicalId)
        .replace(/__ASG_NAME__/g, asgName)
        .replace(/__S3BUCKET__/g, configBucket.bucketName)
        .replace(/__SSM_EIP_PARAM__/g, eipSsmParam)
        .replace(/__PROJECT__/g, props.project)
        .replace(/__APPLICATION__/g, props.application)
        .replace(/__ENV_NAME__/g, envName);

      asg.addUserData(userDataStr);

      // Derive route table IDs from proxied subnet IDs at synth time —
      // identical to the original squid-aws-proxy approach.
      // Vpc.fromLookup + cdk.context.json gives us real subnet metadata
      // so subnet.routeTable.routeTableId resolves to a concrete string.
      const selection = vpc.selectSubnets({
        subnetFilters: [ec2.SubnetFilter.byIds(props.networkLookup.proxiedSubnetIds)],
      });

      let routeTableIds = "";
      selection.subnets!.forEach((subnet) => {
        routeTableIds = routeTableIds
          ? `${routeTableIds},${subnet.routeTable.routeTableId}`
          : subnet.routeTable.routeTableId;
      });

      cdk.Tags.of(asg).add("RouteTableIds", routeTableIds, {
        applyToLaunchedInstances: false,
      });

      // CloudWatch alarm — breaches when Squid process CPU disappears.
      //
      // Dimensions: AutoScalingGroupName ONLY. The CW agent config declares
      //   aggregation_dimensions: [["AutoScalingGroupName"]]
      // which publishes a rollup copy of procstat_cpu_usage keyed solely on
      // the ASG name. That rollup is stable across agent versions, unlike the
      // full per-process dimension set (pidfile/process_name), whose exact
      // combination varies — and a dimension set that matches nothing means
      // permanently-missing data, which with BREACHING would drive a
      // perpetual ALARM → route-flap loop via the Lambda.
      //
      // Verify once on a live instance: CloudWatch → Metrics → CWAgent →
      // confirm procstat_cpu_usage appears under the AutoScalingGroupName-only
      // dimension set before trusting failover to it.
      const squidMetric = new cloudwatch.Metric({
        namespace: "CWAgent",
        metricName: "procstat_cpu_usage",
        dimensionsMap: {
          AutoScalingGroupName: asgName,
        },
      });

      const alarm = new cloudwatch.Alarm(this, `SquidAlarm${index}`, {
        alarmName: `squid-alarm_${asgName}`,
        alarmDescription: `Squid heartbeat for ${qualifiedName} AZ${index + 1}`,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        metric: squidMetric,
        // 3 evaluation periods × 5 min = 15 min of missing data before alarming.
        // Gives newly-launched instances time to boot, start CW agent, and emit
        // the first procstat metric — avoiding false ALARM storms on deployment.
        // NOTE: on a brand-new environment the alarm starts in ALARM (metric
        // doesn't exist yet, treatMissingData=BREACHING) and flips to OK once
        // the first instance reports. The Lambda must tolerate that initial
        // ALARM→OK sequence when route tables don't yet contain proxy routes.
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        threshold: 0,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });

      alarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
      alarm.addOkAction(new cwActions.SnsAction(alarmTopic));

      squidAsgs.push(asg);
    });

    // -------------------------------------------------------------------------
    // SSM outputs — EIP param names (EIPs themselves written by user-data)
    // -------------------------------------------------------------------------

    if (props.proxy.allocateEips) {
      // Write the SSM parameter *names* for the EIPs so other stacks can discover them.
      // The actual EIP values are written by each instance's user-data on first boot.
      const eipParamPrefix = `${props.ssmPrefix}/${props.project}/${props.application}/${envName}/proxy-eip`;

      new ssm.StringParameter(this, "EipParamPrefix", {
        parameterName: `${eipParamPrefix}-param-prefix`,
        stringValue: eipParamPrefix,
        description: `SSM prefix under which proxy EIPs are published for ${qualifiedName}`,
      });

      new cdk.CfnOutput(this, "EipParamPrefixOutput", {
        value: eipParamPrefix,
        exportName: `${qualifiedName}-proxy-eip-param-prefix`,
        description:
          "SSM prefix for proxy EIP parameters. Suffix with -0, -1, … for each AZ.",
      });
    }

    // SSM: config bucket name (useful for debugging / manual config refreshes)
    new ssm.StringParameter(this, "ConfigBucketParam", {
      parameterName: `${props.ssmPrefix}/${props.project}/${props.application}/${envName}/proxy-config-bucket`,
      stringValue: configBucket.bucketName,
    });

    new cdk.CfnOutput(this, "ConfigBucket", {
      value: configBucket.bucketName,
      exportName: `${qualifiedName}-proxy-config-bucket`,
    });

    // Log group names for operational reference
    new cdk.CfnOutput(this, "AccessLogGroupOutput", {
      value: accessLogGroup.logGroupName,
      exportName: `${qualifiedName}-proxy-access-log-group`,
    });

    new cdk.CfnOutput(this, "CacheLogGroupOutput", {
      value: cacheLogGroup.logGroupName,
      exportName: `${qualifiedName}-proxy-cache-log-group`,
    });
  }
}
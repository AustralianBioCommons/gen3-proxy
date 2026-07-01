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
import * as hooktargets from "aws-cdk-lib/aws-autoscaling-hooktargets";
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
    // Network: resolve VPC + subnets
    //
    // Vpc.fromLookup() and Vpc.fromVpcAttributes() both require a *concrete*
    // VPC ID at synth time — SSM tokens (cdk.Token) are rejected.
    // We therefore take vpcId as a literal string in the config (same approach
    // gen3-search uses for availabilityZones).
    //
    // Subnet IDs *can* be SSM tokens because ec2.Subnet.fromSubnetId() and the
    // ASG vpcSubnets accept CFN tokens — they're only resolved at deploy time.
    // We follow the exact same Fn.split / Fn.select pattern as gen3-search.
    // -------------------------------------------------------------------------

    const azCount = props.networkLookup.availabilityZones.length;

    // Public subnets — where proxy EC2 instances are placed
    const publicSubnetIdsRaw = ssm.StringParameter.valueForStringParameter(
      this,
      props.networkLookup.publicSubnetIdsParameterName
    );
    const publicSubnetIds = cdk.Fn.split(",", publicSubnetIdsRaw);

    // Proxied subnets — whose route tables the Lambda updates on failover.
    // The Lambda reads the SSM param name from the ASG tag and calls
    // ec2:DescribeSubnets at runtime to get actual route table IDs.
    const proxiedSubnetIdsRaw = ssm.StringParameter.valueForStringParameter(
      this,
      props.networkLookup.proxiedSubnetIdsParameterName
    );

    // Build concrete Subnet objects for each public AZ slot using Fn::Select.
    // These are used in vpcSubnets on the ASG — CDK accepts token subnet IDs here.
    const publicSubnets = Array.from({ length: azCount }, (_, i) =>
      ec2.Subnet.fromSubnetId(
        this,
        `PublicSubnet${i}`,
        cdk.Fn.select(i, publicSubnetIds)
      )
    );

    // Vpc.fromVpcAttributes accepts token vpcId only if we do NOT pass subnet
    // arrays (which trigger AZ-count validation at synth time).
    // We pass the concrete vpcId from config and placeholder AZs so the VPC
    // object can be used for security-group / CIDR references.
    const vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
      vpcId: props.networkLookup.vpcId,
      availabilityZones: props.networkLookup.availabilityZones,
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

    // Allow source-dest-check disable and route table mutation (NAT behaviour)
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ec2:ModifyInstanceAttribute"],
        resources: ["*"],
      })
    );

    // Allow EIP allocation + association from user data (when allocateEips=true)
    if (props.proxy.allocateEips) {
      instanceRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "ec2:AllocateAddress",
            "ec2:AssociateAddress",
            "ec2:DescribeAddresses",
            "ec2:DescribeInstances",
          ],
          resources: ["*"],
        })
      );
      // Allow writing EIP public IPs to SSM so consumers can allowlist them
      instanceRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ssm:PutParameter"],
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/${props.project}/${props.application}/${envName}/proxy-eip-*`,
          ],
        })
      );
    }

    configBucket.grantReadWrite(instanceRole);

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

    props.networkLookup.availabilityZones.forEach((az, index) => {
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

      const asg = new autoscaling.AutoScalingGroup(this, `ProxyAsg${index}`, {
        vpc,
        instanceType: new ec2.InstanceType(props.proxy.instanceType),
        machineImage: ec2.MachineImage.latestAmazonLinux2({
          storage: ec2.AmazonLinuxStorage.GENERAL_PURPOSE,
          edition: ec2.AmazonLinuxEdition.STANDARD,
          virtualization: ec2.AmazonLinuxVirt.HVM,
        }),
        role: instanceRole,
        securityGroup: sg,
        desiredCapacity: 1,
        minCapacity: 1,
        maxCapacity: 1,
        // Use the explicit subnet object derived from the SSM token via Fn::Select.
        // Passing a SubnetType would trigger a VPC subnet lookup at synth time,
        // which fails when the VPC has no real subnet metadata (fromVpcAttributes).
        vpcSubnets: { subnets: [publicSubnets[index]] },
        healthChecks: autoscaling.HealthChecks.ec2({
          gracePeriod: cdk.Duration.minutes(8),
        }),
        signals: autoscaling.Signals.waitForAll({
          timeout: cdk.Duration.minutes(15),
        }),
      });

      // Build user-data from the shared template, substituting tokens
      const cfnAsg = asg.node.defaultChild as autoscaling.CfnAutoScalingGroup;
      const asgLogicalId = cfnAsg.logicalId;

      const userDataTemplate = readFileSync(
        path.join(__dirname, "../../assets/user_data/squid_user_data.sh"),
        "utf-8"
      );

      // Static token substitutions (CDK-time)
      let userDataStr = userDataTemplate
        .replace(/__S3BUCKET__/g, configBucket.bucketName)
        .replace(/__ASG__/g, asgLogicalId)
        .replace(/__AZ_INDEX__/g, String(index))
        .replace(/__ENV_NAME__/g, envName)
        .replace(/__SSM_PREFIX__/g, props.ssmPrefix)
        .replace(/__PROJECT__/g, props.project)
        .replace(/__APPLICATION__/g, props.application)
        .replace(/__ALLOCATE_EIPS__/g, props.proxy.allocateEips ? "true" : "false");

      // CloudFormation pseudo-references (resolved at deploy time by CFN Fn::Sub)
      const userData = cdk.Fn.sub(userDataStr, {
        __CW_ASG__: "${aws:AutoScalingGroupName}",
      });

      asg.addUserData(userData);

      // Lifecycle hook — Lambda completes it once routing is confirmed healthy
      const hookTopic = new sns.Topic(this, `LifecycleHookTopic${index}`, {
        displayName: `${qualifiedName} ASG${index + 1} Lifecycle Hook`,
      });

      new autoscaling.LifecycleHook(this, `LifecycleHook${index}`, {
        autoScalingGroup: asg,
        lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_LAUNCHING,
        notificationTarget: new hooktargets.TopicHook(hookTopic),
        defaultResult: autoscaling.DefaultResult.ABANDON,
        heartbeatTimeout: cdk.Duration.minutes(5),
      });

      // Tag the ASG with the proxied route-table IDs so the Lambda can find them.
      // We derive these from the SSM-sourced subnet list via Fn::Split + Fn::Select.
      // The Lambda reads this tag to know which route tables to update.
      // We store the raw SSM token — the Lambda will resolve the actual route table
      // IDs from the subnet IDs at runtime using ec2:DescribeSubnets.
      cdk.Tags.of(asg).add(
        "ProxiedSubnetIdsParam",
        props.networkLookup.proxiedSubnetIdsParameterName,
        { applyToLaunchedInstances: false }
      );
      cdk.Tags.of(asg).add("AzIndex", String(index), {
        applyToLaunchedInstances: false,
      });

      // CloudWatch alarm — breaches when Squid process CPU disappears
      const squidMetric = new cloudwatch.Metric({
        namespace: "CWAgent",
        metricName: "procstat_cpu_usage",
        dimensionsMap: {
          AutoScalingGroupName: asg.autoScalingGroupName,
          pidfile: "/var/run/squid.pid",
          process_name: "squid",
        },
      });

      const alarm = new cloudwatch.Alarm(this, `SquidAlarm${index}`, {
        alarmName: `squid-alarm_${asg.autoScalingGroupName}`,
        alarmDescription: `Squid heartbeat for ${qualifiedName} AZ${index + 1}`,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        metric: squidMetric,
        evaluationPeriods: 1,
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

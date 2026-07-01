import * as cdk from "aws-cdk-lib";

// ---------------------------------------------------------------------------
// Config file types (what the caller repo's proxy.json contains)
// ---------------------------------------------------------------------------

export interface EnvironmentTarget {
  name: string;
  account: string;
  region: string;
}

export interface AppConfig {
  project: string;
  application: string;
  owner?: string;
  tags?: Record<string, string>;
  naming: NamingConfig;
  environments: Record<string, EnvironmentTarget>;
  stages: StageConfig[];
}

export interface NamingConfig {
  namePrefix: string;
  ssmPrefix: string;
  secretPrefix: string;
}

export interface StageConfig {
  id: string;
  stageName: string;
  envKey: string;
  networkLookup: NetworkLookupConfig;
  proxy: ProxyConfig;
  approvals?: ApprovalConfig;
}

export interface NetworkLookupConfig {
  /** SSM param name containing the VPC ID */
  vpcIdParameterName: string;
  /**
   * SSM param name containing a comma-separated list of private/isolated subnet
   * IDs whose route tables the proxy will update (the "proxied" subnets).
   */
  proxiedSubnetIdsParameterName: string;
  /**
   * SSM param name containing a comma-separated list of public subnet IDs where
   * the proxy EC2 instances will be launched.
   */
  publicSubnetIdsParameterName: string;
  /** VPC CIDR — used for security-group ingress rules. */
  vpcCidr: string;
}

export interface ProxyConfig {
  enabled: boolean;
  /** EC2 instance type for Squid proxy hosts. Defaults to t3.small. */
  instanceType?: string;
  /**
   * Whether to allocate an Elastic IP for each proxy instance (one per AZ).
   * When true the EIPs are allocated and associated via the launch-template
   * user-data / instance-lifecycle hook; their public IPs are written to SSM.
   * Defaults to true.
   */
  allocateEips?: boolean;
  /** Squid config files to sync from S3. Defaults to assets/config_files. */
  configFilesPath?: string;
  /** CloudWatch log group name prefix. Defaults to /gen3-proxy. */
  logGroupPrefix?: string;
  removalPolicy?: "DESTROY" | "RETAIN" | "SNAPSHOT";
}

export interface ApprovalConfig {
  requireManualApproval?: boolean;
}

// ---------------------------------------------------------------------------
// Resolved / runtime types (after loader has applied defaults)
// ---------------------------------------------------------------------------

export interface ResolvedNetworkLookupConfig {
  vpcIdParameterName: string;
  proxiedSubnetIdsParameterName: string;
  publicSubnetIdsParameterName: string;
  vpcCidr: string;
}

export interface ResolvedProxyConfig {
  enabled: boolean;
  instanceType: string;
  allocateEips: boolean;
  configFilesPath: string;
  logGroupPrefix: string;
  removalPolicy: cdk.RemovalPolicy;
}

export interface ResolvedStageConfig {
  id: string;
  stageName: string;
  envTarget: EnvironmentTarget;
  networkLookup: ResolvedNetworkLookupConfig;
  proxy: ResolvedProxyConfig;
  requireManualApproval: boolean;
}

// ---------------------------------------------------------------------------
// CDK Stack props
// ---------------------------------------------------------------------------

export interface BaseNamingProps {
  project: string;
  application: string;
  namePrefix: string;
  ssmPrefix: string;
  secretPrefix: string;
}

export interface ProxyStackProps extends cdk.StackProps, BaseNamingProps {
  envTarget: EnvironmentTarget;
  networkLookup: ResolvedNetworkLookupConfig;
  proxy: ResolvedProxyConfig;
}

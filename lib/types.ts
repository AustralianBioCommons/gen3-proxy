import * as cdk from "aws-cdk-lib";

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
  vpcId: string;
  /** SSM param name containing a comma-separated list of public subnet IDs. */
  publicSubnetIdsParameterName: string;
  /** SSM param name containing a comma-separated list of private/isolated subnet IDs. */
  proxiedSubnetIdsParameterName: string;
  /** VPC CIDR — used for security-group ingress rules. */
  vpcCidr: string;
  /**
   * Availability zones — must match the VPC's AZs.
   * Required because Vpc.fromVpcAttributes needs concrete AZ strings at synth time.
   */
  availabilityZones: string[];
}

export interface ProxyConfig {
  enabled: boolean;
  instanceType?: string;
  allocateEips?: boolean;
  configFilesPath?: string;
  logGroupPrefix?: string;
  removalPolicy?: "DESTROY" | "RETAIN" | "SNAPSHOT";
}

export interface ApprovalConfig {
  requireManualApproval?: boolean;
}

export interface ResolvedNetworkLookupConfig {
  vpcId: string;
  publicSubnetIdsParameterName: string;
  proxiedSubnetIdsParameterName: string;
  vpcCidr: string;
  availabilityZones: string[];
  /**
   * Concrete subnet IDs fetched from SSM at synth time (in deploy-proxy.ts).
   * Used with vpc.selectSubnets() to derive route table IDs — identical to
   * the original squid-aws-proxy proxiedSubnets approach.
   */
  proxiedSubnetIds: string[];
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

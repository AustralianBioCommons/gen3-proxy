import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import {
  AppConfig,
  EnvironmentTarget,
  ProxyConfig,
  ResolvedProxyConfig,
  ResolvedStageConfig,
  StageConfig,
} from "../types";
import { validateConfig } from "./schema";

export function loadAppConfig(configPath: string): AppConfig {
  const absolutePath = path.resolve(configPath);
  const config = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as AppConfig;
  validateConfig(config);
  return config;
}

function resolveRemovalPolicy(value?: string): cdk.RemovalPolicy {
  switch ((value ?? "RETAIN").toUpperCase()) {
    case "DESTROY": return cdk.RemovalPolicy.DESTROY;
    case "SNAPSHOT": return cdk.RemovalPolicy.SNAPSHOT;
    default: return cdk.RemovalPolicy.RETAIN;
  }
}

function resolveProxyConfig(proxy: ProxyConfig): ResolvedProxyConfig {
  return {
    enabled: proxy.enabled,
    instanceType: proxy.instanceType ?? "t3.small",
    allocateEips: proxy.allocateEips ?? true,
    configFilesPath: proxy.configFilesPath ?? "./assets/config_files",
    logGroupPrefix: proxy.logGroupPrefix ?? "/gen3-proxy",
    removalPolicy: resolveRemovalPolicy(proxy.removalPolicy),
  };
}

export function resolveStageConfig(
  appConfig: AppConfig,
  stage: StageConfig,
  proxiedSubnetIds: string[]   // fetched from SSM by the entrypoint
): ResolvedStageConfig {
  const envTarget = appConfig.environments[stage.envKey];
  if (!envTarget) {
    throw new Error(`stage ${stage.id}: envKey '${stage.envKey}' not found in environments`);
  }

  return {
    id: stage.id,
    stageName: stage.stageName,
    envTarget,
    networkLookup: {
      vpcId: stage.networkLookup.vpcId,
      publicSubnetIdsParameterName: stage.networkLookup.publicSubnetIdsParameterName,
      proxiedSubnetIdsParameterName: stage.networkLookup.proxiedSubnetIdsParameterName,
      vpcCidr: stage.networkLookup.vpcCidr,
      availabilityZones: stage.networkLookup.availabilityZones,
      proxiedSubnetIds,   // concrete, resolved from SSM
    },
    proxy: resolveProxyConfig(stage.proxy),
    requireManualApproval: stage.approvals?.requireManualApproval ?? false,
  };
}

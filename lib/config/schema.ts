import { AppConfig } from "../types";

export function validateConfig(config: AppConfig): void {
  if (!config.project) throw new Error("project is required");
  if (!config.application) throw new Error("application is required");
  if (!config.naming?.namePrefix) throw new Error("naming.namePrefix is required");
  if (!config.naming?.ssmPrefix) throw new Error("naming.ssmPrefix is required");
  if (!config.naming?.secretPrefix) throw new Error("naming.secretPrefix is required");

  if (!config.environments || Object.keys(config.environments).length === 0) {
    throw new Error("environments is required");
  }
  if (!Array.isArray(config.stages) || config.stages.length === 0) {
    throw new Error("at least one stage is required");
  }

  for (const stage of config.stages) {
    if (!stage.id) throw new Error("each stage requires id");
    if (!stage.stageName) throw new Error(`stage ${stage.id}: stageName is required`);
    if (!stage.envKey) throw new Error(`stage ${stage.id}: envKey is required`);
    if (!config.environments[stage.envKey]) {
      throw new Error(`stage ${stage.id}: envKey '${stage.envKey}' not found in environments`);
    }
    if (!stage.networkLookup?.vpcId) throw new Error(`stage ${stage.id}: networkLookup.vpcId is required`);
    if (!stage.networkLookup?.publicSubnetIdsParameterName) throw new Error(`stage ${stage.id}: networkLookup.publicSubnetIdsParameterName is required`);
    if (!stage.networkLookup?.proxiedSubnetIdsParameterName) throw new Error(`stage ${stage.id}: networkLookup.proxiedSubnetIdsParameterName is required`);
    if (!stage.networkLookup?.vpcCidr) throw new Error(`stage ${stage.id}: networkLookup.vpcCidr is required`);
    if (!stage.networkLookup?.availabilityZones?.length) throw new Error(`stage ${stage.id}: networkLookup.availabilityZones is required`);
    if (!stage.proxy) throw new Error(`stage ${stage.id}: proxy is required`);
  }
}

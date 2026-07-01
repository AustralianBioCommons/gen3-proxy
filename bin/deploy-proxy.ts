#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { loadAppConfig, resolveStageConfig } from "../lib/config/loader";
import { ProxyStack } from "../lib/stacks/proxy-stack";

async function fetchSSMParameter(region: string, paramName: string): Promise<string> {
  const client = new SSMClient({ region });
  const response = await client.send(new GetParameterCommand({ Name: paramName }));
  if (!response.Parameter?.Value) {
    throw new Error(`SSM parameter not found or empty: ${paramName}`);
  }
  return response.Parameter.Value;
}

(async () => {
  const app = new cdk.App();

  const configPath = app.node.tryGetContext("config");
  if (!configPath) {
    throw new Error("Missing CDK context key: config.  Pass -c config=<path-to-proxy.json>");
  }

  const config = loadAppConfig(configPath);

  cdk.Tags.of(app).add("Project", config.project);
  cdk.Tags.of(app).add("Application", config.application);
  if (config.owner) cdk.Tags.of(app).add("Owner", config.owner);
  for (const [key, value] of Object.entries(config.tags ?? {})) {
    cdk.Tags.of(app).add(key, value);
  }

  for (const stageConfig of config.stages) {
    if (!stageConfig.proxy.enabled) continue;

    const region = config.environments[stageConfig.envKey].region;

    // Fetch the proxied subnet IDs from SSM at synth time — same pattern as
    // the original squid-aws-proxy fetching BuildEnv from /gen3/squid-environments.
    // This gives us concrete subnet IDs so vpc.selectSubnets() can derive route
    // table IDs at synth time, without needing cdk.context.json or proxy.json changes.
    console.log(`Fetching proxied subnet IDs from SSM: ${stageConfig.networkLookup.proxiedSubnetIdsParameterName}`);
    const proxiedSubnetsRaw = await fetchSSMParameter(
      region,
      stageConfig.networkLookup.proxiedSubnetIdsParameterName
    );
    const proxiedSubnetIds = proxiedSubnetsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    console.log(`Resolved proxied subnet IDs: ${proxiedSubnetIds.join(", ")}`);

    const resolved = resolveStageConfig(config, stageConfig, proxiedSubnetIds);

    const stack = new ProxyStack(app, `${stageConfig.id}Proxy`, {
      stackName: `${stageConfig.id}Proxy`,
      env: {
        account: resolved.envTarget.account,
        region: resolved.envTarget.region,
      },
      project: config.project,
      application: config.application,
      namePrefix: config.naming.namePrefix,
      ssmPrefix: config.naming.ssmPrefix,
      secretPrefix: config.naming.secretPrefix,
      envTarget: resolved.envTarget,
      networkLookup: resolved.networkLookup,
      proxy: resolved.proxy,
    });

    cdk.Tags.of(stack).add("Project", config.project);
    cdk.Tags.of(stack).add("Application", config.application);
    cdk.Tags.of(stack).add("Environment", resolved.envTarget.name);
  }
})();

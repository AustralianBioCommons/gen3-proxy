#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { loadAppConfig, resolveStageConfig } from "../lib/config/loader";
import { ProxyStack } from "../lib/stacks/proxy-stack";

const app = new cdk.App();

const configPath = app.node.tryGetContext("config");
if (!configPath) {
  throw new Error("Missing CDK context key: config.  Pass -c config=<path-to-proxy.json>");
}

const config = loadAppConfig(configPath);

cdk.Tags.of(app).add("Project", config.project);
cdk.Tags.of(app).add("Application", config.application);

if (config.owner) {
  cdk.Tags.of(app).add("Owner", config.owner);
}

for (const [key, value] of Object.entries(config.tags ?? {})) {
  cdk.Tags.of(app).add(key, value);
}

for (const stageConfig of config.stages) {
  const resolved = resolveStageConfig(config, stageConfig);

  if (!resolved.proxy.enabled) {
    continue;
  }

  const stack = new ProxyStack(app, `${stageConfig.id}Proxy`, {
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

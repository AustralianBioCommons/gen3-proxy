# gen3-proxy

Reusable CDK module that deploys a **Squid forward-proxy fleet** for Gen3 environments.

One proxy EC2 instance is deployed per Availability Zone (in public subnets) and each
instance can optionally be assigned a **fixed Elastic IP** so downstream API allowlists
never need updating after an instance replacement.

## Architecture

```
                ┌───────────────────────────────────────────────────┐
                │  VPC                                               │
                │                                                    │
                │  Public Subnet AZ-a        Public Subnet AZ-b      │
                │  ┌───────────────┐         ┌───────────────┐       │
                │  │  Squid ASG-0  │         │  Squid ASG-1  │       │
                │  │  t3.small     │         │  t3.small     │       │
                │  │  EIP: x.x.x.x │         │  EIP: y.y.y.y │       │
                │  └──────┬────────┘         └──────┬────────┘       │
                │         │ route 0.0.0.0/0         │                │
                │  ┌──────▼────────────────────────▼────────┐       │
                │  │  Private / Isolated Subnets (proxied)   │       │
                │  │  (EKS nodes, RDS, OpenSearch, …)        │       │
                │  └─────────────────────────────────────────┘       │
                └───────────────────────────────────────────────────┘

CloudWatch alarm → SNS → Lambda → route-table failover
```

**Key components:**

| Component | Purpose |
|-----------|---------|
| S3 bucket | Hosts Squid config & whitelist files; refreshed every minute via cron |
| ASG (min/max 1) per AZ | Ensures exactly one proxy per AZ; auto-replaces on failure |
| Elastic IP per AZ | Fixed public IP — survives instance replacement |
| SSM Parameters | EIP public IPs + allocation IDs published at `/ssmPrefix/project/app/env/proxy-eip-{n}` |
| CloudWatch alarm | Detects Squid process death via `procstat_cpu_usage` |
| SNS + Lambda | Reroutes traffic to a healthy AZ proxy and marks unhealthy instance for replacement |

## Repository layout

```
gen3-proxy/
├── bin/
│   └── deploy-proxy.ts          # CDK app entrypoint
├── lib/
│   ├── types.ts                 # All TypeScript interfaces
│   ├── config/
│   │   ├── loader.ts            # Config file loading + defaults
│   │   └── schema.ts            # Validation
│   └── stacks/
│       └── proxy-stack.ts       # Main CDK Stack
├── assets/
│   ├── config_files/            # squid.conf, web_whitelist, …  (sync'd to S3)
│   ├── lambda/                  # Route-table failover Lambda
│   └── user_data/
│       └── squid_user_data.sh   # EC2 bootstrap (EIP allocation + Squid install)
├── config/
│   └── example.public.json      # Example config
├── examples/
│   └── deployment-repo/         # Drop-in files for a caller deployment repo
│       ├── workflows/deploy-proxy.yml
│       └── infra/proxy/proxy.json
└── .github/
    └── workflows/
        └── deploy-proxy-reusable.yml  # Reusable GHA workflow
```

## Caller repo usage

### 1. Add config file

Copy `examples/deployment-repo/infra/proxy/proxy.json` to your deployment repo and
adjust the values:

```json
{
  "project": "bpsyc",
  "application": "gen3",
  "naming": {
    "namePrefix": "bpsyc-gen3",
    "ssmPrefix": "/platform",
    "secretPrefix": "platform"
  },
  "environments": {
    "test": { "name": "test", "account": "__ACCOUNT_ID__", "region": "ap-southeast-2" }
  },
  "stages": [
    {
      "id": "BpsycTestProxy",
      "stageName": "TEST",
      "envKey": "test",
      "networkLookup": {
        "vpcIdParameterName": "/platform/bpsyc/gen3/test/vpc-id",
        "publicSubnetIdsParameterName": "/platform/bpsyc/gen3/test/public-subnet-ids",
        "proxiedSubnetIdsParameterName": "/platform/bpsyc/gen3/test/private-subnet-ids",
        "vpcCidr": "10.144.0.0/20"
      },
      "proxy": {
        "enabled": true,
        "instanceType": "t3.small",
        "allocateEips": true,
        "removalPolicy": "RETAIN"
      }
    }
  ]
}
```

### 2. Add caller workflow

Copy `examples/deployment-repo/workflows/deploy-proxy.yml` to
`.github/workflows/deploy-proxy.yml` in your deployment repo.
Update `role_to_assume` ARNs and optionally the environment names.

### 3. Required SSM parameters (pre-existing)

The following SSM parameters must already exist (created by `gen3-network`):

| Parameter | Value |
|-----------|-------|
| `<ssmPrefix>/<project>/<app>/<env>/vpc-id` | VPC ID |
| `<ssmPrefix>/<project>/<app>/<env>/public-subnet-ids` | Comma-separated public subnet IDs |
| `<ssmPrefix>/<project>/<app>/<env>/private-subnet-ids` | Comma-separated private/isolated subnet IDs |

### 4. Required IAM role permissions

The GitHub Actions OIDC role needs permissions to deploy the stack.  
Minimum additional actions beyond the standard CDK bootstrap role:

```json
"ec2:AllocateAddress",
"ec2:AssociateAddress",
"ec2:DescribeAddresses",
"ec2:ReleaseAddress",
"ec2:ModifyInstanceAttribute",
"ssm:PutParameter",
"ssm:GetParameter"
```

## Elastic IP lifecycle

- On first boot, the user-data script allocates a new EIP and stores its
  **allocation ID** in SSM at `<eipParamPrefix>-<n>-allocation-id`.
- The **public IP** is written to `<eipParamPrefix>-<n>` (plain string).
- On subsequent replacements (instance refresh / ASG scale-in-out), the same
  allocation ID is re-read from SSM and the EIP is re-associated — the public IP
  stays the same.
- EIPs are **not** released on stack destroy; set `removalPolicy: "DESTROY"` and
  manually release them, or add a custom resource if desired.

## Squid config customisation

Edit files in `assets/config_files/` or fork this repo and adjust
`proxy.configFilesPath` in your config to point to your own config directory.
Files are sync'd from S3 every minute.

## Local synth

```bash
cd gen3-proxy
npm ci
npx cdk synth -c config=./config/example.public.json
```

#!/bin/bash -xe
# Redirect user-data output to console logs for CloudWatch / SSM visibility
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

# ---------------------------------------------------------------------------
# All tokens are replaced by the CDK stack (proxy-stack.ts) at synth time
# using plain TypeScript string substitution — no Fn::Sub is used.
#
# Tokens replaced with concrete strings (synth time):
#   __S3BUCKET__      – S3 bucket containing Squid config files
#   __ASG__           – CloudFormation logical ID of this ASG (for cfn-signal)
#   __AZ_INDEX__      – 0-based AZ index (used as EIP SSM suffix)
#   __ENV_NAME__      – environment name (e.g. test, prod)
#   __SSM_PREFIX__    – SSM prefix (e.g. /platform)
#   __PROJECT__       – project name
#   __APPLICATION__   – application name
#   __ALLOCATE_EIPS__ – "true" or "false"
#
# Tokens replaced with CDK token strings (resolved to real values by CFN):
#   __REGION__        – current AWS region  (← this.region CDK token)
#   __STACK_NAME__    – current stack name  (← this.stackName CDK token)
#   __CW_ASG__        – actual ASG name     (← asg.autoScalingGroupName CDK token)
# ---------------------------------------------------------------------------

OVERALL_STATUS=0
trap 'OVERALL_STATUS=1' ERR

REGION="__REGION__"
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)

# ---------------------------------------------------------------------------
# 1. System updates
# ---------------------------------------------------------------------------
yum clean all || true
yum makecache || true
yum update -y --security || true

# ---------------------------------------------------------------------------
# 2. Disable source/dest check so this instance can forward packets (NAT mode)
# ---------------------------------------------------------------------------
aws ec2 modify-instance-attribute \
  --no-source-dest-check \
  --instance-id "$INSTANCE_ID" \
  --region "$REGION" || true

# ---------------------------------------------------------------------------
# 3. Elastic IP allocation and association
# ---------------------------------------------------------------------------
if [ "__ALLOCATE_EIPS__" = "true" ]; then
  echo "Allocating / associating Elastic IP..."

  SSM_EIP_PARAM="__SSM_PREFIX__/__PROJECT__/__APPLICATION__/__ENV_NAME__/proxy-eip-__AZ_INDEX__"

  # Check whether an EIP is already recorded in SSM for this AZ slot
  EXISTING_ALLOC_ID=$(aws ssm get-parameter \
    --name "${SSM_EIP_PARAM}-allocation-id" \
    --query "Parameter.Value" \
    --output text \
    --region "$REGION" 2>/dev/null || true)

  if [ -n "$EXISTING_ALLOC_ID" ] && [ "$EXISTING_ALLOC_ID" != "None" ]; then
    echo "Reusing existing EIP allocation: $EXISTING_ALLOC_ID"
    ALLOC_ID="$EXISTING_ALLOC_ID"
  else
    echo "Allocating new EIP..."
    ALLOC_ID=$(aws ec2 allocate-address \
      --domain vpc \
      --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=__PROJECT__-__APPLICATION__-__ENV_NAME__-proxy-az__AZ_INDEX__},{Key=Project,Value=__PROJECT__},{Key=Application,Value=__APPLICATION__},{Key=Environment,Value=__ENV_NAME__}]" \
      --query "AllocationId" \
      --output text \
      --region "$REGION") || OVERALL_STATUS=1

    if [ -n "$ALLOC_ID" ]; then
      # Persist allocation ID and public IP to SSM
      PUBLIC_IP=$(aws ec2 describe-addresses \
        --allocation-ids "$ALLOC_ID" \
        --query "Addresses[0].PublicIp" \
        --output text \
        --region "$REGION")

      aws ssm put-parameter \
        --name "${SSM_EIP_PARAM}-allocation-id" \
        --value "$ALLOC_ID" \
        --type String \
        --overwrite \
        --region "$REGION" || true

      aws ssm put-parameter \
        --name "${SSM_EIP_PARAM}" \
        --value "$PUBLIC_IP" \
        --type String \
        --overwrite \
        --description "Squid proxy EIP for __PROJECT__/__APPLICATION__/__ENV_NAME__ AZ __AZ_INDEX__" \
        --region "$REGION" || true

      echo "Allocated EIP $PUBLIC_IP ($ALLOC_ID) and stored in SSM at ${SSM_EIP_PARAM}"
    fi
  fi

  # Associate the EIP with this instance (replaces any previous association)
  if [ -n "$ALLOC_ID" ]; then
    aws ec2 associate-address \
      --instance-id "$INSTANCE_ID" \
      --allocation-id "$ALLOC_ID" \
      --allow-reassociation \
      --region "$REGION" || OVERALL_STATUS=1
    echo "Associated EIP $ALLOC_ID with instance $INSTANCE_ID"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Install and configure Squid
# ---------------------------------------------------------------------------
yum install -y squid || OVERALL_STATUS=1
yum update -y squid  || OVERALL_STATUS=1
systemctl enable squid || true
rpm -q squid || true   # record installed version

# NAT / transparent-proxy iptables rules
iptables -t nat -A POSTROUTING -p tcp --dport 636 -j MASQUERADE || true
iptables -t nat -A POSTROUTING -p tcp --dport 22  -j MASQUERADE || true
iptables -t nat -A PREROUTING  -p tcp --dport 80  -j REDIRECT --to-port 3129 || true
iptables -t nat -A PREROUTING  -p tcp --dport 443 -j REDIRECT --to-port 3130 || true

# SSL material for ssl_bump
mkdir -p /etc/squid/ssl
cd /etc/squid/ssl
if [[ ! -s squid.pem ]]; then
  openssl genrsa -out squid.key 4096
  openssl req -new -key squid.key -out squid.csr \
    -subj "/C=AU/ST=VIC/L=Melbourne/O=gen3-proxy/CN=squid"
  openssl x509 -req -days 3650 -in squid.csr -signkey squid.key -out squid.crt
  cat squid.key squid.crt > squid.pem
fi

# ---------------------------------------------------------------------------
# 5. Pull Squid config from S3 and start/reload Squid
# ---------------------------------------------------------------------------
mkdir -p /etc/squid/old
cat > /etc/squid/squid-conf-refresh.sh << 'REFRESH_EOF'
cp -a /etc/squid/* /etc/squid/old/ 2>/dev/null || true
aws s3 sync s3://__S3BUCKET__ /etc/squid
/usr/sbin/squid -k parse && \
  (systemctl is-active --quiet squid \
    && /usr/sbin/squid -k reconfigure \
    || systemctl start squid) \
  || (cp -a /etc/squid/old/* /etc/squid/ 2>/dev/null; exit 1)
REFRESH_EOF
chmod +x /etc/squid/squid-conf-refresh.sh
/etc/squid/squid-conf-refresh.sh || OVERALL_STATUS=1

# Cron: refresh config every minute, rotate logs nightly, patch weekly
cat > ~/mycron << 'CRON_EOF'
* * * * * /etc/squid/squid-conf-refresh.sh
0 0 * * * /usr/sbin/squid -k rotate
0 3 * * 0 sleep $(($RANDOM % 3600)); yum -y update --security
CRON_EOF
crontab ~/mycron
rm -f ~/mycron

# ---------------------------------------------------------------------------
# 6. CloudWatch Agent
# ---------------------------------------------------------------------------
rpm -Uvh "https://amazoncloudwatch-agent-__REGION__.s3.__REGION__.amazonaws.com/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm" || true

cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'CW_EOF'
{
  "agent": { "metrics_collection_interval": 10, "omit_hostname": true },
  "metrics": {
    "metrics_collected": {
      "procstat": [ { "pid_file": "/var/run/squid.pid", "measurement": ["cpu_usage"] } ]
    },
    "append_dimensions": { "AutoScalingGroupName": "__CW_ASG__" },
    "force_flush_interval": 5
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/squid/access.log*",
            "log_group_name": "/gen3-proxy/__PROJECT__-__APPLICATION__-__ENV_NAME__/access",
            "log_stream_name": "{instance_id}",
            "timezone": "Local"
          },
          {
            "file_path": "/var/log/squid/cache.log*",
            "log_group_name": "/gen3-proxy/__PROJECT__-__APPLICATION__-__ENV_NAME__/cache",
            "log_stream_name": "{instance_id}",
            "timezone": "Local"
          }
        ]
      }
    }
  }
}
CW_EOF

/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json \
  -s || true

# ---------------------------------------------------------------------------
# 7. Signal CloudFormation with overall outcome
# ---------------------------------------------------------------------------
yum update -y aws-cfn-bootstrap || true
/opt/aws/bin/cfn-signal -e "$OVERALL_STATUS" \
  --stack "__STACK_NAME__" \
  --resource "__ASG__" \
  --region "$REGION"

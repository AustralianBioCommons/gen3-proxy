#!/bin/bash
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1
set -o pipefail

# ---------------------------------------------------------------------------
# Tokens replaced by proxy-stack.ts at CDK synth time (plain string sub).
# __S3BUCKET__, __ASG__, __ASG_NAME__, __AZ_INDEX__, __ENV_NAME__,
# __SSM_PREFIX__, __PROJECT__, __APPLICATION__, __ALLOCATE_EIPS__,
# __REGION__, __STACK_NAME__
# ---------------------------------------------------------------------------

REGION="__REGION__"
STACK="__STACK_NAME__"
ASG_RESOURCE="__ASG__"
INSTANCE_ID=$(curl -s --retry 3 http://169.254.169.254/latest/meta-data/instance-id)
OVERALL_STATUS=0

# Always signal CloudFormation at exit, even if the script is killed
signal_cfn() {
  local exit_code=${1:-$OVERALL_STATUS}
  echo "Signalling CloudFormation with exit code $exit_code..."
  yum install -y aws-cfn-bootstrap 2>/dev/null || true
  /opt/aws/bin/cfn-signal -e "$exit_code" \
    --stack "$STACK" \
    --resource "$ASG_RESOURCE" \
    --region "$REGION" || true
}
trap 'signal_cfn $OVERALL_STATUS' EXIT

run() {
  # Run a command; on failure set OVERALL_STATUS=1 but continue
  "$@" || { echo "WARN: command failed (non-fatal): $*"; OVERALL_STATUS=1; }
}

run_required() {
  # Run a command; on failure set OVERALL_STATUS=1 and exit (triggers trap)
  "$@" || { echo "ERROR: required command failed: $*"; OVERALL_STATUS=1; exit 1; }
}

# ---------------------------------------------------------------------------
# 1. System updates (non-fatal — don't fail the signal over a patch hiccup)
# ---------------------------------------------------------------------------
yum clean all || true
yum makecache || true
yum update -y --security || true

# ---------------------------------------------------------------------------
# 2. Disable source/dest check (NAT forwarding)
# ---------------------------------------------------------------------------
aws ec2 modify-instance-attribute \
  --no-source-dest-check \
  --instance-id "$INSTANCE_ID" \
  --region "$REGION" || true

# ---------------------------------------------------------------------------
# 3. Install Squid (required — proxy is the point of this instance)
# ---------------------------------------------------------------------------
run_required yum install -y squid
# Update is best-effort; a fresh install may have nothing to update → exit 0
yum update -y squid || true
run systemctl enable squid

# ---------------------------------------------------------------------------
# 4. SSL cert for ssl_bump (must exist before squid -k parse)
# ---------------------------------------------------------------------------
mkdir -p /etc/squid/ssl
if [[ ! -s /etc/squid/ssl/squid.pem ]]; then
  openssl genrsa -out /etc/squid/ssl/squid.key 2048
  openssl req -new -key /etc/squid/ssl/squid.key \
    -out /etc/squid/ssl/squid.csr \
    -subj "/C=AU/ST=VIC/L=Melbourne/O=gen3-proxy/CN=squid"
  openssl x509 -req -days 3650 \
    -in /etc/squid/ssl/squid.csr \
    -signkey /etc/squid/ssl/squid.key \
    -out /etc/squid/ssl/squid.crt
  cat /etc/squid/ssl/squid.key /etc/squid/ssl/squid.crt \
    > /etc/squid/ssl/squid.pem
fi

# ---------------------------------------------------------------------------
# 5. Pull Squid config from S3 and start Squid
# ---------------------------------------------------------------------------
mkdir -p /etc/squid/old

# Write the refresh helper (token substituted by CDK, not a heredoc variable)
cat > /etc/squid/squid-conf-refresh.sh << 'REFRESH_EOF'
#!/bin/bash
set -euo pipefail
cp -a /etc/squid/* /etc/squid/old/ 2>/dev/null || true
aws s3 sync s3://__S3BUCKET__ /etc/squid
if /usr/sbin/squid -k parse; then
  if systemctl is-active --quiet squid; then
    /usr/sbin/squid -k reconfigure
  else
    systemctl start squid
  fi
else
  echo "squid config parse failed — rolling back"
  cp -a /etc/squid/old/* /etc/squid/ 2>/dev/null || true
  exit 1
fi
REFRESH_EOF
chmod +x /etc/squid/squid-conf-refresh.sh
run /etc/squid/squid-conf-refresh.sh

# Verify Squid is actually running before we proceed
sleep 3
if ! systemctl is-active --quiet squid; then
  echo "Squid failed to start — attempting recovery start"
  run systemctl start squid
fi

# ---------------------------------------------------------------------------
# 6. iptables NAT rules
# Set up AFTER Squid starts so cfn-signal (step 9) isn't intercepted.
# ---------------------------------------------------------------------------
iptables -t nat -A POSTROUTING -p tcp --dport 636 -j MASQUERADE || true
iptables -t nat -A POSTROUTING -p tcp --dport 22  -j MASQUERADE || true
iptables -t nat -A PREROUTING  -p tcp --dport 80  -j REDIRECT --to-port 3129 || true
iptables -t nat -A PREROUTING  -p tcp --dport 443 -j REDIRECT --to-port 3130 || true
# Exempt 169.254.169.254 (IMDS) and localhost from redirection
iptables -t nat -I PREROUTING 1 -d 169.254.169.254 -j RETURN || true
iptables -t nat -I PREROUTING 1 -s 127.0.0.1 -j RETURN || true

# ---------------------------------------------------------------------------
# 7. Elastic IP allocation and association
# ---------------------------------------------------------------------------
if [ "__ALLOCATE_EIPS__" = "true" ]; then
  echo "Allocating / associating Elastic IP..."
  SSM_EIP_PARAM="__SSM_PREFIX__/__PROJECT__/__APPLICATION__/__ENV_NAME__/proxy-eip-__AZ_INDEX__"

  EXISTING_ALLOC_ID=$(aws ssm get-parameter \
    --name "${SSM_EIP_PARAM}-allocation-id" \
    --query "Parameter.Value" \
    --output text \
    --region "$REGION" 2>/dev/null || true)

  if [ -n "$EXISTING_ALLOC_ID" ] && [ "$EXISTING_ALLOC_ID" != "None" ]; then
    echo "Reusing existing EIP allocation: $EXISTING_ALLOC_ID"
    ALLOC_ID="$EXISTING_ALLOC_ID"
  else
    ALLOC_ID=$(aws ec2 allocate-address \
      --domain vpc \
      --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=__PROJECT__-__APPLICATION__-__ENV_NAME__-proxy-az__AZ_INDEX__},{Key=Project,Value=__PROJECT__},{Key=Application,Value=__APPLICATION__},{Key=Environment,Value=__ENV_NAME__}]" \
      --query "AllocationId" \
      --output text \
      --region "$REGION" 2>/dev/null || true)

    if [ -n "$ALLOC_ID" ]; then
      PUBLIC_IP=$(aws ec2 describe-addresses \
        --allocation-ids "$ALLOC_ID" \
        --query "Addresses[0].PublicIp" \
        --output text \
        --region "$REGION" 2>/dev/null || true)

      aws ssm put-parameter \
        --name "${SSM_EIP_PARAM}-allocation-id" \
        --value "$ALLOC_ID" \
        --type String --overwrite \
        --region "$REGION" || true

      aws ssm put-parameter \
        --name "${SSM_EIP_PARAM}" \
        --value "${PUBLIC_IP:-unknown}" \
        --type String --overwrite \
        --description "Squid proxy EIP for __PROJECT__/__APPLICATION__/__ENV_NAME__ AZ __AZ_INDEX__" \
        --region "$REGION" || true

      echo "Allocated EIP ${PUBLIC_IP} (${ALLOC_ID})"
    else
      echo "WARN: EIP allocation failed — continuing without fixed IP"
    fi
  fi

  if [ -n "${ALLOC_ID:-}" ]; then
    aws ec2 associate-address \
      --instance-id "$INSTANCE_ID" \
      --allocation-id "$ALLOC_ID" \
      --allow-reassociation \
      --region "$REGION" || true
    echo "Associated $ALLOC_ID with $INSTANCE_ID"
  fi
fi

# ---------------------------------------------------------------------------
# 8. CloudWatch Agent
# ---------------------------------------------------------------------------
rpm -Uvh "https://amazoncloudwatch-agent-__REGION__.s3.__REGION__.amazonaws.com/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm" 2>/dev/null || true

cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'CW_EOF'
{
  "agent": { "metrics_collection_interval": 10, "omit_hostname": true },
  "metrics": {
    "metrics_collected": {
      "procstat": [ { "pid_file": "/var/run/squid.pid", "measurement": ["cpu_usage"] } ]
    },
    "append_dimensions": { "AutoScalingGroupName": "__ASG_NAME__" },
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
# 9. Cron
# ---------------------------------------------------------------------------
crontab - << 'CRON_EOF'
* * * * * /etc/squid/squid-conf-refresh.sh
0 0 * * * /usr/sbin/squid -k rotate
0 3 * * 0 sleep $((RANDOM % 3600)); yum -y update --security
CRON_EOF

# ---------------------------------------------------------------------------
# Signal CloudFormation — called via EXIT trap with $OVERALL_STATUS
# (also called explicitly here so the exit code is visible in the log)
# ---------------------------------------------------------------------------
echo "Bootstrap complete. OVERALL_STATUS=$OVERALL_STATUS"

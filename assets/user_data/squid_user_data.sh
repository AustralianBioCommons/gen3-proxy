#!/bin/bash -xe

# Redirect user-data output
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

OVERALL_STATUS=0

# Always signal CloudFormation on exit, regardless of how the script ends.
# This ensures CFN never times out waiting for a signal.
signal_cfn() {
  /opt/aws/bin/cfn-signal \
    -e "$OVERALL_STATUS" \
    --stack __STACK_NAME__ \
    --resource __ASG__ \
    --region __REGION__ || true
}
trap 'OVERALL_STATUS=$?; signal_cfn' EXIT

###############################################################################
# System updates
###############################################################################

yum clean all || true
yum makecache || true
yum update -y --security || true

###############################################################################
# Disable Source/Dest Check
###############################################################################

# Retry IMDS call — metadata service may not be ready immediately at boot
for i in 1 2 3 4 5; do
  INSTANCE_ID=$(curl -fsS http://169.254.169.254/latest/meta-data/instance-id) && break
  echo "IMDS not ready, retry $i/5..."
  sleep 3
done

aws ec2 modify-instance-attribute \
  --instance-id "$INSTANCE_ID" \
  --no-source-dest-check \
  --region __REGION__ || true

###############################################################################
# Elastic IP
###############################################################################

SSM_EIP_PARAM="__SSM_EIP_PARAM__"

EXISTING_ALLOC_ID=$(aws ssm get-parameter \
  --name "${SSM_EIP_PARAM}-allocation-id" \
  --query "Parameter.Value" \
  --output text \
  --region __REGION__ 2>/dev/null || true)

if [ -n "$EXISTING_ALLOC_ID" ] && [ "$EXISTING_ALLOC_ID" != "None" ]; then
  echo "Reusing existing EIP: $EXISTING_ALLOC_ID"
  ALLOC_ID="$EXISTING_ALLOC_ID"
else
  echo "Allocating new EIP..."
  # NOTE: --tag-specifications is not supported by the AWS CLI v1 bundled
  # with Amazon Linux 2, so we allocate first and tag afterwards.
  ALLOC_ID=$(aws ec2 allocate-address \
    --domain vpc \
    --query "AllocationId" \
    --output text \
    --region __REGION__ 2>/dev/null || true)

  if [ -n "$ALLOC_ID" ] && [ "$ALLOC_ID" != "None" ]; then
    # Copy this instance's tags onto the EIP (ASG propagates tags to
    # instances, so the instance is the source of truth). aws:-prefixed
    # tags are reserved and must be filtered out or create-tags rejects
    # the entire call.
    aws ec2 describe-tags \
      --filters "Name=resource-id,Values=$INSTANCE_ID" \
      --query "Tags[?!starts_with(Key, 'aws:')].{Key:Key,Value:Value}" \
      --output json \
      --region __REGION__ > /tmp/instance-tags.json || echo '[]' > /tmp/instance-tags.json

    if [ -s /tmp/instance-tags.json ] && [ "$(cat /tmp/instance-tags.json)" != "[]" ]; then
      aws ec2 create-tags \
        --resources "$ALLOC_ID" \
        --tags file:///tmp/instance-tags.json \
        --region __REGION__ || true
    fi

    # Give the EIP its own distinct Name (overrides the copied instance Name)
    aws ec2 create-tags \
      --resources "$ALLOC_ID" \
      --tags Key=Name,Value=__ASG_NAME__ \
      --region __REGION__ || true

    rm -f /tmp/instance-tags.json

    PUBLIC_IP=$(aws ec2 describe-addresses \
      --allocation-ids "$ALLOC_ID" \
      --query "Addresses[0].PublicIp" \
      --output text \
      --region __REGION__)

    aws ssm put-parameter \
      --name "${SSM_EIP_PARAM}-allocation-id" \
      --value "$ALLOC_ID" \
      --type String --overwrite \
      --region __REGION__ || true

    aws ssm put-parameter \
      --name "${SSM_EIP_PARAM}" \
      --value "$PUBLIC_IP" \
      --type String --overwrite \
      --description "Proxy EIP for __ASG_NAME__" \
      --region __REGION__ || true

    echo "Allocated EIP $PUBLIC_IP ($ALLOC_ID)"
  else
    echo "WARNING: EIP allocation failed; continuing without EIP"
    ALLOC_ID=""
  fi
fi

if [ -n "${ALLOC_ID:-}" ] && [ "$ALLOC_ID" != "None" ]; then
  aws ec2 associate-address \
    --instance-id "$INSTANCE_ID" \
    --allocation-id "$ALLOC_ID" \
    --allow-reassociation \
    --region __REGION__ || true
  echo "Associated $ALLOC_ID with $INSTANCE_ID"
fi

###############################################################################
# Squid
###############################################################################

yum install -y squid || OVERALL_STATUS=1
yum update -y squid || OVERALL_STATUS=1

systemctl enable squid || true
systemctl restart squid || systemctl start squid || OVERALL_STATUS=1

rpm -q squid || true

###############################################################################
# NAT rules
###############################################################################

iptables -t nat -A POSTROUTING -p tcp --dport 636 -j MASQUERADE || true
iptables -t nat -A POSTROUTING -p tcp --dport 22  -j MASQUERADE || true
iptables -t nat -A PREROUTING  -p tcp --dport 80  -j REDIRECT --to-port 3129 || true
iptables -t nat -A PREROUTING  -p tcp --dport 443 -j REDIRECT --to-port 3130 || true

###############################################################################
# SSL certificate
###############################################################################

mkdir -p /etc/squid/ssl
cd /etc/squid/ssl

if [[ ! -f squid.pem ]]; then
    openssl genrsa -out squid.key 4096
    openssl req \
        -new \
        -key squid.key \
        -out squid.csr \
        -subj "/C=XX/ST=XX/L=squid/O=squid/CN=squid"

    openssl x509 \
        -req \
        -days 3650 \
        -in squid.csr \
        -signkey squid.key \
        -out squid.crt

    cat squid.key squid.crt > squid.pem
fi

###############################################################################
# Refresh Squid config from S3
###############################################################################

mkdir -p /etc/squid/old

cat >/etc/squid/squid-conf-refresh.sh <<'EOF'
#!/bin/bash
set -e

cp -a /etc/squid/* /etc/squid/old/ 2>/dev/null || true

aws s3 sync s3://__S3BUCKET__ /etc/squid

/usr/sbin/squid -k parse
/usr/sbin/squid -k reconfigure
EOF

chmod +x /etc/squid/squid-conf-refresh.sh

/etc/squid/squid-conf-refresh.sh || OVERALL_STATUS=1

###############################################################################
# Cron jobs
###############################################################################

cat >/tmp/mycron <<'EOF'
* * * * * /etc/squid/squid-conf-refresh.sh
0 0 * * * sleep $(($RANDOM % 3600)); yum -y update --security
0 0 * * * /usr/sbin/squid -k rotate
EOF

crontab /tmp/mycron
rm -f /tmp/mycron

###############################################################################
# CloudWatch Agent
###############################################################################

rpm -Uvh \
https://amazoncloudwatch-agent-__REGION__.s3.__REGION__.amazonaws.com/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm \
|| true

cat >/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'EOF'
{
  "agent": {
    "metrics_collection_interval": 10,
    "omit_hostname": true
  },
  "metrics": {
    "append_dimensions": {
      "AutoScalingGroupName": "${aws:AutoScalingGroupName}"
    },
    "aggregation_dimensions": [
      ["AutoScalingGroupName"]
    ],
    "metrics_collected": {
      "procstat": [
        {
          "pid_file": "/var/run/squid.pid",
          "measurement": ["cpu_usage"]
        }
      ]
    },
    "force_flush_interval": 5
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/squid/access.log*",
            "log_group_name": "/filtering-squid-instance/access.log",
            "log_stream_name": "{instance_id}",
            "timezone": "Local"
          },
          {
            "file_path": "/var/log/squid/cache.log*",
            "log_group_name": "/filtering-squid-instance/cache.log",
            "log_stream_name": "{instance_id}",
            "timezone": "Local"
          }
        ]
      }
    }
  }
}
EOF

/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json \
  -s || true

###############################################################################
# Done — cfn-signal fires via EXIT trap above
###############################################################################

echo "Bootstrap complete. OVERALL_STATUS=$OVERALL_STATUS"
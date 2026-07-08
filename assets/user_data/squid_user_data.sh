# NOTE: no shebang here — asg.addUserData() appends this file under CDK's own
# '#!/bin/bash' header.
set -xe

exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

OVERALL_STATUS=0

dnf install -y aws-cfn-bootstrap

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

dnf clean all || true
dnf makecache || true
dnf upgrade -y --releasever=latest --security || true

###############################################################################
# Base packages
###############################################################################

dnf install -y cronie iptables-nft squid amazon-cloudwatch-agent || OVERALL_STATUS=1
systemctl enable --now crond || OVERALL_STATUS=1

###############################################################################
# IMDS / instance id
###############################################################################

get_imds_token() {
  curl -fsS -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300"
}

for i in 1 2 3 4 5; do
  TOKEN=$(get_imds_token) \
    && INSTANCE_ID=$(curl -fsS \
         -H "X-aws-ec2-metadata-token: $TOKEN" \
         http://169.254.169.254/latest/meta-data/instance-id) \
    && break
  echo "IMDS not ready, retry $i/5..."
  sleep 3
done

if [ -z "${INSTANCE_ID:-}" ]; then
  echo "ERROR: failed to resolve INSTANCE_ID"
  OVERALL_STATUS=1
fi

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

  ALLOC_ID=$(aws ec2 allocate-address \
    --domain vpc \
    --query "AllocationId" \
    --output text \
    --region __REGION__) || OVERALL_STATUS=1

  if [ -n "${ALLOC_ID:-}" ] && [ "$ALLOC_ID" != "None" ]; then
    aws ec2 describe-tags \
      --filters "Name=resource-id,Values=$INSTANCE_ID" \
      --query "Tags[?!starts_with(Key, 'aws:')].{Key:Key,Value:Value}" \
      --output json \
      --region __REGION__ > /tmp/instance-tags.json || echo '[]' > /tmp/instance-tags.json

    if [ -s /tmp/instance-tags.json ] && [ "$(cat /tmp/instance-tags.json)" != "[]" ]; then
      aws ec2 create-tags \
        --resources "$ALLOC_ID" \
        --tags file:///tmp/instance-tags.json \
        --region __REGION__ || OVERALL_STATUS=1
    fi

    aws ec2 create-tags \
      --resources "$ALLOC_ID" \
      --tags Key=Name,Value=__ASG_NAME__ \
      --region __REGION__ || OVERALL_STATUS=1

    rm -f /tmp/instance-tags.json

    PUBLIC_IP=$(aws ec2 describe-addresses \
      --allocation-ids "$ALLOC_ID" \
      --query "Addresses[0].PublicIp" \
      --output text \
      --region __REGION__) || OVERALL_STATUS=1

    aws ssm put-parameter \
      --name "${SSM_EIP_PARAM}-allocation-id" \
      --value "$ALLOC_ID" \
      --type String \
      --overwrite \
      --region __REGION__ || OVERALL_STATUS=1

    aws ssm put-parameter \
      --name "${SSM_EIP_PARAM}" \
      --value "$PUBLIC_IP" \
      --type String \
      --overwrite \
      --description "Proxy EIP for __ASG_NAME__" \
      --region __REGION__ || OVERALL_STATUS=1

    echo "Allocated EIP $PUBLIC_IP ($ALLOC_ID)"
  fi
fi

if [ -n "${ALLOC_ID:-}" ] && [ "$ALLOC_ID" != "None" ]; then
  aws ec2 associate-address \
    --instance-id "$INSTANCE_ID" \
    --allocation-id "$ALLOC_ID" \
    --allow-reassociation \
    --region __REGION__ || OVERALL_STATUS=1

  echo "Associated $ALLOC_ID with $INSTANCE_ID"
else
  echo "WARNING: no EIP allocation id available"
fi

###############################################################################
# SSL certificate for Squid ssl-bump
###############################################################################

mkdir -p /etc/squid/ssl
cd /etc/squid/ssl

if [ ! -f squid.pem ]; then
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

chown -R squid:squid /etc/squid/ssl
chmod 600 /etc/squid/ssl/squid.key /etc/squid/ssl/squid.pem || true

###############################################################################
# Squid SSL certificate database for ssl-bump
###############################################################################

CERTGEN="$(command -v security_file_certgen 2>/dev/null || true)"

if [ -z "$CERTGEN" ]; then
  CERTGEN="$(find /usr/libexec /usr/lib64 /usr/lib -name security_file_certgen -type f 2>/dev/null | head -n 1 || true)"
fi

if [ -n "$CERTGEN" ]; then
  rm -rf /var/spool/squid/ssl_db
  mkdir -p /var/spool/squid

  "$CERTGEN" \
    -c \
    -s /var/spool/squid/ssl_db \
    -M 4MB

  chown -R squid:squid /var/spool/squid
else
  echo "ERROR: security_file_certgen not found"
  OVERALL_STATUS=1
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

if systemctl is-active --quiet squid; then
  /usr/sbin/squid -k reconfigure
fi
EOF

chmod +x /etc/squid/squid-conf-refresh.sh

/etc/squid/squid-conf-refresh.sh || OVERALL_STATUS=1

###############################################################################
# Start Squid only after cert, ssl_db, and config are ready
###############################################################################

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
# Cron jobs
###############################################################################

cat >/tmp/mycron <<'EOF'
* * * * * /etc/squid/squid-conf-refresh.sh
0 0 * * * sleep $(($RANDOM % 3600)); dnf -y upgrade --releasever=latest --security
0 0 * * * /usr/sbin/squid -k rotate
EOF

crontab /tmp/mycron
rm -f /tmp/mycron

###############################################################################
# CloudWatch Agent
###############################################################################

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
          "exe": "squid",
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

echo "Bootstrap complete. OVERALL_STATUS=$OVERALL_STATUS"
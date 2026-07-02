#!/bin/bash -xe

# Redirect user-data output
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

OVERALL_STATUS=0
trap 'OVERALL_STATUS=1' ERR

###############################################################################
# System updates
###############################################################################

yum clean all || true
yum makecache || true
yum update -y --security || true

###############################################################################
# Disable Source/Dest Check
###############################################################################

INSTANCE_ID=$(curl -fsS http://169.254.169.254/latest/meta-data/instance-id)

aws ec2 modify-instance-attribute \
  --instance-id "$INSTANCE_ID" \
  --no-source-dest-check \
  --region __REGION__ || true

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
    "metrics_collected": {
      "procstat": [
        {
          "pid_file": "/var/run/squid.pid",
          "measurement": [
            "cpu_usage"
          ]
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
# CloudFormation signal
###############################################################################

yum update -y aws-cfn-bootstrap || true

/opt/aws/bin/cfn-signal \
  -e "$OVERALL_STATUS" \
  --stack __STACK_NAME__ \
  --resource __ASG__ \
  --region __REGION__
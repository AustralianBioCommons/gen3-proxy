#!/bin/bash -xe
# Redirect the user-data output to the console logs
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
# Apply the latest security patches
# This script is intended to be run on an AWS EC2 instance as part of the user data
# It updates the system, installs Squid, configures NAT rules, sets up SSL for Squid,
# refreshes the Squid configuration from an S3 bucket, sets up cron jobs for maintenance,
# and configures the CloudWatch Agent for monitoring.
OVERALL_STATUS=0
trap 'OVERALL_STATUS=1' ERR
# Freshen metadata & security patches (non-fatal)
yum clean all || true
yum makecache || true
yum update -y --security || true
# Networking attribute (non-fatal if already set)
instanceid=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
aws ec2 modify-instance-attribute --no-source-dest-check --instance-id "$instanceid" --region __REGION__ || true
# ---- Squid: install first, then update to patched build ----
yum install -y squid || OVERALL_STATUS=1
yum update  -y squid || OVERALL_STATUS=1
systemctl enable squid || true
systemctl restart squid || systemctl start squid || OVERALL_STATUS=1
rpm -q squid || true     # record final version in logs
# NAT rules (non-fatal if duplicates)
iptables -t nat -A POSTROUTING -p tcp --dport 636 -j MASQUERADE || true
iptables -t nat -A POSTROUTING -p tcp --dport 22  -j MASQUERADE || true
iptables -t nat -A PREROUTING -p tcp --dport 80  -j REDIRECT --to-port 3129 || true
iptables -t nat -A PREROUTING -p tcp --dport 443 -j REDIRECT --to-port 3130 || true
# SSL material for ssl_bump (idempotent)
mkdir -p /etc/squid/ssl
cd /etc/squid/ssl
if [[ ! -s squid.pem ]]; then
  openssl genrsa -out squid.key 4096
  openssl req -new -key squid.key -out squid.csr -subj "/C=XX/ST=XX/L=squid/O=squid/CN=squid"
  openssl x509 -req -days 3650 -in squid.csr -signkey squid.key -out squid.crt
  cat squid.key squid.crt > squid.pem
fi
# Pull config from S3 and (re)load Squid
mkdir -p /etc/squid/old
cat > /etc/squid/squid-conf-refresh.sh << 'EOF'
cp -a /etc/squid/* /etc/squid/old/ 2>/dev/null || true
aws s3 sync s3://"${__S3BUCKET__}" /etc/squid
/usr/sbin/squid -k parse && /usr/sbin/squid -k reconfigure || (cp -a /etc/squid/old/* /etc/squid/ 2>/dev/null; exit 1)
EOF
chmod +x /etc/squid/squid-conf-refresh.sh
/etc/squid/squid-conf-refresh.sh || OVERALL_STATUS=1
# Cron housekeeping
cat > ~/mycron << 'EOF'
* * * * * /etc/squid/squid-conf-refresh.sh
0 0 * * * sleep $(($RANDOM % 3600)); yum -y update --security
0 0 * * * /usr/sbin/squid -k rotate
EOF
crontab ~/mycron
rm -f ~/mycron
# CloudWatch Agent (non-fatal if mirror hiccups)
rpm -Uvh https://amazoncloudwatch-agent-__REGION__.s3.__REGION__.amazonaws.com/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm || true
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'EOF'
{
  "agent": { "metrics_collection_interval": 10, "omit_hostname": true },
  "metrics": {
    "metrics_collected": { "procstat": [ { "pid_file": "/var/run/squid.pid", "measurement": ["cpu_usage"] } ] },
    "append_dimensions": { "AutoScalingGroupName": "${__CW_ASG__}" },
    "force_flush_interval": 5
  },
  "logs": {
    "logs_collected": { "files": { "collect_list": [
      { "file_path": "/var/log/squid/access.log*", "log_group_name": "/filtering-squid-instance/access.log", "log_stream_name": "{instance_id}", "timezone": "Local" },
      { "file_path": "/var/log/squid/cache.log*",  "log_group_name": "/filtering-squid-instance/cache.log",  "log_stream_name": "{instance_id}", "timezone": "Local" }
    ] } }
  }
}
EOF
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s || true
# Always signal CloudFormation with overall status (0=success, 1=failure)
yum update -y aws-cfn-bootstrap || true
/opt/aws/bin/cfn-signal -e "$OVERALL_STATUS" --stack __STACK_NAME__ --resource "${__ASG__}" --region __REGION__

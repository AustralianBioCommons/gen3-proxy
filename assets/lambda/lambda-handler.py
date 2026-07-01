import json
import boto3
import os
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

as_client = boto3.client('autoscaling')
cw_client = boto3.client('cloudwatch')
ec2_client = boto3.client('ec2')
ssm_client = boto3.client('ssm')

# Alarm names are: squid-alarm_<full-asg-name>
# The ASG name itself may contain underscores, so split on the FIRST _ only.
ALARM_PREFIX = 'squid-alarm_'

def asg_name_from_alarm(alarm_name):
    """Extract ASG name from alarm name by stripping the fixed prefix."""
    if alarm_name.startswith(ALARM_PREFIX):
        return alarm_name[len(ALARM_PREFIX):]
    # Fallback: split on first underscore (original behaviour)
    return alarm_name.split('_', 1)[-1]

def get_asg(asg_name):
    """Return the ASG dict, or None if not found / no instances."""
    resp = as_client.describe_auto_scaling_groups(
        AutoScalingGroupNames=[asg_name]
    )
    groups = resp.get('AutoScalingGroups', [])
    if not groups:
        logger.warning('ASG not found: %s', asg_name)
        return None
    return groups[0]

def get_route_table_ids_for_asg(asg_name):
    """
    Return the list of route table IDs that should point to this AZ's proxy.

    We tag the ASG with ProxiedSubnetIdsParam = SSM param name containing
    a comma-separated list of subnet IDs. We resolve subnet → route table
    at runtime via ec2:DescribeSubnets, which avoids hard-coding route table
    IDs in the CDK stack (they change if the VPC is recreated).
    """
    # Get the SSM param name from the ASG tag
    tags_resp = as_client.describe_tags(
        Filters=[
            {'Name': 'auto-scaling-group', 'Values': [asg_name]},
            {'Name': 'key', 'Values': ['ProxiedSubnetIdsParam']},
        ]
    )
    tags = tags_resp.get('Tags', [])
    if not tags:
        logger.warning('No ProxiedSubnetIdsParam tag on ASG %s', asg_name)
        return []

    ssm_param_name = tags[0]['Value']
    logger.info('SSM param for proxied subnets: %s', ssm_param_name)

    try:
        param_resp = ssm_client.get_parameter(Name=ssm_param_name)
        subnet_ids = [s.strip() for s in param_resp['Parameter']['Value'].split(',') if s.strip()]
    except Exception as e:
        logger.error('Failed to read SSM param %s: %s', ssm_param_name, e)
        return []

    if not subnet_ids:
        return []

    # Resolve subnet IDs → route table IDs
    rt_resp = ec2_client.describe_route_tables(
        Filters=[{'Name': 'association.subnet-id', 'Values': subnet_ids}]
    )
    route_table_ids = [rt['RouteTableId'] for rt in rt_resp.get('RouteTables', [])]
    logger.info('Route tables for ASG %s: %s', asg_name, route_table_ids)
    return route_table_ids

def update_route(route_table_id, instance_id, asg_name):
    """Point 0.0.0.0/0 on the given route table at instance_id."""
    params = {
        'DestinationCidrBlock': '0.0.0.0/0',
        'RouteTableId': route_table_id,
        'InstanceId': instance_id,
    }
    try:
        ec2_client.replace_route(**params)
    except ec2_client.exceptions.ClientError:
        ec2_client.create_route(**params)
    # Tag the route table so we know which ASG owns this route
    ec2_client.create_tags(
        Resources=[route_table_id],
        Tags=[{'Key': 'AutoScalingGroupName', 'Value': asg_name}]
    )
    logger.info('Updated default route of %s → instance %s (ASG %s)',
                route_table_id, instance_id, asg_name)

def handler(event, context):
    logger.info(json.dumps(event))
    for record in event['Records']:
        message = json.loads(record['Sns']['Message'])
        alarm_name = message['AlarmName']
        new_state = message['NewStateValue']
        logger.info('Alarm %s → %s', alarm_name, new_state)

        asg_name = asg_name_from_alarm(alarm_name)
        logger.info('ASG name: %s', asg_name)

        asg = get_asg(asg_name)
        if asg is None:
            logger.error('Skipping — ASG %s not found', asg_name)
            continue

        if new_state == 'ALARM':
            # ----------------------------------------------------------------
            # Proxy instance has failed (or no metrics yet on first boot).
            # Mark it unhealthy so ASG replaces it, then redirect traffic to
            # any currently-healthy proxy in another AZ.
            # ----------------------------------------------------------------

            # Mark current instances unhealthy
            for instance in asg.get('Instances', []):
                try:
                    as_client.set_instance_health(
                        InstanceId=instance['InstanceId'],
                        HealthStatus='Unhealthy'
                    )
                    logger.info('Marked %s Unhealthy', instance['InstanceId'])
                except Exception as e:
                    logger.warning('Could not mark %s unhealthy: %s',
                                   instance['InstanceId'], e)

            # Find a healthy proxy in another AZ
            topic_arn = os.environ.get('TOPIC_ARN', '')
            healthy_alarms = cw_client.describe_alarms(
                AlarmNamePrefix=ALARM_PREFIX,
                ActionPrefix=topic_arn,
                StateValue='OK'
            ).get('MetricAlarms', [])

            for healthy_alarm in healthy_alarms:
                healthy_asg_name = asg_name_from_alarm(healthy_alarm['AlarmName'])
                if healthy_asg_name == asg_name:
                    continue  # skip self

                healthy_asg = get_asg(healthy_asg_name)
                if not healthy_asg:
                    continue

                healthy_instances = [
                    i for i in healthy_asg.get('Instances', [])
                    if i.get('HealthStatus') == 'Healthy'
                ]
                if not healthy_instances:
                    logger.warning('Healthy alarm but no healthy instances in %s',
                                   healthy_asg_name)
                    continue

                healthy_instance_id = healthy_instances[0]['InstanceId']
                logger.info('Routing via healthy instance %s in %s',
                            healthy_instance_id, healthy_asg_name)

                for rt_id in get_route_table_ids_for_asg(asg_name):
                    update_route(rt_id, healthy_instance_id, healthy_asg_name)
                break
            else:
                logger.warning('No healthy proxy found in any other AZ — '
                               'traffic may be disrupted until replacement completes')

        else:
            # ----------------------------------------------------------------
            # Proxy has recovered (OK state after replacement or restart).
            # Complete any pending lifecycle action and restore routes.
            # ----------------------------------------------------------------
            healthy_instances = [
                i for i in asg.get('Instances', [])
                if i.get('HealthStatus') == 'Healthy'
            ]
            if not healthy_instances:
                logger.warning('OK alarm but no healthy instances in %s — '
                               'instance may still be starting', asg_name)
                continue

            asg_instance_id = healthy_instances[0]['InstanceId']
            logger.info('Recovered instance: %s', asg_instance_id)

            # Complete any pending lifecycle hook (instance may have just launched)
            try:
                hooks = as_client.describe_lifecycle_hooks(
                    AutoScalingGroupName=asg_name
                ).get('LifecycleHooks', [])
                if hooks:
                    as_client.complete_lifecycle_action(
                        LifecycleHookName=hooks[0]['LifecycleHookName'],
                        AutoScalingGroupName=asg_name,
                        LifecycleActionResult='CONTINUE',
                        InstanceId=asg_instance_id
                    )
                    logger.info('Lifecycle action completed for %s', asg_instance_id)
            except Exception as e:
                logger.info('Lifecycle complete skipped (may already be done): %s', e)

            # Restore this AZ's route tables to point at the recovered instance
            for rt_id in get_route_table_ids_for_asg(asg_name):
                update_route(rt_id, asg_instance_id, asg_name)

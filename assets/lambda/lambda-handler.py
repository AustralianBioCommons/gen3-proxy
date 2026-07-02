import json
import boto3
import os
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

as_client = boto3.client('autoscaling')
cw_client = boto3.client('cloudwatch')
ec2_client = boto3.client('ec2')

ALARM_PREFIX = 'squid-alarm_'

def asg_name_from_alarm(alarm_name):
    if alarm_name.startswith(ALARM_PREFIX):
        return alarm_name[len(ALARM_PREFIX):]
    raise ValueError('Unexpected alarm name format: %s' % alarm_name)

def get_asg(asg_name):
    resp = as_client.describe_auto_scaling_groups(AutoScalingGroupNames=[asg_name])
    groups = resp.get('AutoScalingGroups', [])
    if not groups:
        logger.warning('ASG not found: %s', asg_name)
        return None
    return groups[0]

def update_route(route_table_id, instance_id, asg_name):
    params = {'DestinationCidrBlock': '0.0.0.0/0', 'RouteTableId': route_table_id, 'InstanceId': instance_id}
    try:
        ec2_client.replace_route(**params)
    except Exception:
        ec2_client.create_route(**params)
    ec2_client.create_tags(
        Resources=[route_table_id],
        Tags=[{'Key': 'AutoScalingGroupName', 'Value': asg_name}]
    )
    logger.info('Updated default route of %s → %s (ASG %s)', route_table_id, instance_id, asg_name)

def get_route_table_ids(asg_name):
    tags = as_client.describe_tags(
        Filters=[
            {'Name': 'auto-scaling-group', 'Values': [asg_name]},
            {'Name': 'key', 'Values': ['RouteTableIds']},
        ]
    ).get('Tags', [])
    if not tags:
        logger.error('No RouteTableIds tag on ASG %s', asg_name)
        return []
    return [rt.strip() for rt in tags[0]['Value'].split(',') if rt.strip()]

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
            continue

        if new_state == 'ALARM':
            # Mark instances unhealthy so ASG replaces them
            for instance in asg.get('Instances', []):
                try:
                    as_client.set_instance_health(
                        InstanceId=instance['InstanceId'],
                        HealthStatus='Unhealthy'
                    )
                    logger.info('Marked %s Unhealthy', instance['InstanceId'])
                except Exception as e:
                    logger.warning('Could not mark %s unhealthy: %s', instance['InstanceId'], e)

            # Find a healthy proxy in another AZ and redirect traffic to it
            topic_arn = os.environ.get('TOPIC_ARN', '')
            healthy_alarms = cw_client.describe_alarms(
                AlarmNamePrefix=ALARM_PREFIX,
                ActionPrefix=topic_arn,
                StateValue='OK'
            ).get('MetricAlarms', [])

            for healthy_alarm in healthy_alarms:
                healthy_asg_name = asg_name_from_alarm(healthy_alarm['AlarmName'])
                if healthy_asg_name == asg_name:
                    continue
                healthy_asg = get_asg(healthy_asg_name)
                if not healthy_asg:
                    continue
                healthy_instances = [
                    i for i in healthy_asg.get('Instances', [])
                    if i.get('HealthStatus') == 'Healthy'
                ]
                if not healthy_instances:
                    continue
                healthy_instance_id = healthy_instances[0]['InstanceId']
                logger.info('Rerouting via %s in %s', healthy_instance_id, healthy_asg_name)
                # Find route tables currently tagged as belonging to the failed ASG
                for rt in ec2_client.describe_route_tables(
                    Filters=[{'Name': 'tag:AutoScalingGroupName', 'Values': [asg_name]}]
                ).get('RouteTables', []):
                    update_route(rt['RouteTableId'], healthy_instance_id, healthy_asg_name)
                break
            else:
                logger.warning('No healthy proxy found — traffic may be disrupted')

        else:
            # Proxy recovered — complete lifecycle hook and restore routes
            healthy_instances = [
                i for i in asg.get('Instances', [])
                if i.get('HealthStatus') == 'Healthy'
            ]
            if not healthy_instances:
                logger.warning('OK state but no healthy instances in %s yet', asg_name)
                continue

            asg_instance_id = healthy_instances[0]['InstanceId']
            logger.info('Recovered instance: %s', asg_instance_id)

            # Complete any pending lifecycle hook
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
                logger.info('Lifecycle complete skipped: %s', e)

            # Restore route tables from RouteTableIds ASG tag (set at synth time)
            for rt_id in get_route_table_ids(asg_name):
                update_route(rt_id, asg_instance_id, asg_name)

# dogshell 常用命令与查询样例

> `datadog` 技能的伴随文件。**先看主文件**的 Setup（`DATADOG_API_KEY` / `DATADOG_APP_KEY`）。

## Query Metrics

```bash
# Query metric data (last hour)
dog metric query --query "avg:system.cpu.user{*}" --start $(date -v-1H +%s) --end $(date +%s)

# Query with specific host filter
dog metric query --query "avg:system.memory.used{host:myserver}" --start $(date -v-1H +%s) --end $(date +%s)

# Query multiple metrics
dog metric query --query "avg:system.cpu.user{*},avg:system.cpu.system{*}" --start $(date -v-1H +%s) --end $(date +%s)
```

## Post Metrics

```bash
# Post a single metric
dog metric post my.custom.metric 42 --host myserver --tags env:prod,service:api

# Post metric with timestamp
dog metric post my.custom.metric 42 --timestamp $(date +%s)
```

## Events

```bash
# Post an event
dog event post "Deployment Complete" "Deployed version 1.2.3 to production" --tags env:prod,service:api

# Post event with priority
dog event post "Alert" "High memory usage detected" --priority normal --alert_type warning

# Query events (last 24 hours)
dog event query --start $(date -v-1d +%s) --end $(date +%s)

# Query events with tags
dog event query --start $(date -v-1d +%s) --end $(date +%s) --tags env:prod
```

## Monitors

```bash
# List all monitors
dog monitor list

# Get specific monitor
dog monitor show <monitor_id>

# Mute a monitor
dog monitor mute <monitor_id>

# Unmute a monitor
dog monitor unmute <monitor_id>

# Mute all monitors
dog monitor mute_all

# Create a metric monitor
dog monitor create "metric alert" "My Monitor" "avg(last_5m):avg:system.cpu.user{*} > 80" --message "CPU usage is high @slack-alerts"
```

## Service Checks

```bash
# Post a service check
dog service_check post my.service.check 0 --host myserver --tags env:prod
# Status: 0=OK, 1=WARNING, 2=CRITICAL, 3=UNKNOWN

# Post check with message
dog service_check post my.health.check 0 --message "All systems operational"
```

## Dashboards

```bash
# List all dashboards
dog dashboard list

# Get dashboard details
dog dashboard show <dashboard_id>
```

## Hosts

```bash
# Search hosts
dog host search --query "host:web*"

# Mute a host
dog host mute <hostname>

# Unmute a host
dog host unmute <hostname>
```

## Tags

```bash
# Get tags for a host
dog tag show <hostname>

# Add tags to a host
dog tag add <hostname> env:prod role:web

# Update tags for a host (replaces existing)
dog tag update <hostname> env:staging role:api

# Remove all tags from a host
dog tag detach <hostname>
```

## Downtimes

```bash
# Schedule a downtime
dog downtime schedule --scope "host:myserver" --start $(date +%s) --end $(date -v+1H +%s) --message "Maintenance window"

# List active downtimes
dog downtime list

# Cancel a downtime
dog downtime cancel <downtime_id>
```

## Useful Queries

### System Metrics

```bash
# CPU usage
dog metric query --query "avg:system.cpu.user{*} by {host}"

# Memory usage
dog metric query --query "avg:system.mem.used{*}/avg:system.mem.total{*}*100"

# Disk usage
dog metric query --query "avg:system.disk.in_use{*} by {device}"
```

### Application Metrics

```bash
# Request rate
dog metric query --query "sum:trace.http.request.hits{service:my-app}.as_rate()"

# Error rate
dog metric query --query "sum:trace.http.request.errors{service:my-app}/sum:trace.http.request.hits{service:my-app}*100"

# Latency (p95)
dog metric query --query "p95:trace.http.request.duration{service:my-app}"
```

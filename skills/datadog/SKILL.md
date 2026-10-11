---
name: datadog
description: Query metrics, manage monitors, post events, and interact with Datadog via the dogshell CLI.
metadata:
  displayName: Datadog
  icon: activity
  category: monitoring
  version: 1.1.0
---

# dogshell (Datadog CLI)

Use `dog` to interact with Datadog for metrics, monitors, events, dashboards, and more.

## Setup

Before using, set your Datadog API and Application keys:

```bash
export DATADOG_API_KEY="your_api_key"
export DATADOG_APP_KEY="your_app_key"
```

Or create `~/.dogrc`:

```ini
[Connection]
apikey = your_api_key
appkey = your_app_key
```

Secure the config file:

```bash
chmod 600 ~/.dogrc
```

## 快速上手

```bash
# 查最近一小时的指标
dog metric query --query "avg:system.cpu.user{*}" --start $(date -v-1H +%s) --end $(date +%s)

# 列监控项 / 静音某个监控
dog monitor list
dog monitor mute <monitor_id>
```

## 详细命令在哪（按需 `read_file`，都在本技能目录下）

| 你要做的事 | 读这个 |
| --- | --- |
| 常用命令：指标查询/上报、事件、监控、服务检查、仪表盘、主机、标签、维护窗口 | `references/commands.md` |
| 现成查询样例：系统指标、应用指标（请求率/错误率/P95） | `references/commands.md` |
| CI/CD 里用 `datadog-ci`（上传 sourcemap、JUnit 结果、触发合成测试） | `references/datadog-ci.md` |

## Environment Variables

| Variable          | Description                                         |
| ----------------- | --------------------------------------------------- |
| `DATADOG_API_KEY` | Your Datadog API key                                |
| `DATADOG_APP_KEY` | Your Datadog Application key                        |
| `DATADOG_HOST`    | API endpoint (default: `https://api.datadoghq.com`) |

For EU region, set:

```bash
export DATADOG_HOST="https://api.datadoghq.eu"
```

## Security Notes

- Never commit API keys to version control
- Use Application keys with minimal required permissions
- Store credentials in `~/.dogrc` with `chmod 600`
- Rotate keys periodically
- Use separate keys for different environments

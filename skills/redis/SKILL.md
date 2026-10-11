---
name: redis
description: Manage Redis databases via the redis-cli tool.
metadata:
  displayName: Redis
  icon: database
  category: databases
  version: 1.0.0
---

# redis-cli

Use `redis-cli` to interact with Redis instances.

## Common Commands

### Connection

- Connect: `redis-cli -h <host> -p <port> -a <password>`

### Operations

- Set key: `SET key value`
- Get key: `GET key`
- List keys: `KEYS pattern`
- Delete key: `DEL key`
- Check info: `INFO`
- Quit: `exit`

## Notes

- Requires `redis-cli` to be installed in the environment.
- xzh does **not** install the `redis-cli` client for you (only `playwright` and `officecli` are
  auto-installed) — install it yourself, e.g. `brew install redis` (macOS),
  `sudo apt install redis-tools` (Debian / Ubuntu), `sudo dnf install redis` (RHEL).

---
name: postgres
description: Manage PostgreSQL databases via the psql CLI.
metadata:
  displayName: PostgreSQL
  icon: postgres
  category: databases
  version: 1.0.0
---

# psql

Use `psql` to interact with PostgreSQL databases.

## Common Commands

### Connection

- Connect: `psql "postgresql://user:password@host:port/dbname"`

### Operations

- List databases: `\l`
- List tables: `\dt`
- Describe table: `\d <table_name>`
- Execute query: `SELECT * FROM table LIMIT 10;`
- Quit: `\q`

## Notes

- Requires `psql` to be installed in the environment.
- xzh does **not** install the `psql` client for you (only `playwright` and `officecli` are
  auto-installed) — install it yourself, e.g. `brew install libpq` (macOS, then add `psql` to PATH),
  `sudo apt install postgresql-client` (Debian / Ubuntu), `sudo dnf install postgresql` (RHEL).

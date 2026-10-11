---
name: mysql
description: Manage MySQL databases via the mysql CLI.
metadata:
  displayName: MySQL
  icon: database
  category: databases
  version: 1.0.0
---

# mysql

Use `mysql` to interact with MySQL databases.

## Setup

xzh does **not** install the `mysql` client for you — install it first:

```bash
# macOS
brew install mysql-client
# Debian / Ubuntu
sudo apt install mysql-client
# RHEL / Fedora
sudo dnf install mysql
# Windows
winget install Oracle.MySQL
```

> Only `playwright` and `officecli` are auto-installed by xzh.

## Common Commands

### Connection

- Connect: `mysql -h <host> -P <port> -u <user> -p`
- Connect (Docker example): `mysql -h 127.0.0.1 -P 3306 -u root -p`

### Operations

- Show databases: `SHOW DATABASES;`
- Use database: `USE <dbname>;`
- Show tables: `SHOW TABLES;`
- Describe table: `DESCRIBE <table_name>;`
- Execute query: `SELECT * FROM table LIMIT 10;`
- Quit: `exit`

## Notes

- Password can be supplied via `MYSQL_PWD` environment variable (careful!) or typically prompted interactively.

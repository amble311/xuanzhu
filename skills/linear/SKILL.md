---
name: linear
description: Manage Linear issues via the linear-cli (unofficial or custom wrapper).
metadata:
  displayName: Linear
  icon: list
  category: project-management
  version: 1.0.0
---

# linear-cli

Use `linear` (or appropriate CLI wrapper) to interact with Linear.

## Common Commands

### Issues

- List issues: `linear issue list`
- View issue: `linear issue view <ID>`
- Create issue: `linear issue create`

## Notes

- Requires a Linear CLI tool to be installed.
- xzh does **not** install a Linear CLI for you (only `playwright` and `officecli` are
  auto-installed) — pick one yourself and put it on `PATH`.
- Requires `LINEAR_API_KEY` environment variable.

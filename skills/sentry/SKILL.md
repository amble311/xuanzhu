---
name: sentry
description: Manage Sentry projects and releases via the sentry-cli.
metadata:
  displayName: Sentry
  icon: alert-circle
  category: monitoring
  version: 1.0.0
---

# sentry-cli

Use `sentry-cli` to interact with Sentry.

## Common Commands

### Releases

- List releases: `sentry-cli releases list`
- New release: `sentry-cli releases new <version>`
- Finalize release: `sentry-cli releases finalize <version>`

### Issues

- List issues: `sentry-cli issues list`

## Notes

- Requires `sentry-cli` to be installed.
- xzh does **not** install `sentry-cli` for you (only `playwright` and `officecli` are
  auto-installed) — install it yourself: <https://docs.sentry.io/cli/>
  (macOS: `brew install getsentry/tools/sentry-cli`).
- Requires `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` environment variables or configuration.

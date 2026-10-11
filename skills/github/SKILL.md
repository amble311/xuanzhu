---
name: github
description: Manage GitHub repositories, issues, and pull requests via the gh CLI.
metadata:
  displayName: GitHub
  icon: github
  category: version-control
  version: 1.0.0
---

# gh (GitHub CLI)

Use `gh` to interact with GitHub.
This tool allows you to manage PRs, issues, and repositories directly from the chat.

## Installation

xzh does **not** install this CLI for you — install it yourself:

```bash
# macOS
brew install gh
# Windows
winget install --id GitHub.cli
# Linux: follow https://github.com/cli/cli/blob/trunk/docs/install_linux.md
```

> Only `playwright` and `officecli` are auto-installed by xzh.

## Setup

Before using, you must authenticate. Run the following command in the terminal:
`gh auth login`

## Common Commands

### Pull Requests

- List PRs: `gh pr list`
- View PR: `gh pr view <PR-NUMBER>`
- Checkout PR: `gh pr checkout <PR-NUMBER>`
- Create PR: `gh pr create`
- Review PR: `gh pr review <PR-NUMBER>`
- Merge PR: `gh pr merge <PR-NUMBER>`

### Issues

- List issues: `gh issue list`
- View issue: `gh issue view <ISSUE-NUMBER>`
- Create issue: `gh issue create`

### Repositories

- View repo info: `gh repo view`
- Clone repo: `gh repo clone <OWNER>/<REPO>`

## Notes

- Ensure you have a GitHub account and permissions for the repositories you want to access.
- Authentication token is stored securely by `gh`.

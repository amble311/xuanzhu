---
name: gitlab
description: Manage GitLab issues and merge requests via the glab CLI.
metadata:
  displayName: GitLab
  icon: git-merge
  category: version-control
  version: 1.0.0
---

# glab

Use `glab` to interact with GitLab.
This tool allows you to view, create, and update GitLab issues and merge requests.

## Setup

xzh does **not** install this CLI for you — install it yourself (official docs:
<https://docs.gitlab.com/cli/>; e.g. `brew install glab`, or download a release binary),
then authenticate:

```bash
glab auth login
```

> Only `playwright` and `officecli` are auto-installed by xzh.

## Common Commands

### Issues

- List issues: `glab issue list`
- View issue: `glab issue view <ID>`
- Create issue: `glab issue create`
- Assign: `glab issue update <ID> --assignee <USER>`

### Merge Requests

- List MRs: `glab mr list`
- Create MR: `glab mr create`
- View MR: `glab mr view <ID>`

## Notes

- Requires a GitLab personal access token.

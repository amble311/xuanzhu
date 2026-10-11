---
name: jira
description: Manage Jira issues, sprints, and epics via the jira-cli tool.
metadata:
  displayName: Jira
  icon: jira
  category: project-management
  version: 1.0.0
---

# jira-cli

Use `jira` to interact with Jira.
This tool allows you to view, create, and update Jira issues directly from the chat.

## Installation

xzh does **not** install this CLI for you — install it yourself:

```bash
# macOS
brew install ankitpokhrel/jira-cli/jira-cli
# Linux / others: official install script
curl -fsSL https://raw.githubusercontent.com/ankitpokhrel/jira-cli/master/scripts/install.sh | bash
```

> Only `playwright` and `officecli` are auto-installed by xzh.

## Setup

Before using, you must authenticate. Run the following command in the terminal:
`jira init`

## Common Commands

### Issues

- List issues: `jira issue list`
- View issue: `jira issue view <ISSUE-KEY>`
- Create issue: `jira issue create`
- Comment: `jira issue comment add <ISSUE-KEY> "Comment text"`
- Assign: `jira issue assign <ISSUE-KEY> <USER>`

### Sprints & Boards

- List boards: `jira board list`
- List sprints: `jira sprint list --board <BOARD-ID>`

### JQL

- Search with JQL: `jira issue list --jql "project = PROJ AND status = 'In Progress'"`

## Notes

- Ensure you have an API token ready from Atlassian (https://id.atlassian.com/manage-profile/security/api-tokens).
- Configuration is stored in `~/.jira/.config.yml`.

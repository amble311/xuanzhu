---
name: email
description: Send emails using mailsend-go CLI
metadata:
  displayName: Email (SMTP)
  icon: mail
  category: communication
  version: 1.0.0
---

# Email Skill

This skill allows sending emails via SMTP using the `mailsend` tool (mailsend-go).

## Prerequisites

- **`mailsend` (mailsend-go) must be installed by you** — xzh does not install it
  (only `playwright` and `officecli` are auto-installed). Get it from
  <https://github.com/muquit/mailsend-go> (macOS: `brew install muquit/formulae/mailsend-go`;
  Linux/Windows: download a release binary and put it on `PATH`).
- SMTP credentials (host, port, user, password)

## Usage

Use `mailsend` to send emails.

### Send a simple email

```bash
mailsend -smtp <smtp_host> -port <smtp_port> -auth -user <username> -pass <password> -from <sender_email> -to <recipient_email> -sub "Subject" -body "Body text"
```

### Send with SSL/TLS (Gmail example)

```bash
mailsend -smtp smtp.gmail.com -port 587 -starttls -auth -user <username> -pass <password> -from <sender_email> -to <recipient_email> -sub "Subject" -body "Body text"
```

### Notes

- For Gmail, use App Passwords if 2FA is enabled.
- Always ask the user for SMTP credentials before sending if not provided.

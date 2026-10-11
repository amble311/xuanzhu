---
name: telegram
description: Send Telegram messages, files, and interact with Telegram bots via the telegram-send CLI tool.
metadata:
  displayName: Telegram
  icon: send
  category: communication
  version: 1.1.0
---

# telegram-send

Use `telegram-send` to send messages, files, and media to Telegram chats.
This tool requires initial configuration with a Telegram bot token.

## Setup

Before using, configure telegram-send with your bot token:

```bash
telegram-send --configure
```

This will prompt you to:

1. Create a bot via [@BotFather](https://t.me/botfather) on Telegram
2. Enter the bot token
3. Send `/start` to your bot to enable messaging

For group chats, use `--configure-group` instead:

```bash
telegram-send --configure-group
```

## 常用命令在哪（按需 `read_file`，在本技能目录下）

| 你要做的事 | 读这个 |
| --- | --- |
| 发文本 / 格式化 / 文件 / 图片 / 代码块 / 静音 / 位置、指定多套配置 | `references/commands.md` |

## Configuration Files

Default config location: `~/.config/telegram-send.conf`

You can have multiple configs for different bots/chats:

- `~/.config/telegram-send.conf` - default
- `~/.config/telegram-send-group.conf` - for group chats
- Custom paths with `--config`

## Security Notes

- Bot tokens are stored in the config file - ensure proper file permissions
- Run `chmod 600 ~/.config/telegram-send.conf` to secure credentials
- Never commit config files to version control
- Use separate bots for different purposes (personal, work, etc.)

## Error Handling

If you get "Unauthorized" errors:

1. Verify your bot token with @BotFather
2. Ensure you've sent `/start` to the bot
3. Re-run `telegram-send --configure`

## Limitations

- Can only send to users/groups that have started the bot
- Rate limits apply (avoid spamming)
- File size limits: 50MB for documents, 10MB for photos

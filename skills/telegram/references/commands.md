# telegram-send 常用命令

> `telegram` 技能的伴随文件。**先看主文件**的 Setup（`telegram-send --configure`）。

## Send Text Message

```bash
telegram-send "Hello from xzh!"
```

## Send with Formatting

```bash
# Markdown formatting
telegram-send --format markdown "**Bold** and _italic_ text"

# HTML formatting
telegram-send --format html "<b>Bold</b> and <i>italic</i> text"
```

## Send Files

```bash
# Send a document
telegram-send --file /path/to/document.pdf

# Send with caption
telegram-send --file /path/to/document.pdf --caption "Here's the report"
```

## Send Images

```bash
# Send image
telegram-send --image /path/to/image.png

# Send image with caption
telegram-send --image /path/to/screenshot.png --caption "Screenshot attached"
```

## Send to Specific Config (Multiple Bots/Chats)

```bash
# Use a specific config file
telegram-send --config /path/to/custom.conf "Message to specific chat"
```

## Send Code Blocks

```bash
# Send pre-formatted code
telegram-send --format markdown "\`\`\`python
def hello():
    print('Hello, World!')
\`\`\`"
```

## Silent Messages (No Notification)

```bash
telegram-send --silent "This won't trigger a notification"
```

## Send Location

```bash
telegram-send --location 37.7749 -122.4194
```

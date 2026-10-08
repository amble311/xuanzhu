# XuanZhu 玄猪

**English** | [中文](https://github.com/amble311/xuanzhu/blob/main/README.md)

> An AI coding agent built for the terminal — one `xzh` command brings an AI programming assistant into your terminal.

## Quick Start

```bash
npm i -g xuanzhu    # Install (requires Node.js >= 18)
xzh model           # Configure a model: pick a provider, enter your API Key
xzh                 # Launch
```

## Introduction

XuanZhu is a full-screen AI agent that runs in your terminal: it can read your codebase, read and write files directly, run commands, execute tests, and show you every step of its reasoning and tool calls through streaming output. Its core is based on the open-source code of CodeBuddy.

```
╭──────────────────────────────────────────────╮
│   XuanZhu  ·  Terminal AI Coding Agent       │
╰──────────────────────────────────────────────╯
```

## Features

- **Full-screen TUI**: output pane + multi-line input + status bar, implemented in pure ANSI with zero extra UI dependencies.
- **Multi-model support**: DeepSeek, Anthropic Claude, OpenAI, Google Gemini, Zhipu GLM, Qwen, Groq, Ollama, and any OpenAI-compatible endpoint.
- **Built-in tools**: read / write / edit files, list directories, glob, grep, and run shell commands.
- **Streaming responses**: Markdown rendered in real time, with code block support and correct CJK alignment.
- **Fully automatic by default**: `autoApprove` defaults to `true`, so **all tools execute directly without any confirmation** — including writing files, running commands, reading files outside the workspace, and reading credential files (`~/.ssh`, `.env`, `~/.xzh/config.json`, etc.). It works out of the box without interruptions. Use `/auto off` to switch to per-item confirmation for file writes and command execution.
  - If you want a one-time confirmation when reading credential files (to prevent secrets from being pulled into the context and forwarded to the model provider), set `confirmSensitiveRead` to `true`. It is off by default.
- **Multi-turn autonomous execution**: chains tool calls automatically to complete a task; press `Ctrl+C` to interrupt at any time.

## Requirements

- Node.js >= 18
- A model that supports tool calling (DeepSeek / Claude / GPT-4o are recommended)

## Installation

### Option 1: npm (recommended)

```bash
npm i -g xuanzhu    # Global install
xzh                 # Launch
```

If you prefer not to install globally, you can try it without installing:

```bash
npx xuanzhu
```

> If you see `xzh: command not found` after installing, npm's global `bin` directory is not on your `PATH`. See "PATH configuration" below.

### Option 2: One-line script

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/amble311/xuanzhu/main/install.sh | sh
```

**Windows (PowerShell)**

```powershell
iex (irm https://raw.githubusercontent.com/amble311/xuanzhu/main/install.ps1)
```

The script checks your Node.js version, installs `xzh` globally, and tells you how to fix `PATH` if needed.

**Do not use `sudo`**: the script detects and refuses to run as root. Installing as root makes the files under `bin` owned by root, after which a normal user can no longer upgrade or uninstall. If the global directory really is not writable, the script suggests a user-level prefix:

```bash
npm config set prefix ~/.npm-global   # then make sure ~/.npm-global/bin is on PATH
```

**Environment variables supported by the script**

| Variable | Purpose |
| --- | --- |
| `XZH_PACKAGE` | Manually specify the install source (overrides auto-detection): package name, `name@version`, git repo, local tarball, or directory |
| `XZH_VERSION` | Specify a version, equivalent to `xuanzhu@<version>` |
| `XZH_NPM_ARGS` | Extra arguments passed to npm, e.g. a mirror `--registry=https://registry.npmmirror.com` |
| `XZH_DRY_RUN=1` | Print the commands that would run without actually installing |

### Option 3: From source (for development)

```bash
git clone https://github.com/amble311/xuanzhu.git
cd xuanzhu
npm install
npm run build
npm link          # makes the xzh command point at your local source
```

After changing the source, run `npm run build` and it takes effect (`npm link` creates a symlink).
To switch back to the published version:

```bash
npm unlink -g xuanzhu && npm i -g xuanzhu
```

### Environment requirements

- **Node.js >= 18**
- **A real terminal**: the TUI needs an interactive terminal; it cannot run in pipes, CI, or some editors' built-in terminals
- The first run creates `.xuanzhu/` in the **current working directory** (project memory and rules); consider adding it to `.gitignore`

## Getting Started

```bash
# 1. Configure a model and provider (interactive; you can add several models and set their weights)
xzh model

# 2. Launch XuanZhu (it picks the model with the highest weight)
xzh
```

Then type a task in the interface, for example:

```
Take a look at what this project does, then add an engines field to package.json
```

## Commands

| Command | Description |
| --- | --- |
| `xzh` | Launch the full-screen interface in the current directory |
| `xzh <directory>` | Launch in the given project directory, e.g. `xzh /home` |
| `xzh model` | Interactively manage models (add / remove / adjust weight / list all) |
| `xzh model list` | List **configured** models and their weights |
| `xzh model all` | List **all built-in available** models (grouped by provider, configured ones marked) |
| `xzh model add <provider> <model> [weight]` | Add a model (default weight `10`) |
| `xzh model remove <id\|index>` | Remove a model |
| `xzh model weight <id\|index> <weight>` | Adjust a model's weight |
| `xzh model context <id\|index> <size>` | Adjust the context window (tokens, e.g. `128000`) |
| `xzh model reset` | Restore all model weights to the default |
| `xzh config` | Show the current configuration (API Keys masked) |
| `xzh config edit` | Edit the config file with `nano` |
| `xzh config path` | Print the config file path |
| `xzh config init` | Generate a default config file |
| `xzh setup` | Check and install skill dependencies (playwright / officecli, etc.) |
| `xzh --help` | Show help |
| `xzh --version` | Show version |

## Configuration

The config file lives at `~/.xzh/config.json` (mode `600`). The `XZH_HOME` environment variable redirects the whole thing — it points at the **global directory itself** (not your home directory):

```bash
XZH_HOME=/path/to/dir xzh          # uses /path/to/dir/config.json
```

This is useful for running multiple environments side by side (local / remote / container, each with its own config). When set, the legacy `~/.xuanzhu` migration is **skipped** — that is a location you chose explicitly, and pulling old data from your home directory into it would only be confusing.

```json
{
  "version": 1,
  "provider": "deepseek",
  "model": "deepseek-chat",
  "models": [
    { "id": "deepseek/deepseek-chat", "provider": "deepseek", "model": "deepseek-chat", "weight": 10 },
    { "id": "openai/gpt-4o", "provider": "openai", "model": "gpt-4o", "weight": 6 }
  ],
  "temperature": 0.2,
  "maxToolRounds": 200,
  "autoApprove": true,
  "intent": { "enabled": false },
  "providers": {
    "deepseek": {
      "apiKey": "sk-...",
      "model": "deepseek-chat"
    }
  }
}
```

> Older configs (with only `provider` / `model` and no `models`) still work: they are treated as a single model with weight `10`.

### Multiple models and call weights

`models` can hold several models, each with a **call weight** (default `10`):

| Behavior | Description |
| --- | --- |
| Startup selection | Prefers the model with the **highest weight** |
| Call failure | That model's weight **-1** (a manual `Ctrl+C` interrupt does not count as a failure) |
| Automatic fallback | If another usable model has **not been tried yet**, switch to the highest-weighted one and retry (each model is tried at most once per request, up to 3 switches) |
| No pointless retries | When only one model exists (or the weights were reset to it), it does **not** retry — it reports the error along with the current model info |
| Weights exhausted | When **every model's weight is 0**, it warns in the terminal and resets all weights back to `10` |
| Config errors do not decay | Invalid key / no permission / model or endpoint not found: **no weight is deducted and nothing is written to disk**; it just tells you to check the config — an unfixed config will always fail, and deducting weight would only drag the other usable models down with it |
| Context overflow does not decay | When the model's window is exceeded, it **trims history and retries automatically**, again without deducting weight (see the section above) |

```bash
xzh model                              # interactive menu
xzh model list                         # show configured models and weights
xzh model all                          # show all built-in available models
xzh model add openai gpt-4o 20         # add (weight 20)
xzh model weight openai/gpt-4o 5       # adjust weight
xzh model context openai/gpt-4o 128000 # adjust context window (leave blank to infer)
xzh model remove openai/gpt-4o         # remove (id / model name / index all work)
xzh model reset                        # restore all default weights
```

The model currently in use and its weight are shown at the top of the interface and in the status bar (e.g. `gpt-4o w6`); a fallback switch is announced in the output pane.

### What the context window does

`contextWindow` is not just informational — it decides **how much history each request can carry**:

- XuanZhu derives an input budget of `contextWindow × 80%` (the remainder is reserved for this reply and estimation error), then subtracts the system prompt's usage; whatever is left goes to the conversation history.
- When the budget is exceeded it works in **layers**: it first compresses **old, large tool outputs** (keeping the head and tail, cutting the middle), and only discards whole messages from the oldest end if that still is not enough. This way it never drops "the requirement the user originally stated" just to free space while keeping a stale `ls` result. The most recent conversation is always preferred; if a single message alone exceeds the budget, its body is truncated rather than dropped entirely.
- If the value is not configured, it is inferred from the model name (`xzh model all` and `xzh model list` show the inferred value). The inference table only covers common models, so obscure or self-hosted model names fall back to a conservative 32k — if your model's window is larger, set it explicitly with `xzh model context <id> <size>`, otherwise history will be trimmed shorter than necessary.

> Trimming relies on **estimated** token counts (about 1 character/token for Chinese, about 3.5 characters/token for English and code). It does not use a tokenizer, so it is a conservative approximation. Project rules (`.xuanzhu/rules.md`) and `systemPromptExtra` are injected into the system prompt in full, so an overly long one eats into the history budget — the interface warns you when it takes up more than half the window.

If estimation error still leads to an overflow (the server returns something like `context_length_exceeded`), XuanZhu **halves the budget and retries once automatically**, rather than treating it as a model failure to decay or switch models — resending the same long messages to another model would fail just the same and waste that model's weight for nothing.

### Intent analysis (optional, off by default)

When enabled, **every message is first wrapped in a template and sent in a separate request**; the returned analysis is then passed to the main flow as this turn's input. Useful when a request is vague and you want the model to "guess the intent" first.

Three ways to enable it:

```bash
xzh --intent            # enable for this launch only (not written back to config)
xzh --no-intent         # force it off for this launch only
```

Set `intent.enabled: true` in the config file, or use `/intent on` inside the interface (which writes back to the config, and a `⌁intent` marker appears in the status bar).

Default template (customizable in `intent.prompt`, using `{{'用户发送过来的消息'}}` as the placeholder):

```
请分析下面消息的意图，以第一人称输出三段：【核心意图】一句话总结；【需求拆解】逐条列出明确需求；【隐性意图】潜在诉求。不要增加原文不存在信息。 消息： {{'用户发送过来的消息'}}
```

Key behaviors:

- The intent request **carries no tool declarations** and is not written to the conversation history (keeping the main flow's context clean)
- The analysis is shown in the output pane first (along with the original message) so you can confirm it understood correctly
- On failure or an empty result it **falls back** to your original input, without affecting the main flow and without decaying the model's weight
- Trade-off: one extra model request per message (roughly doubling token usage), hence off by default

API Keys can also come from environment variables, with lower priority than the config file:

| Provider | Environment variable |
| --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| GLM | `GLM_API_KEY` |
| Qwen | `DASHSCOPE_API_KEY` |
| Groq | `GROQ_API_KEY` |

## Supported providers

| Provider | Identifier | Default model | Notes |
| --- | --- | --- | --- |
| DeepSeek | `deepseek` | `deepseek-chat` | The default choice |
| Anthropic | `anthropic` | `claude-sonnet-4-5` | Strong tool-calling ability |
| OpenAI | `openai` | `gpt-4o` | |
| Google | `gemini` | `gemini-2.0-flash` | |
| Zhipu | `glm` | `glm-4-plus` | |
| Qwen | `qwen` | `qwen-max` | |
| Groq | `groq` | `llama-3.3-70b-versatile` | Fast |
| Ollama | `ollama` | `qwen2.5-coder` | Runs locally, no key needed |
| Custom | `custom` | — | Any OpenAI-compatible endpoint |

## Built-in tools

| Tool | Purpose | Confirmation |
| --- | --- | --- |
| `list_skills` | List all skills available to XuanZhu | No |
| `load_skill` | Load the full guide for a given skill | No |
| `memory_read` | Read project memory (long-term memory + recent log) | No |
| `memory_write` | Write project memory (long-term / daily log) | No |
| `read_file` | Read a file (with line numbers; supports offset and limit) | No |
| `list_dir` | List a directory | No |
| `glob` | Find files by `**` / `*` / `?` patterns | No |
| `grep` | Search file contents by regular expression | No |
| `write_file` | Overwrite a file | Yes |
| `edit_file` | Exact text replacement | Yes |
| `bash` | Run a shell command | Yes |

## Project directory (.xuanzhu/)

The first time you run `xzh` in a project, it creates `.xuanzhu/` at the project root to hold **project-level memory and rules** (the counterpart of CodeBuddy's `.codebuddy/memory/`):

| Path | Purpose |
| --- | --- |
| `.xuanzhu/memory/MEMORY.md` | Long-term memory: stable project conclusions and conventions, injected into the system prompt (an excerpt) at startup |
| `.xuanzhu/memory/YYYY-MM-DD.md` | Daily log: a running record appended per day |
| `.xuanzhu/rules.md` | Project rules, injected into the system prompt as "project-level instructions". **On first initialization, if the project root already has `AGENTS.md`**, an instruction is written instead — "you must strictly follow `AGENTS.md`" — rather than copying its content, so that `AGENTS.md` remains the single source of truth: edit it and the model sees the new version on its next read |

Memory is maintained by XuanZhu itself:

- At startup it reads `MEMORY.md` **and the current day's log** into the prompt (an excerpt of each), so XuanZhu understands the project background from the beginning
- When it needs more history it calls `memory_read`; **after completing each piece of substantive work** it must call `memory_write` to record the conclusion (technical decisions, project conventions, pitfalls hit, important findings). This requirement also appears under "Core principles" in the system prompt, which explicitly asks it to **write memory before producing the final answer** — the earlier wording ("may call") was too weak and in practice almost never triggered
- `.xuanzhu` is **always** located under the current project path, with **no upward search**: working in `/a/b/c` uses only `/a/b/c/.xuanzhu`, and an existing `.xuanzhu` in `/a` or `/a/b` is never reused
- **At startup** and **when `/switch` changes directory**, if that directory has no `.xuanzhu` yet, it is created automatically
- Each project directory therefore has its own memory and rules; `~/.xzh` is purely the **global config directory** (config.json / session / logs / skills) and does not participate in project memory

> Skills and the CLI are **global**: skills live in `~/.xzh/skills` (layered on top of the built-ins), and the CLI is installed system-wide — neither is limited by project.

## Built-in skills

A skill is a guide telling XuanZhu how to use a particular external CLI tool (`skills/<name>/SKILL.md`). When a task touches some domain, XuanZhu first calls `list_skills` to see what is available, then `load_skill` to load the full guide (which installs and verifies its dependencies), and finally uses `bash` to run the commands described in the guide.

18 skills ship with the package; the commonly used ones:

| Skill | Domain | Dependency |
| --- | --- | --- |
| `playwright` | Browser automation, end-to-end testing, web verification (**uses your installed Chrome by default** to reduce anti-bot blocking) | `playwright-cli` (`npm i -g @playwright/cli@latest`) |
| `officecli` | Creating and reading Word / Excel / PowerPoint documents | `officecli` (single binary; see the install notes inside the skill) |
| `github` / `gitlab` | Repositories, issues, PRs / MRs | `gh` / `glab` |
| `jira` / `linear` | Project management | The respective CLI |
| `aws` / `kubernetes` | Cloud resources and container orchestration | `aws` / `kubectl` |
| `postgres` / `mysql` / `mongodb` / `redis` / `elasticsearch` | Databases | The respective client |
| `sentry` / `datadog` | Monitoring and alerting | The respective CLI |
| `gmail` / `email` / `telegram` | Email and messaging | The respective CLI |

### Automatic dependency installation

The CLIs listed above are installed by XuanZhu, so **you do not need to install them yourself**:

- When a skill is loaded during a conversation (`load_skill`), XuanZhu checks its dependencies first; if something is missing, it asks once for confirmation and then installs and verifies it automatically.
- You can also run `xzh setup` to check and install the dependencies of all built-in skills at once.

### Custom skills

Drop your own skill in `~/.xzh/skills/<name>/SKILL.md` and it is discovered automatically (a skill with the same name overrides the built-in one):

```markdown
---
name: my-skill
description: One sentence describing what this skill is for and when to use it
---

# my-skill

(Body text guiding the model on how to use the tool)
```

## Interface layout

The interface has two columns, with a status bar spanning the full width at the bottom:

```
┌─────── left (conversation) ─────┬──── right (terminal) ────┐
│ header: brand/model/directory    │ terminal · working dir   │
├──────────────────────────────────┤                          │
│ conversation (scrollable)         │ command output (scroll)  │
├──────────────────────────────────┤ ──────────────────────   │
│ input area                       │ ❯ command input          │
├──────────────────────────────────┴──────────────────────────┤
│ status bar: model · status · current focus (chat▸/term▸)     │
└─────────────────────────────────────────────────────────────┘
```

- **Visual hierarchy of history**: your input is marked with a green-background `❯` and shown in bright green bold (multi-line input continues with `│`), tool calls are marked with a magenta `⏺`, and XuanZhu's replies are plain body text — so you can tell them apart at a glance when scrolling back
- The right side is a **terminal panel**: run shell commands directly (`ls`, `git status`, `npm test`, …) and see the output live
- `Shift+Tab` toggles focus between the chat input and the terminal input; with a mouse you can also **click the column** you want
- Commands run in the current project directory, and `cd` takes effect (the panel maintains the working directory itself)
- **`Tab` completion**: in command position it completes commands from `PATH`; in argument position it completes file paths (`cd` completes directories only)
  - Supports relative paths, `./`, `../`, absolute paths, `~`, quoting (`cat "src/tu`), and `VAR=path`
  - A trailing space falls back to the previous incomplete word (`cat src/tui/ ` + `Tab` lists that directory)
  - A unique match is completed directly (directories get `/`, commands and files get a space); with multiple matches it first extends the common prefix, then lists candidates on the next press
- The right panel is hidden automatically below 80 columns, and can be toggled manually with `/term`
- The mouse wheel affects whichever area the pointer is over: scrolling command output on the right, the conversation on the left
- Limitations: commands are launched wrapped in the system's `script` command so that the child process gets a PTY — colors, progress bars, and interactive prompts therefore all work, and keystrokes are forwarded to the running command. What is still **not** possible is full-screen interactive programs such as `vim` / `htop` / `less` (there is no real screen refresh or window-size negotiation), and `export`-ed variables do not persist across commands

## Interface key bindings

| Key | Action |
| --- | --- |
| `Enter` | Submit input |
| `Alt+Enter` | Insert a newline (native terminal encoding; works everywhere) |
| `Ctrl+Enter` / `Shift+Enter` | Insert a newline (requires terminal support for extended keyboard protocols, see below) |
| `↑` / `↓` | Browse input history (command history inside the terminal panel) |
| `Tab` | Completion inside the terminal panel: command name (`PATH`) or file path |
| `PgUp` / `PgDn` | Page up / down (conversation on the left, terminal output on the right) |
| `Shift+↑` / `Shift+↓` | Scroll one line at a time |
| `Home` / `End` | Jump to the oldest / back to the newest |
| `Shift+Tab` | Toggle focus (chat ⇄ right terminal) |
| Mouse click | Focus follows the column you click |
| Mouse wheel | Scroll by area (left: conversation; right: terminal output) |
| `Ctrl+C` | Interrupt the current task / clear input / exit (exits when idle with empty input) |
| `Ctrl+D` | End the current conversation turn (**never exits XuanZhu under any circumstance**); inside the terminal panel it interrupts the running command |
| `Ctrl+L` | Clear the screen (inside the terminal panel it clears command output) |

> `Ctrl+D` does exactly one thing — "end this conversation turn": pressing it when no conversation is running does nothing, and it **never exits the interface**.
> To exit, use `Ctrl+C` (when idle with empty input) or `/exit`.

### Making Ctrl+Enter / Shift+Enter work

On startup the program asks the terminal to report modifier keys (xterm `modifyOtherKeys` level 2, restored on exit), but **most IDE built-in terminals (VS Code / CodeBuddy / Cursor, all based on xterm.js) do not implement that request** — `Ctrl+Enter`, `Shift+Enter`, and `Enter` produce byte-for-byte identical sequences, and no terminal program can tell them apart. You must bind those two keys on the IDE side so they send distinguishable sequences. Add this to `keybindings.json`:

```json
[
  { "key": "shift+enter", "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "\u001b[13;2u" }, "when": "terminalFocus" },
  { "key": "ctrl+enter", "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "\u001b[13;5u" }, "when": "terminalFocus" }
]
```

Where `keybindings.json` lives: in VS Code / CodeBuddy press `Ctrl+Shift+P` → `Preferences: Open Keyboard Shortcuts (JSON)`, or edit `<user data dir>/User/keybindings.json` directly. The binding applies to all terminals in that IDE.

Other terminals: xterm / VTE-based ones (gnome-terminal and friends) are negotiated automatically and work out of the box; kitty / Ghostty map that xterm-compatible sequence to "report all keys as escape codes", which breaks normal input, so XuanZhu does not send the request to those two — use `Alt+Enter` instead or configure it on the terminal side.

In-interface commands: `/help`, `/clear`, `/copy [N|all]`, `/mouse`, `/reset`, `/cwd`, `/switch <dir>`, `/term`, `/model`, `/auto [on|off]`, `/intent [on|off]`, `/exit`.

### Selecting and copying

In the output area, **hold the left button and drag** across the lines you want; **releasing writes them to the system clipboard** — the mouse wheel keeps working at the same time, with no interference.

| Method | Description |
| --- | --- |
| **Drag in the output area** | Selection implemented by XuanZhu itself (whole lines). Releasing copies; no key press needed and it does not require `/mouse` |
| Hold **Shift** and drag | Uses the **terminal's native** selection (most terminals let Shift bypass application-level capture); use this when you need character precision |
| `/copy [N\|A-B\|last\|all]` | Copy the **left conversation pane** on demand. Supports `/copy 100` (last 100 lines), `/copy 100-200` (line range), `/copy last` (the most recent conversation), `/copy all` (everything) |
| `/copy term [N\|A-B\|all]` | Copy the **right terminal pane's** output (last 30 lines by default) |
| `/mouse` | Hands the mouse **entirely back to the terminal** (switching to native selection and the right-click menu; scrolling the output area then uses `PgUp`/`PgDn`). The change is written back to the config |

> **Why a multi-line drag mixes the two panes** — the terminal's native selection is a
> **rectangular** selection: it only knows "from column X to column Y" and **cannot see
> the application's split panes**. Dragging from the left pane into the right (or back)
> therefore picks up text from both, because they share the same screen rows. This is a
> protocol-level limitation the application cannot intervene in.
>
> To copy **one pane** only, use the command forms (`/copy` for the left pane,
> `/copy term` for the right) — they take content per pane and can never mix. XuanZhu's
> own drag-selection (with `/mouse` enabled) is likewise confined to the left pane.
>
> Conversely, if you want the terminal's native selection and context menu: hold `Shift`
> while dragging to bypass capture temporarily, or use `/mouse` to turn capture off
> (scrolling the output area then uses `PgUp`/`PgDn`).
>
> **Why drag-selection is implemented in-house**: in the terminal protocol, `?1000h` is an **all-or-nothing switch** — once enabled, the terminal hands every mouse event to the program and native selection stops working; once disabled, the wheel is useless too (XuanZhu runs on the **alternate screen**, where the terminal has no scrollback history). Since the events are already in the program's hands, XuanZhu records the selection itself and writes it to the clipboard, so "scroll with the wheel" and "select and copy" coexist.
>
> Selection works by **whole lines**: long lines in the output area wrap, and the text contains ANSI colors and wide characters, so character-level mapping costs far more than it is worth — and in practice what you want to copy is a whole passage. What gets copied is the **original logical line** (not the wrapped rendering), so long lines are not cut off.
>
> All of the above depends on the terminal supporting **OSC 52**. A few terminals (such as GNOME Terminal with default settings) ignore it for security reasons, in which case pasting yields nothing — use Shift+drag, or the terminal's own copy mechanism.

### Why the newline keys sometimes do not work

XuanZhu asks the terminal for modifier+Enter through the terminal protocol (xterm's `modifyOtherKeys` by default), but **some terminals simply do not implement it** — most notably the xterm.js-based IDE built-in terminals (VS Code / CodeBuddy). Those terminals encode `Ctrl+Enter` and `Shift+Enter` into **exactly the same bytes** as a plain `Enter`, so the program has no way to distinguish them and cannot treat them as a newline.

**`Alt+Enter` uses the terminal's native encoding and works everywhere** — it is the most reliable way to insert a newline.

To find out what your terminal actually sends, or to try another reporting protocol:

```bash
# Diagnose: log the raw bytes the terminal sends to ~/.xzh/keys.log
XZH_DEBUG_KEYS=1 xzh
# Press Ctrl+Enter / Shift+Enter a few times, then exit and look
cat ~/.xzh/keys.log

# Alternative protocol: report modifier keys using the kitty keyboard protocol
# (some terminals can then distinguish Shift+Enter)
XZH_KITTY_KEYS=1 xzh
```

Auto-approval is on by default (`autoApprove: true`), so all tools — including writing files and running commands — execute directly without asking; run `/auto off` to switch to per-item confirmation, and the setting is persisted to the config file.

`/switch <dir>` lets you change the project directory mid-conversation: relative paths resolve against the current directory and `~` expands; afterwards all file reads/writes and command execution target the new directory, and the conversation context is kept (run `/reset` if you want to clear it).

## Project structure

```
src/
├── cli/      Command-line entry point and commands
├── core/     Agent loop and prompts
├── llm/      LLM Provider abstraction and implementations
├── tools/    Terminal tool set (including list_skills / load_skill)
├── skills/   Skill discovery and loading
├── tui/      Full-screen terminal interface
├── config/   Config reading and writing
└── utils/    ANSI and path utilities
```

See [docs/ARCHITECTURE.md](https://github.com/amble311/xuanzhu/blob/main/docs/ARCHITECTURE.md) for details.

## Development

```bash
npm run build       # bundle to dist/cli.js
npm run dev         # watch mode
npm run typecheck   # type check
node bin/xzh.js     # run locally
```

### Publishing a new version

```bash
./release.sh                         # bump the patch number (0.1.4 → 0.1.5)
./release.sh minor                   # 0.1.4 → 0.2.0
./release.sh 1.0.0                   # specify a version
XZH_RELEASE_DRY_RUN=1 ./release.sh   # dry run first, writes nothing
```

The script performs, in order: **bump version → `npm publish` → wait for the registry to sync → commit and push to GitHub → update the local global install**.

A script is needed because this chain has several counter-intuitive spots: `npm publish` returning success does **not** mean the registry already sees the version (npm has a staging phase during which `npm view` / `npm install` report `notarget`), and the version number, the GitHub commit, and the npm package must all stay in agreement. The script chains them together and waits and retries automatically.

| Environment variable | Purpose |
| --- | --- |
| `XZH_RELEASE_DRY_RUN=1` | Dry run only: no version change, no publish, no push |
| `XZH_RELEASE_YES=1` | Skip the confirmation prompt before publishing |
| `XZH_RELEASE_SKIP_GIT=1` | Do not push to GitHub |
| `XZH_RELEASE_SKIP_LOCAL=1` | Do not update the local global install |
| `XZH_RELEASE_WAIT=<seconds>` | Upper bound for waiting on the registry sync (default 300) |

## Acknowledgements

This project stands on the open-source work of others. Special thanks to:

- **[CodeBuddy](https://github.com/olasunkanmi-SE/codebuddy)** — by
  [Oyinlola Olasunkanmi Raymond](https://github.com/olasunkanmi-SE).
  XuanZhu was adapted from that project (editor dependency removed, turned into a pure terminal form),
  and **retains its original copyright notice** as required by the MIT license.
- **[Playwright](https://github.com/microsoft/playwright)** — open-sourced by Microsoft.
  The built-in `playwright` skill uses it for browser automation and end-to-end testing.

Thanks also to every open-source project among the direct and indirect dependencies,
and to the many tools in the npm ecosystem (see `package.json` for the full list).

## License

MIT

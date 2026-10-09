# 玄猪 XuanZhu

[English](https://github.com/amble311/xuanzhu/blob/main/docs/README.en.md) | **中文**

> 专为终端打造的 AI 编码 Agent —— 一条 `xzh` 命令，把 AI 编程助手带进你的终端。

## 快速上手

```bash
npm i -g xuanzhu    # 安装（需要 Node.js ≥ 18）
xzh model           # 配置模型：选服务商、填 API Key
xzh                 # 启动
```

## 简介

玄猪是一个运行在终端里的全屏 AI Agent：它能读懂你的代码库、直接读写文件、执行命令、运行测试，
并用流式输出向你展示它的每一步思考与工具调用。内核采用了 codebuddy 的开源代码。

```
╭──────────────────────────────────────────────╮
│   玄猪 XuanZhu  ·  终端 AI 编码 Agent          │
╰──────────────────────────────────────────────╯
```

## 特性

- **全屏 TUI**：输出区 + 多行输入区 + 状态栏，纯 ANSI 实现，零额外 UI 依赖。
- **多模型支持**：DeepSeek、Anthropic Claude、OpenAI、Google Gemini、智谱 GLM、通义千问、Groq、Ollama，以及任意 OpenAI 兼容端点。
- **内置工具**：读取 / 写入 / 编辑文件、列目录、glob 查找、grep 搜索、执行 shell 命令。
- **流式响应**：实时渲染 Markdown，支持代码块，中文对齐正确。
- **默认全自动**：`autoApprove` 默认为 `true`，**所有工具都直接执行、不做任何确认** —— 包括写文件、执行命令、读取工作区之外的文件，以及读取凭据类文件（`~/.ssh`、`.env`、`~/.xzh/config.json` 等）。开箱即用，不打断。`/auto off` 可切换为写文件与执行命令逐项确认。
  - 如果希望读取凭据类文件时确认一次（防止密钥被读进上下文后转交给模型服务商），把 `confirmSensitiveRead` 设为 `true`，默认关闭。
- **多轮自主执行**：自动串联工具调用完成任务，可随时 `Ctrl+C` 中断。
- **任务拆分**：3 步以上的复杂任务会先用 `todo_write` 列出计划并逐步更新，
  顶部信息区实时显示进度条（`任务 2/5` 与当前进行项）。
- **子代理协作（可并行）**：需要大范围调研（跨多个文件 / 目录 / 命名约定）时，用 `task`
  派生 `code-explorer` 子代理独立完成，**只把结论带回主对话** —— 中间过程不会挤占主上下文。
  一轮里并列发出多个 `task` 时会**并发执行**（默认最多 4 个，见 `maxParallelAgents`）。
  子代理定义集中在 `src/subagents/`，可继续扩展。
- **长期记忆自动精简**：`MEMORY.md` 只追加、会越写越长；**达到阈值（默认 6000 字符）
  自动触发** —— 先去重，仍超限就裁剪最旧的条目（最新结论优先保留），无需模型同意。
- **图片输入**：`Ctrl+V`（或 `/image`）读取系统剪贴板里的图片作为附件发给模型，
  也支持拖拽图片文件路径；Linux / Windows / macOS 均可用。

## 环境要求

- Node.js >= 18
- 一个支持工具调用的模型（推荐 DeepSeek / Claude / GPT-4o 等）

## 安装

### 方式一：npm（推荐）

```bash
npm i -g xuanzhu    # 全局安装
xzh                 # 启动
```

不想全局安装，也可以免安装试用：

```bash
npx xuanzhu
```

> 若安装后提示 `xzh: command not found`，说明 npm 的全局 `bin` 目录不在 `PATH` 中，
> 见下方「PATH 配置」。

### 方式二：一键脚本

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/amble311/xuanzhu/main/install.sh | sh
```

**Windows（PowerShell）**

```powershell
iex (irm https://raw.githubusercontent.com/amble311/xuanzhu/main/install.ps1)
```

脚本会检查 Node.js 版本、全局安装 `xzh`，并在需要时提示补充 PATH。

**请勿使用 `sudo`**：脚本会检测并拒绝以 root 运行。以 root 安装会把 `bin` 下的文件属主
写成 root，之后普通用户升级或卸载都会失败。若全局目录确实不可写，脚本会给出用户级 prefix 方案：

```bash
npm config set prefix ~/.npm-global   # 然后确保 ~/.npm-global/bin 在 PATH 中
```

**脚本支持的环境变量**

| 变量 | 作用 |
| --- | --- |
| `XZH_PACKAGE` | 手动指定安装源（覆盖自动识别）：包名、`包名@版本`、git 仓库、本地 tarball 或目录 |
| `XZH_VERSION` | 指定版本，等价于 `xuanzhu@<版本>` |
| `XZH_NPM_ARGS` | 追加给 npm 的参数，如国内镜像 `--registry=https://registry.npmmirror.com` |
| `XZH_DRY_RUN=1` | 只打印将要执行的命令，不真正安装 |

### 方式三：从源码安装（开发用）

```bash
git clone https://github.com/amble311/xuanzhu.git
cd xuanzhu
npm install
npm run build
npm link          # 使 xzh 命令指向本地源码
```

改动源码后执行 `npm run build` 即生效（`npm link` 建立的是软链）。
想切回正式发布的版本：

```bash
npm unlink -g xuanzhu && npm i -g xuanzhu
```

### 环境要求

- **Node.js ≥ 18**
- **真实终端**：TUI 需要交互式终端，在管道、CI 或部分编辑器内置终端中无法运行
- 首次运行会在**当前工作目录**创建 `.xuanzhu/`（项目记忆与规则），建议写入 `.gitignore`

## 快速开始

```bash
# 1. 配置模型与服务商（交互式，可添加多个模型并设置调用权重）
xzh model

# 2. 启动玄猪（自动使用权重最高的模型）
xzh
```

在界面中输入你的任务，例如：

```
帮我看看这个项目是做什么的，然后给 package.json 加上 engines 字段
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `xzh` | 在当前目录启动全屏交互界面 |
| `xzh <目录>` | 在指定项目目录启动，例如 `xzh /home` |
| `xzh model` | 交互式管理多模型（新增 / 删除 / 调整权重 / 查看全部） |
| `xzh model list` | 列出**已配置**的模型与调用权重 |
| `xzh model all` | 列出**所有内置可用**的模型（按服务商分组，标注已配置项） |
| `xzh model add <provider> <model> [权重]` | 新增模型（默认权重 `10`） |
| `xzh model remove <id\|序号>` | 删除模型 |
| `xzh model weight <id\|序号> <权重>` | 调整模型的调用权重 |
| `xzh model context <id\|序号> <大小>` | 调整上下文窗口（token，如 `128000`） |
| `xzh model reset` | 把全部模型权重恢复为默认值 |
| `xzh config` | 查看当前配置（API Key 脱敏） |
| `xzh config edit` | 使用 `nano` 编辑配置文件 |
| `xzh config path` | 打印配置文件路径 |
| `xzh config init` | 生成默认配置文件 |
| `xzh setup` | 检查并自动安装依赖（玄猪自身 + 技能：playwright / officecli / 剪贴板工具等） |
| `xzh --help` | 查看帮助 |
| `xzh --version` | 查看版本 |

## 配置

配置文件位于 `~/.xzh/config.json`（权限 `600`）。可用环境变量 `XZH_HOME` 整体重定向 ——
它指向**全局目录本身**（不是家目录）：

```bash
XZH_HOME=/path/to/dir xzh          # 改用 /path/to/dir/config.json
```

适用于多环境并行（本机 / 远程 / 容器各持一份配置互不干扰）。设置后**不会**执行
`~/.xuanzhu` 的旧目录迁移 —— 那是为你显式指定的新位置，不该把家目录里的旧数据搬进去。

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
  "memoryMaxChars": 6000,
  "maxParallelAgents": 4,
  "intent": { "enabled": false },
  "providers": {
    "deepseek": {
      "apiKey": "sk-...",
      "model": "deepseek-chat"
    }
  }
}
```

> 旧版配置（只有 `provider` / `model`、没有 `models`）依然可用：会被视为一个权重为 `10` 的模型。

### 多模型与调用权重

`models` 可配置多个模型，每个模型带一个**调用权重**（默认 `10`）：

| 行为 | 说明 |
| --- | --- |
| 启动选择 | 优先加载**权重最高**的模型 |
| 调用失败 | 该模型权重 **-1**（`Ctrl+C` 主动中断不算失败） |
| 自动降级 | 若还有**尚未尝试过**的可用模型，切换到权重最高的那个并重试（单次请求内每个模型最多尝试一次，最多切换 3 次） |
| 不做空转 | 只有一个模型（或权重耗尽重置回它自己）时**不重试**，直接报错并附上当前模型信息 |
| 权重耗尽 | 当**所有模型权重都为 0** 时，在终端警告并把全部权重重置回 `10` |
| 配置错误不降权 | 密钥无效 / 无权限 / 模型名或端点不存在时**不扣权重、不写盘**，只提示检查配置 —— 配置不改就永远失败，扣权重只会把其他可用模型一起拖下水 |
| 上下文超限不降权 | 超出模型窗口时**收敛历史后自动重试**，也不扣权重（见上一节） |

```bash
xzh model                              # 交互式菜单
xzh model list                         # 查看已配置的模型与权重
xzh model all                          # 查看所有内置可用模型
xzh model add openai gpt-4o 20         # 新增（权重 20）
xzh model weight openai/gpt-4o 5       # 调整权重
xzh model context openai/gpt-4o 128000 # 调整上下文窗口（留空则自动推断）
xzh model vision openai/gpt-4o on      # 标注支持图片输入（推断不出来时用）
xzh model remove openai/gpt-4o         # 删除（id / 模型名 / 序号均可）
xzh model reset                        # 全部恢复默认权重
```

当前使用的模型与权重会显示在界面顶部与状态栏（如 `gpt-4o w6`），降级切换时输出区会给出提示。

### 上下文窗口的作用

`contextWindow` 不只是记录信息 —— 它决定**每次请求能带多长的历史**：

- 玄猪按 `contextWindow × 80%` 得出输入预算（余量留给本次回复与估算误差），
  再减去系统提示词的占用，剩下的额度给对话历史。
- 超出额度时采取**分层处理**：先压缩**老旧的大块工具输出**（保留头尾、砍掉中段），
  压缩后仍放不下才从最老的消息整条丢弃。这样不会为了腾空间而丢掉「用户最初提的要求」，
  却留着一条已经过期的 `ls` 结果。最近的对话始终优先保留；
  若某条消息自身就超预算，则截断它的正文，而不是整条丢弃。
- 未配置该值时会按模型名自动推断（`xzh model all` 与 `xzh model list` 会显示推断结果）。
  推断表只覆盖常见模型，小众或私有部署的模型名会退回保守的 32k ——
  若你的模型窗口更大，请用 `xzh model context <id> <大小>` 显式指定，
  否则历史会被裁得比必要得更短。

> 裁剪依据是**估算**的 token 数（中文约 1 字符/token，英文与代码约 3.5 字符/token），
> 不依赖 tokenizer，属保守近似。项目规则（`.xuanzhu/rules.md`）与 `systemPromptExtra`
> 会全文进入系统提示词，写得过长会挤占历史额度 —— 占去窗口一半以上时界面会给出提示。

若估算偏差导致仍然超限（服务端返回 `context_length_exceeded` 一类错误），玄猪会
**把预算收敛到一半再自动重试一次**，而不会把它当成模型故障去降权或切换模型 ——
换模型拿同样长的消息重发只会同样失败，还会白白扣掉权重。

### 意图分析（可选，默认关闭）

启用后，**每条消息都会先用模板包裹、向模型发起一次独立请求**，返回的分析结果再作为本次输入交给主流程。适合需求含糊时先让模型"猜准意图"。

三种开启方式：

```bash
xzh --intent            # 仅本次启动启用（不写回配置）
xzh --no-intent         # 仅本次启动强制关闭
```

配置文件 `intent.enabled: true`，或界面内 `/intent on`（会写回配置，状态栏出现 `⌁intent` 标记）。

默认模板（可在 `intent.prompt` 中自定义，用 `{{'用户发送过来的消息'}}` 占位）：

```
请分析下面消息的意图，以第一人称输出三段：【核心意图】一句话总结；【需求拆解】逐条列出明确需求；【隐性意图】潜在诉求。不要增加原文不存在信息。 消息： {{'用户发送过来的消息'}}
```

行为要点：

- 意图请求**不携带工具声明**，也不写入对话历史（保持主流程上下文干净）
- 分析结果会先展示在输出区（附原始消息），便于你确认它理解对了
- 失败或返回为空时**自动回退**为你的原始输入，不影响主流程，也不会因此降低模型权重
- 代价：每条消息多一次模型请求（token 消耗约翻倍），故默认关闭

API Key 也可以来自环境变量，优先级低于配置文件：

| Provider | 环境变量 |
| --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| GLM | `GLM_API_KEY` |
| Qwen | `DASHSCOPE_API_KEY` |
| Groq | `GROQ_API_KEY` |

## 支持的模型服务商

| Provider | 标识 | 默认模型 | 说明 |
| --- | --- | --- | --- |
| DeepSeek | `deepseek` | `deepseek-chat` | 默认选项 |
| Anthropic | `anthropic` | `claude-sonnet-4-5` | 工具调用能力强 |
| OpenAI | `openai` | `gpt-4o` | |
| Google | `gemini` | `gemini-2.0-flash` | |
| 智谱 | `glm` | `glm-4-plus` | |
| 通义千问 | `qwen` | `qwen-max` | |
| Groq | `groq` | `llama-3.3-70b-versatile` | 速度快 |
| Ollama | `ollama` | `qwen2.5-coder` | 本地运行，无需 Key |
| 自定义 | `custom` | — | 任意 OpenAI 兼容端点 |

## 内置工具

| 工具 | 作用 | 需确认 |
| --- | --- | --- |
| `list_skills` | 列出玄猪可用的全部技能 | 否 |
| `load_skill` | 加载指定技能的完整指南 | 否 |
| `memory_read` | 读取项目记忆（长期记忆 + 最近日志） | 否 |
| `memory_write` | 写入项目记忆（长期记忆 / 当日日志），长期记忆超限时自动精简 | 否 |
| `memory_compact` | 用精简后的完整内容重写长期记忆（语义压缩） | 否 |
| `todo_write` | 创建 / 更新任务列表（每次提交完整列表） | 否 |
| `task` | 派生子代理（默认 `code-explorer`）执行子任务，只返回结论；一轮内多个调用**并行**执行 | 否 |
| `read_file` | 读取文件（带行号，支持偏移与行数限制） | 否 |
| `list_dir` | 列出目录内容 | 否 |
| `glob` | 按 `**` / `*` / `?` 模式查找文件 | 否 |
| `grep` | 按正则搜索文件内容 | 否 |
| `write_file` | 覆盖写入文件 | 是 |
| `edit_file` | 精确文本替换 | 是 |
| `bash` | 执行 shell 命令 | 是 |

## 任务拆分与子代理

**任务拆分**：任务需要 3 步以上、或用户一次提出多项要求时，玄猪会先用 `todo_write`
把计划写成结构化列表，每完成一步就更新状态。列表显示在顶部信息区（`任务 2/5` +
进行中项），比"它说自己做到哪了"更可靠。

**子代理**：`task` 工具会**新建一个独立的 Agent 实例**去完成一件子任务，只有最终结论
回到主对话。用途是把"翻几十个文件"这类调研的中间过程隔离出去，避免主上下文被塞满。

**并行执行**：一轮回复里并列发出**多个** `task` 调用时，这些子代理会**并发运行**，
结果按原调用顺序回灌 —— 多路调研的总耗时取决于最慢的一路，而不是各条相加。
并发上限由 `maxParallelAgents`（默认 `4`）控制，设为 `1` 即退化为串行；硬上限 16。
有先后依赖的任务应分轮发起（下一轮才能看到上一轮结论）。

> 只有声明了 `parallelSafe` 的工具会进入并行批次（目前仅 `task`）。写文件、编辑、
> 执行命令这类工具有副作用且可能互相依赖，始终按顺序串行执行，不会被并行化。

内置一个子代理，通过 `subagent_name` 指定（默认即它）：

| 子代理 | 能力 | 何时用 |
| --- | --- | --- |
| `code-explorer` | **只读**（`read_file` / `list_dir` / `glob` / `grep` / `list_skills` / `load_skill`） | 跨多个文件、目录或命名约定的搜索；单次 `read_file` / `grep` 覆盖不了的探索 |

`task` 的参数：

| 参数 | 说明 |
| --- | --- |
| `description` | 子任务的一句话说明（界面显示 + 结果摘要） |
| `prompt` | 交给子代理的完整任务描述。**子代理看不到主对话**，必须自包含；`code-explorer` 还应在其中写明探索力度（`quick` / `medium` / `very thorough`） |
| `subagent_name` | 要派生的子代理名称，默认 `code-explorer` |

约束：子代理恒不提供 `task`（禁止无界递归）、`todo_write` 与 `memory_write` / `memory_compact`
（任务列表与记忆由主代理统一维护）。它的工具活动以 `[code-explorer: <任务说明>]` 前缀显示在
输出区 —— 并行时会交错，前缀里的任务说明用于区分是谁在输出；危险操作确认仍会转发给你
（并行时多个确认会**排队**逐个弹出，不会互相覆盖）。

> **扩展新的子代理**：在 `src/subagents/` 下实现 `SubAgentDefinition`（名称、给主代理看的
> 描述、工具白名单、系统提示词），再加进 `src/subagents/index.ts` 的 `SUBAGENTS` 数组即可。
> `task` 的参数枚举、可用工具与提示词都会自动跟随，无需改别处。

**触发时机不需要配置**：`task` 与其他工具一样**每次请求都会发给模型**（没有开关）。
但只靠提示词写「大范围调研时用它」是不够的 —— 模型判定不了「多大算大」，实测就是不调用。
因此除了把触发条件写成可判定的阈值（"预计要读 3 个以上文件 / 要反复 glob grep"），还加了一道
**确定性提醒**：当本轮只读调研累计达到 **8 次**或 **4 万字符**时，会在工具结果末尾追加一条
`[系统提醒]`（整轮只提醒一次，已在用子代理时不提醒），把「该委托了」直接摆到模型面前。

想确认某个工具到底有没有发出去：`/tools` 会列出本轮发给模型的全部工具及其说明。

**长期记忆自动精简**：`MEMORY.md` 只追加、会无界增长，而它每次启动都要注入提示词。
因此**达到 `memoryMaxChars`（默认 6000）就自动触发**，不需要模型同意：

- 先去除正文完全相同的重复块（无损）；
- 仍超限则**从最旧的块开始裁剪**（最新的结论优先保留）；
- 触发时机：会话启动、`/switch` 切换目录、以及每次 `memory_write`（scope=long）之后；
  精简结果会在输出区提示（如"长期记忆已自动精简（去除 2 条重复记录、裁剪 1 条最旧记录）"）。
- 设 `memoryMaxChars: 0` 表示不限制长度（此时只去重、不裁剪）。
- 自动裁剪无法解决"单条记录本身过长"（再裁就整条丢），这种情况会在提示词里要求模型用
  `memory_compact` 做语义压缩。

## 图片输入（Ctrl+V）

在输入框按 **Ctrl+V**（或 `/image`、`/paste`）会把**系统剪贴板里的图片**加为本轮附件，
输入框显示 `[图片1]` 占位；回车连同正文一起发给模型。退格删掉占位即取消该图片。

> **为什么不能"直接右键粘贴"**：终端与程序之间只有字节流，粘贴只能传**文本** ——
> 剪贴板里只有图片时，绝大多数终端在粘贴时**什么都不发送**，程序无从感知。
> 所以改由玄猪**主动读取系统剪贴板**。

| 平台 | 用到的工具 | 缺依赖时 |
| --- | --- | --- |
| Linux | `wl-paste`（Wayland，`wl-clipboard` 包）或 `xclip`（X11） | **自动安装**（弹一次确认；支持 apt / dnf / yum / pacman / zypper / apk） |
| Windows | 内置 PowerShell | 无需安装 |
| macOS | `pngpaste`，否则内置 `osascript` | 无需安装（有内置退路） |

Linux 上缺少剪贴板工具时，Ctrl+V 会**弹出确认框并自动安装**（会临时离开界面，以便输入 sudo
密码，装完自动回到界面）。也可以提前一次性装好：`xzh setup`（同时覆盖玄猪自身依赖与技能 CLI）。

- 终端把 Ctrl+V 当成自己的粘贴键时（如 Windows Terminal），`\x16` 到不了玄猪 —— 改用 `/image`。
- 剪贴板里没有图片时会**退化为普通文本粘贴**，不会吞掉内容。
- **拖拽图片文件到终端**同样支持：只要某一行**只有一个图片文件路径**，提交时会自动转成附件。
  这条通路不依赖任何终端协议，覆盖面最广。
- 单张图片上限 **5 MB**；超过则忽略并提示。
- **模型必须支持视觉**：`glm-4v` / `qwen-vl` / `gpt-4o` / `claude` / `gemini` 等。
  `xzh model list` 会给支持的模型标上「视觉」；推断不出来时用
  `xzh model vision <id> on` 手动标注。模型不支持时玄猪会**拒绝附加**，
  而不是发出去换一个 400（那会把整轮正文一起作废）。
- **自定义端点默认按"支持图片"处理**：`custom` provider 的模型名由你自己填，
  按名字推断必然失效 —— 若也拒绝，等于"自定义模型永远用不了图片"。
  若该端点其实不支持，请求会被服务端拒绝，此时玄猪会**识别出来并自动去掉图片重试一次**，
  你的正文不会被作废，并提示你 `xzh model vision <id> off` 彻底关掉（避免每次都白试一次）。
  `xzh model add` 会就这一点询问一次，也可以用第 5 个位置参数直接指定：
  `xzh model add custom my-model 10 128000 off`。
- 图片只在**本轮**随请求发送；历史里的旧图片会自动降级为 `[图片已省略：image/png]`，
  避免 base64 把上下文撑爆。

## 项目目录（.xuanzhu/）

首次在某个项目中运行 `xzh` 时，会在项目根自动创建 `.xuanzhu/`，用于保存**项目级记忆与规则**
（对应 CodeBuddy 的 `.codebuddy/memory/`）：

| 路径 | 用途 |
| --- | --- |
| `.xuanzhu/memory/MEMORY.md` | 长期记忆：稳定的项目结论与约定，启动时会注入系统提示词（节选） |
| `.xuanzhu/memory/YYYY-MM-DD.md` | 每日日志：按天追加的过程记录 |
| `.xuanzhu/rules.md` | 项目规则，内容作为「项目级指令」注入系统提示词。**首次初始化时若项目根已有 `AGENTS.md`**，则写入一条「必须严格按照 `AGENTS.md` 执行」的指令（而非复制其内容）—— 这样 `AGENTS.md` 始终是唯一真实来源，你改完它模型下次读取即是新版 |

记忆由玄猪自行维护：

- 启动时读取 `MEMORY.md` 与**当天的日志**注入提示词（各取节选），让玄猪一开始就了解项目背景
- 需要更多历史时调用 `memory_read`；**每完成一件实质工作后**必须调用 `memory_write` 记录结论
  （技术方案、项目约定、踩过的坑、重要发现）。这条要求同时写在系统提示词的「核心原则」里，
  明确要求**在给出最终答复前先写记忆** —— 此前措辞偏弱（「可调用」），实测几乎不会触发
- 长期记忆是**只追加**的，长期使用会越写越长，而它每次启动都要注入提示词（节选 1500 字符），
  过长会让重要结论被截断。因此**达到 `memoryMaxChars`（默认 6000 字符）即自动触发精简**
  （无需模型发起，时机见上面的"长期记忆自动精简"）：先去重，仍超限则裁剪最旧的块。
- 只有当**单条记录本身就超过上限**（自动裁剪删无可删）时，提示词才会要求模型
  `memory_read` 读全文、再用 `memory_compact` 重写为精简版本（合并同主题、删除过时条目）。
- `.xuanzhu` **始终**位于当前项目路径之下，**不做任何向上查找**：在 `/a/b/c` 工作就只用
  `/a/b/c/.xuanzhu`，即使 `/a` 或 `/a/b` 下已有 `.xuanzhu` 也不会复用
- **启动时**与 **`/switch` 切换目录时**，若该目录下尚无 `.xuanzhu`，会自动创建
- 因此每个项目目录各自拥有独立的记忆与规则；`~/.xzh` 仅作**全局配置目录**
  （config.json / 会话 / 日志 / 技能），不参与项目记忆

> 技能与 CLI 为**全局通用**：技能位于 `~/.xzh/skills`（叠加内置），CLI 安装在系统，均不受项目限制。

## 内置技能

技能是一份指导玄猪使用特定外部 CLI 工具的指南（`skills/<name>/SKILL.md`）。
当任务涉及某个领域时，玄猪会先 `list_skills` 查看可用技能、再 `load_skill` 加载完整指南
（加载时自动安装并验证其依赖），然后借助 `bash` 执行指南中描述的命令。

随包内置 18 个技能，常用如下：

| 技能 | 领域 | 依赖 |
| --- | --- | --- |
| `playwright` | 浏览器自动化、端到端测试、网页验证（**默认用系统已安装的 Chrome**，减少反爬拦截） | `playwright-cli`（`npm i -g @playwright/cli@latest`） |
| `officecli` | Word / Excel / PowerPoint 文档创建与读写 | `officecli`（单二进制，见技能内安装说明） |
| `github` / `gitlab` | 仓库、Issue、PR / MR | `gh` / `glab` |
| `jira` / `linear` | 项目管理 | 对应 CLI |
| `aws` / `kubernetes` | 云资源与容器编排 | `aws` / `kubectl` |
| `postgres` / `mysql` / `mongodb` / `redis` / `elasticsearch` | 数据库 | 对应客户端 |
| `sentry` / `datadog` | 监控与告警 | 对应 CLI |
| `gmail` / `email` / `telegram` | 邮件与消息 | 对应 CLI |

### 依赖自动安装

上表中的 CLI 由玄猪负责安装，**无需用户单独安装**：

- 在对话中加载技能时（`load_skill`），玄猪会先检测依赖；若缺失，请求一次确认后自动安装并验证。
- 也可主动运行 `xzh setup`，一次性检查并安装**玄猪自身依赖（剪贴板工具）与全部内置技能的依赖**。
  `xzh setup` 把终端交给安装命令，因此 `sudo` 能正常提示输入密码。

### 自定义技能

在 `~/.xzh/skills/<name>/SKILL.md` 放置自己的技能即可被自动发现（同名时覆盖内置技能）：

```markdown
---
name: my-skill
description: 一句话说明该技能的用途与适用场景
---

# my-skill

（指导模型如何使用该工具的正文）
```

## 界面布局

界面分为两栏，底部状态栏横跨全宽：

```
┌─────── 左栏（对话）─────┬──── 右栏（终端）────┐
│ 头部：品牌/模型/目录      │ 终端 · 工作目录      │
├────────────────────────┤                     │
│ 对话区（可滚动）          │ 命令输出（可滚动）    │
├────────────────────────┤ ──────────────────  │
│ 输入区                  │ ❯ 命令输入           │
├────────────────────────┴─────────────────────┤
│ 状态栏：模型 · 状态 · 当前焦点（对话▸/终端▸）    │
└──────────────────────────────────────────────┘
```

- **历史记录的视觉层次**：你的输入以绿底 `❯` 标记 + 亮绿加粗显示（多行输入用 `│` 续行），
  工具调用以品红 `⏺` 标记，玄猪的回答为无修饰正文——翻历史时一眼可辨
- 右侧是**终端面板**：直接执行 shell 命令（`ls`、`git status`、`npm test`…），输出实时显示
- `Shift+Tab` 在「对话输入」与「终端输入」之间切换焦点；有鼠标时**点击对应栏**也可切换
- 命令在当前项目目录下执行，`cd` 生效（面板自行维护工作目录）
- **`Tab` 补全**：命令位置补 `PATH` 中的命令，参数位置补文件路径（`cd` 只补目录）
  - 支持相对路径、`./`、`../`、绝对路径、`~`、引号包裹（`cat "src/tu`）以及 `VAR=路径`
  - 尾部空格会回退到上一个未完成的词（`cat src/tui/ ` + `Tab` 列出该目录内容）
  - 唯一匹配直接补全（目录补 `/`、命令与文件补空格）；多匹配先补公共前缀，再按一次列出候选
- 终端宽度不足 80 列时自动隐藏右侧面板，也可用 `/term` 手动开关
- 鼠标滚轮按指针所在区域生效：在右侧滚动命令输出，在左侧滚动对话区
- 命令经系统自带的 `script` 包装启动，为子进程分配 **PTY** ——
  因此**颜色、进度条、交互式提示都正常**（`npm init` 的提问、y/n 确认都能应答），
  命令运行期间的按键会转发给它
- 限制：仍**不支持 `vim` / `htop` / `less`** 这类全屏交互程序（没有真正的屏幕刷新与
  窗口尺寸协商），`export` 的环境变量也不跨命令保留（每条命令独立进程）

## 界面快捷键

| 按键 | 作用 |
| --- | --- |
| `Enter` | 提交输入 |
| `Alt+Enter` | 输入换行（终端原生编码，任何终端都可用） |
| `Ctrl+Enter` / `Shift+Enter` | 输入换行（需终端支持扩展键盘协议，见下） |
| `↑` / `↓` | 浏览历史输入（终端面板内为命令历史） |
| `Tab` | 终端面板内补全：命令名（PATH）或文件路径 |
| `PgUp` / `PgDn` | 上翻 / 下翻一页（左栏对话区、右栏终端输出） |
| `Shift+↑` / `Shift+↓` | 逐行上下滚动 |
| `Home` / `End` | 跳到最早 / 回到最新 |
| `Shift+Tab` | 切换焦点（对话 ⇄ 右侧终端） |
| 鼠标点击 | 焦点跟随点击的栏 |
| 鼠标滚轮 | 按区域滚动（左：对话区；右：终端输出） |
| `Ctrl+C` | 中断当前任务 / 清空输入 / 退出（空闲且输入为空时退出） |
| `Ctrl+D` | 结束本轮正在进行的对话（**任何情况下都不会退出玄猪**）；终端面板内为中断运行中的命令 |
| `Ctrl+L` | 清屏（终端面板内为清空命令输出） |

> `Ctrl+D` 只做「结束本轮对话」这一件事：没有对话在进行时按它不会有任何反应，也**永远不会退出界面**。
> 退出请用 `Ctrl+C`（空闲且输入为空时）或 `/exit`。

### 让 Ctrl+Enter / Shift+Enter 生效

程序启动时会向终端请求上报修饰键（xterm `modifyOtherKeys` level 2，退出时恢复），
但**多数 IDE 内置终端（VS Code / CodeBuddy / Cursor 等，xterm.js 内核）不实现该请求**，
`Ctrl+Enter`、`Shift+Enter` 与 `Enter` 发出的字节完全相同，任何终端程序都无法区分——
必须在 IDE 侧把这两个键绑定为可区分的序列。在 `keybindings.json` 中加入：

```json
[
  { "key": "shift+enter", "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "\u001b[13;2u" }, "when": "terminalFocus" },
  { "key": "ctrl+enter", "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "\u001b[13;5u" }, "when": "terminalFocus" }
]
```

`keybindings.json` 位置：VS Code / CodeBuddy 用 `Ctrl+Shift+P` → `Preferences: Open Keyboard Shortcuts (JSON)`，
或直接编辑 `<用户数据目录>/User/keybindings.json`。该绑定对该 IDE 的所有终端生效。

其他终端：xterm / VTE 系（gnome-terminal 等）由本程序自动协商，开箱可用；
kitty / Ghostty 会把该 xterm 兼容序列映射成「所有按键都用转义码上报」而破坏普通输入，
故玄猪对这两类终端不发送请求，请改用 `Alt+Enter` 或在终端侧自行配置。

界面内命令：`/help`、`/clear`、`/tools`、`/image`、`/copy [N|all]`、`/mouse`、`/reset`、`/cwd`、`/switch <目录>`、`/term`、`/model`、`/auto [on|off]`、`/intent [on|off]`、`/exit`。

### 选中与复制

在输出区**按住左键拖拽**，拖过要复制的行，**松开即写入系统剪贴板** —— 滚轮同时可用，互不影响。

| 方式 | 说明 |
| --- | --- |
| **在输出区拖拽** | 玄猪自己实现的选择（按整行）。松开即复制，不需按键、不占 `/mouse` |
| 按住 **Shift** 拖拽 | 使用**终端原生**框选（多数终端用 Shift 绕过应用级捕获），需要精确到字符时用 |
| `/copy [N\|A-B\|last\|all]` | 主动复制**左侧对话区**。支持 `/copy 100`（最近 100 行）、`/copy 100-200`（行号范围）、`/copy last`（最近一次对话）、`/copy all`（全部） |
| `/copy term [N\|A-B\|all]` | 主动复制**右侧终端输出**（默认最近 30 行） |
| `/mouse` | 切换鼠标捕获（默认**开启**：滚轮滚动输出区 + 拖拽选择）。关掉则把鼠标完全交还终端 |

> **为什么多行拖选会把两栏内容混在一起**：终端原生的选择是**矩形选择** ——
> 它只知道「从第几列到第几列」，**看不到应用的分栏**。所以从左侧拖到右侧、
> 或反向拖动时，同一个屏幕行上的两栏文字都会被纳入。这是协议层面的限制，
> 应用无法干预。
>
> 要复制**单栏**内容，用命令式复制（`/copy` 左栏、`/copy term` 右栏）——
> 它们按栏取内容，绝不会串栏。玄猪自己的拖拽选择（`/mouse` 开启时）也限定在左栏。
>
> 反之，若只想要终端原生的框选与右键菜单：按 `Shift` 拖拽临时绕过，
> 或用 `/mouse` 关闭捕获（此时滚动输出区改用 `PgUp`/`PgDn`）。

> **为什么拖拽选择要自己实现**：终端协议里的 `?1000h` 是**整体开关** ——
> 开启后终端把所有鼠标事件都交给程序，原生选择随之失效；关闭后滚轮又没用了
> （玄猪跑在**备用屏**上，终端没有回滚历史可滚）。既然事件已经在程序手里，
> 就由玄猪自己记录选区并写剪贴板，从而让「滚轮滚动」与「选中复制」并存。
>
> 选择按**整行**进行：输出区的长行会折行、还含 ANSI 颜色与宽字符，做字符级映射的
> 复杂度远高于收益，而实际要复制的基本都是整段内容。复制的是**原始逻辑行**
> （不是屏幕上折行后的样子），所以长行不会被截断。
>
> 以上都依赖终端支持 **OSC 52**。少数终端（如默认配置的 GNOME Terminal）出于安全会忽略它，
> 此时粘贴出来是空的 —— 请改用 Shift+拖拽，或终端自带的复制方式。

### 换行键为何有时不生效

玄猪通过终端协议请求「带修饰键的 Enter」（默认为 xterm 的 `modifyOtherKeys`），
但**部分终端并不实现它**——最典型是基于 xterm.js 的 IDE 内置终端（VS Code / CodeBuddy）。
这类终端会把 `Ctrl+Enter`、`Shift+Enter` 编成与普通 `Enter` **完全相同的字节**，
程序无从区分，因此无法把它们当作换行。

**`Alt+Enter` 走终端原生编码，任何终端都可用**，是最可靠的换行方式。

想弄清你的终端到底发了什么、或试用另一种上报协议：

```bash
# 诊断：把终端送来的原始字节记到 ~/.xzh/keys.log
XZH_DEBUG_KEYS=1 xzh
# 按几下 Ctrl+Enter / Shift+Enter，退出后查看
cat ~/.xzh/keys.log

# 备选协议：改用 kitty 键盘协议上报修饰键（部分终端据此可用 Shift+Enter）
XZH_KITTY_KEYS=1 xzh
```

默认开启自动批准（`autoApprove: true`），所有工具——包括写文件与执行命令——都会直接执行、不再询问；
执行 `/auto off` 可切换为逐项确认，设置会持久保存到配置文件。

其中 `/switch <目录>` 可在对话中切换项目目录：相对路径基于当前目录解析，支持 `~` 展开；
切换后所有文件读写与命令执行都会作用于新目录，且对话上下文保留（如需清空可执行 `/reset`）。

## 项目结构

```
src/
├── cli/      命令行入口与命令
├── core/     Agent 循环与提示词
├── llm/      LLM Provider 抽象与实现
├── tools/    终端工具集（含 list_skills / load_skill）
├── skills/   技能发现与加载
├── tui/      全屏终端界面
├── config/   配置读写
└── utils/    ANSI 与路径工具
```

详见 [docs/ARCHITECTURE.md](https://github.com/amble311/xuanzhu/blob/main/docs/ARCHITECTURE.md)。

## 开发

```bash
npm run build       # 打包到 dist/cli.js
npm run dev         # 监听模式
npm run typecheck   # 类型检查
node bin/xzh.js     # 本地运行
```

### 发布新版本

```bash
./release.sh                         # 版本尾号 +1（0.1.4 → 0.1.5）
./release.sh minor                   # 0.1.4 → 0.2.0
./release.sh 1.0.0                   # 指定版本
XZH_RELEASE_DRY_RUN=1 ./release.sh   # 先演练一遍，不做任何写入
```

脚本会依次完成：**版本号 +1 → `npm publish` → 等待 registry 同步 → 提交并推送 GitHub
→ 更新本机全局安装**。

之所以需要脚本，是因为这条链路有几个反直觉的地方：`npm publish` 返回成功**不等于**
registry 已可见（npm 有 staging 阶段，期间 `npm view` / `npm install` 会报 `notarget`），
而版本号、GitHub 提交、npm 包三者又必须保持一致。脚本把它们串起来并自动等待与重试。

| 环境变量 | 作用 |
| --- | --- |
| `XZH_RELEASE_DRY_RUN=1` | 只演练，不改版本、不发布、不推送 |
| `XZH_RELEASE_YES=1` | 跳过发布前的确认提示 |
| `XZH_RELEASE_SKIP_GIT=1` | 不推送 GitHub |
| `XZH_RELEASE_SKIP_LOCAL=1` | 不更新本机全局安装 |
| `XZH_RELEASE_WAIT=<秒>` | 等待 registry 同步的上限（默认 300） |

## 致谢

本项目站在前人的开源工作上，特别感谢：

- **[CodeBuddy](https://github.com/olasunkanmi-SE/codebuddy)** —— 作者
  [Oyinlola Olasunkanmi Raymond](https://github.com/olasunkanmi-SE)。
  玄猪由该项目改造而来（移除编辑器依赖、改为纯粹的终端形态），
  并依 MIT 许可**保留其原始版权声明**。
- **[Playwright](https://github.com/microsoft/playwright)** —— 由 Microsoft 开源。
  内置的 `playwright` 技能基于它实现浏览器自动化与端到端测试。

同时也感谢所有直接与间接依赖的开源项目，以及 npm 生态中的众多工具
（完整清单见 `package.json`）。

## License

MIT

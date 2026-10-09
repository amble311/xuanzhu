# 玄猪（XuanZhu）架构说明

> 本文档描述玄猪的当前架构。它是设计事实来源之一；修改代码时若与本文不一致，必须同步更新。

## 1. 定位

玄猪是一款**专为终端打造的 AI 编码 Agent**：

- 单一可执行入口 `xzh`，无编辑器依赖（不依赖 VSCode API）。
- 全屏 TUI 交互：输出区 + 输入区 + 状态栏。
- 直接读写本地文件、执行 shell 命令、搜索代码库。
- 通过可插拔的 LLM Provider 对接多家模型服务。

## 2. 分层结构

```
src/
├── cli/                 命令行入口与命令实现
│   ├── index.ts         参数解析 / 命令分发 / 启动 TUI
│   ├── prompt.ts        交互式输入、选择、确认
│   └── commands/
│       ├── model.ts     xzh model —— 多模型管理（新增 / 删除 / 权重）
│       └── config.ts    xzh config —— 查看 / 编辑 / 初始化配置
├── core/                Agent 核心
│   ├── agent.ts         多轮工具调用循环、历史管理、模型失败降级
│   └── prompt.ts        系统提示词
├── llm/                 LLM 抽象层（与 SDK 解耦）
│   ├── types.ts         ChatMessage（含 images）/ ToolSpec / StreamChunk / LLMProvider
│   ├── openai-compat.ts OpenAI 兼容协议实现（含流式 tool_calls 累加）
│   ├── anthropic.ts     Anthropic Claude 实现（含 tool_use 流）
│   ├── gemini.ts        Google Gemini 实现（含 function calling）
│   ├── context.ts       token 估算、历史裁剪、图片降级
│   ├── http.ts          非复用连接 Agent、瞬时错误判定与友好化
│   ├── vision.ts        模型是否支持图片输入的推断与标注
│   └── index.ts         Provider 注册表、校验、工厂
├── tools/               终端工具集
│   ├── types.ts         ToolDefinition / ToolResult / ToolContext / TodoStore / SubAgentInput
│   ├── filesystem.ts    read_file / list_dir / glob / grep / write_file / edit_file
│   ├── bash.ts          bash
│   ├── skills.ts        list_skills / load_skill
│   ├── memory.ts        memory_read / memory_write / memory_compact
│   ├── todo.ts          todo_write（任务列表）
│   ├── agent.ts         task（派生子代理，参数 subagent_name）
│   └── index.ts         TOOLS 注册表、统一执行入口与子代理工具集
├── subagents/           子代理注册表（定义各自的工具白名单与系统提示词）
│   ├── types.ts         SubAgentDefinition / SubAgentContext
│   ├── code-explorer.ts code-explorer —— 只读代码库探索子代理
│   └── index.ts         SUBAGENTS 注册表与查找（新增子代理只需改这里）
├── skills/              技能发现与加载（内置技能位于仓库 skills/，构建后复制到 dist/skills）
│   ├── index.ts         技能发现与加载
│   ├── dependencies.ts  依赖声明（技能 CLI + 玄猪自身的剪贴板工具）与包管理器安装命令
│   └── installer.ts     依赖检测 / 安装 / 复核（管道与继承终端两种执行方式）
├── tui/                 全屏终端界面（零第三方依赖，纯 ANSI）
│   ├── app.ts           终端控制、按键处理、焦点管理、渲染、确认对话框
│   ├── terminal.ts      右侧终端面板（命令执行、输出缓冲、cd 维护）
│   └── markdown.ts      流式 Markdown 行渲染
├── workspace/index.ts   项目级工作区（<项目>/.xuanzhu：memory/ + rules.md）
├── config/store.ts      配置读写（~/.xzh/config.json）与多模型权重
└── utils/
    ├── ansi.ts          颜色、显示宽度、折行
    ├── clipboard.ts     读取系统剪贴板图片/文本（Linux/Windows/macOS）+ 图片魔数嗅探
    ├── concurrency.ts   mapWithConcurrency —— 固定并发度的 worker 池
    └── paths.ts         路径与配置目录
```

## 3. 运行时数据流

```
用户输入
   │
   ▼
TuiApp.submit()
   │
   ▼
Agent.run(text) ──► LLMProvider.chat({ messages, tools })
   │                        │
   │                        ├── text 增量 ──► MarkdownRenderer ──► 输出区
   │                        └── tool_call ─┐
   │                                       ▼
   │                        需确认且未自动批准？──是──► 确认对话框（y/n）
   │                                       │否/已批准
   │                                       ▼
   │                             executeTool() ──► ToolResult
   │                                       │
   └──────────── 结果作为 tool 消息回灌 ◄──┘
                     （循环直到无工具调用或达到 maxToolRounds）
```

## 4. Agent 循环

`Agent` 维护一个 `ChatMessage[]` 历史：

0. **意图分析（可选，默认关闭）**：若 `config.intent.enabled` 为真，先发起一次**独立请求**
   （`Agent.analyzeIntent()`）：用模板（`buildIntentPrompt()`，占位符 `{{'用户发送过来的消息'}}`）
   包裹用户消息，取返回正文作为本轮输入。该请求**不携带工具声明、不写入对话历史**，
   失败或返回为空时回退原始输入，且**不参与模型降权**（辅助请求，避免与主请求重复降权）。
   开关来源：配置 `intent.enabled` / CLI `--intent`|`--no-intent`（仅本次运行）/ 界面 `/intent on|off`（写盘）。
1. 追加用户消息。
2. 调用 Provider 流式生成，收集正文与工具调用。
3. 若无工具调用 → 结束本轮。
4. 若工具标记了 `requiresConfirmation` 且当前**未开启**自动批准（`autoApprove: false`）→ 请求用户确认；
   默认 `autoApprove: true`，所有工具直接执行。
5. 执行工具，把结果作为 `role: "tool"` 消息追加。工具可读写会话状态：
   `todo_write` 维护 `Agent.todos`（经 `onTodos` 通知界面），`task` 派生子代理
   （见「工具系统 → 子代理」）。**连续的 `parallelSafe` 调用会并发执行**
   （目前只有 `task`），结果仍按原顺序回灌。
6. 回到第 2 步，最多 `maxToolRounds`（默认 200）轮；用尽时不硬性中断，而是经
   `onRoundLimit` 询问用户是否追加配额（非交互场景直接收尾）。
7. 历史按 **token 预算**裁剪（`trimMessagesToBudget()`），先压缩老旧的大块工具输出、
   再从最老的消息整条丢弃，并保持 tool 消息与其 assistant 消息配对；
   另有一道 `MAX_HISTORY_MESSAGES`（400 条）的安全网。

工作目录可在启动时指定（`xzh <目录>`），也可在对话中用 `/switch <目录>` 切换。
`Agent.setCwd()` 会同时更新工具上下文（`ToolContext.cwd`）与系统提示词中的目录信息，
对话历史保留不重置。

## 5. LLM Provider 抽象

`LLMProvider` 只有一个方法：

```ts
chat(options: ChatOptions): AsyncIterable<StreamChunk>
```

`StreamChunk` 为 `text` / `reasoning` / `tool_call` / `done` 四种事件，
使上层无需关心具体 SDK 的流式事件差异。

新增 Provider 的步骤：

1. 在 `src/llm/` 下实现 `LLMProvider`（或复用 `OpenAICompatProvider`）。
2. 在 `src/llm/index.ts` 的 `PROVIDERS` 注册元数据（默认 baseUrl、模型列表、环境变量名）。
3. 在 `createProvider()` 的 `switch` 中接入。

### 连接与重试（稳定性设计）

- **禁用连接复用**：OpenAI 兼容 Provider 使用 `keepAlive: false` 的 HTTP Agent（见 `src/llm/http.ts`）。
  原因：openai SDK 默认创建全局共享、`keepAlive: true`、`timeout: 5 分钟` 的连接池；
  当网络路径上存在代理（如本地 Clash / V2Ray）或服务端在空闲后关闭长连接时，
  复用一个"半关闭"的 socket 会在读取响应流时抛出 `Premature close`
  （Node 的 `ERR_STREAM_PREMATURE_CLOSE`）。
- **参数兼容**：流式请求不发送 `stream_options`，因为部分 OpenAI 兼容端点不支持该参数，
  可能导致连接被服务端异常终止。
- **自动重试**：所有 Provider 在**尚未向调用方输出任何内容**前，对瞬时网络错误
  （`Premature close`、`ECONNRESET`、`socket hang up`、超时、HTTP 5xx/429 等）
  自动重试最多 3 次，退避 600ms / 1200ms。一旦已有输出则不再重试，避免重复内容。
- **错误呈现**：底层异常经 `friendlyError()`（`src/llm/http.ts`）转换为中文提示；
  重试过程通过 `ChatOptions.onRetry` 回调，在界面状态栏展示 "网络中断，正在重试 (n/3)"。

### 图片输入（多模态）

`ChatMessage` 增加可选字段 `images?: ImageAttachment[]`（`{ mimeType, data(base64) }`），
而**不改** `content: string` —— 字符串 content 被历史裁剪、token 估算、日志、子代理报告等
大量逻辑依赖，改成多部分联合类型会牵动整条链路；图片只在两处需要特殊处理：

1. **Provider 转换**（`toOpenAIMessage` / `toAnthropicMessages` / `toGeminiContents`）：
   带图时把 user 消息的 content 换成分片数组，无图时仍是纯字符串（保持旧行为）。
   各家的包装形式不同：OpenAI `{type:"image_url", image_url:{url:"data:…"}}`、
   Anthropic `{type:"image", source:{type:"base64", media_type, data}}`（media_type 只认
   png/jpeg/gif/webp，其余由 `normalizeAnthropicMediaType` 退回 png）、
   Gemini `{inlineData:{mimeType, data}}`。
2. **token 估算**（`estimateMessageTokens`）：图片不参与文本分词，按
   `IMAGE_TOKENS_ESTIMATE`（1600）的固定值保守估算 —— 不解析图片头去算尺寸，因为
   低估会把请求顶到窗口上限，而高估只是让历史早一点被裁剪。

**旧图片降级**（`stripStaleImages`）：图片以 base64 携带，成本随轮次线性叠加，
所以每次组装请求时只保留**最后一条**带图片的消息，更早的替换成
`[图片已省略：image/png]`。

**入站**（TUI → 附件）：终端只能传文本，剪贴板里只有图片时多数终端粘贴时什么都不发，
因此由 TUI 主动读系统剪贴板（`src/utils/clipboard.ts`，见目录树）。三条通路：

- `Ctrl+V` / `/image` → `readClipboardImage()`（Linux `wl-paste`/`xclip`、Windows PowerShell、
  macOS `pngpaste`/`osascript`，按序尝试，用魔数嗅探确认确实是图片）；
- 剪贴板无图片时退化为 `readClipboardText()`，等价于常规文本粘贴；
- 提交时若某一行**只有一个图片文件路径**（拖拽进来的形态），自动转成附件。

附件在输入框里以 `[图片N]` 占位标记表示，侧表 `pendingImages` 保存实际数据；
提交时 `takePendingImages()` 按标记取出并清除未被引用的附件 —— 这样光标移动、退格、
历史回看等既有输入逻辑一行都不用改。

**视觉能力**（`src/llm/vision.ts`）：判定顺序为 **显式 `ModelEntry.vision` → `custom`
provider 默认支持 → 否定关键词 → 肯定关键词 → 默认不支持**（`xzh model vision <id> on|off`
可标注，`xzh model add` 也会询问一次）。除 `custom` 外**默认按不支持处理** ——
粘贴图片时直接拒绝并给出可操作提示，而不是发出去换一个 400 把整轮正文一起作废。

`custom`（任意 OpenAI 兼容端点）之所以例外：它的模型名由用户自填，按名字推断必然失效，
全部拒绝等于「自定义模型永远用不了图片」。放行之后由**自动降级**兜底：

- `isVisionUnsupportedError()`（`src/llm/http.ts`）识别服务端「不支持图片」的拒绝 ——
  仅在 4xx 范围内判定，先匹配显式模式（各家措辞差异大），再要求「提到图片」且
  「提到不支持」同时成立，避免把「图片格式非法」这类错误也当成模型不支持而静默丢图；
- `streamAssistant` 命中后以 `stripAllImages()` 去掉全部图片**重试一次**
  （`dropImages` 参数保证不会反复重试），并提示用户 `xzh model vision <id> off` 彻底关闭。
- 这一步必须放在 `handleModelFailure` **之前**：它不是模型故障，降权与切换模型都没有意义
  —— 换个模型拿同样的图片再发一次可能同样失败，只会白扣权重。

## 6. 工具系统

每个工具是一个 `ToolDefinition`：

```ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;        // 传给模型的 JSON Schema
  requiresConfirmation?: boolean; // 是否需用户确认
  danger?: boolean;               // 危险操作（仅在确认框中以醒目样式提示）
  parallelSafe?: boolean;         // 可与其它可并行工具同时执行（默认 false）
  execute(args, ctx): Promise<ToolResult>;
}
```

`parallelSafe` 默认 `false`：多数工具有副作用或互相依赖，必须按顺序跑。只有
「不共享任何可变状态」的工具才设为 `true` —— 目前仅有 `task`（每个子代理是独立的
`Agent` 实例，Provider 本身也无请求态，所以并发调用互不干扰）。

新增工具：在 `src/tools/` 实现后加入 `TOOLS` 数组即可，`getToolSpecs()` 会自动生成模型所需的工具声明。
`findTool()` / `getToolSpecs()` / `executeTool()` 都接受一个可选的工具集合，默认是全部 `TOOLS`
—— 子代理正是借此拿到受限的工具集（见下）。

### 任务列表（todo_write）

`todo_write` 采用「每次提交**全量**列表」的语义（`{content, status}[]`，状态为
`pending` / `in_progress` / `completed` / `cancelled`，同时只允许一个 `in_progress`）。
工具本身无状态，列表挂在 `Agent.todos` 上，通过 `ToolContext.todos`（`TodoStore`）读写；
写入时 `Agent` 经 `AgentEvents.onTodos` 通知界面，TUI 在**顶部信息区**显示
`任务 2/5` 与当前进行项（只展开前 3 项，其余以计数压缩，避免挤占头部空间）。
`Agent.reset()`（`/clear`）会一并清空列表。

### 记忆精简

长期记忆（`MEMORY.md`）是**只追加**的，长期使用会无界增长，而它每次启动都要注入提示词。
因此设阈值 `config.memoryMaxChars`（默认 `6000`，见 `workspace` 的 `DEFAULT_MEMORY_MAX_CHARS`），
**达到阈值即自动触发**，不依赖模型主动调用：

1. **自动层**（`compactLongTermMemoryIfNeeded()`，确定性、无需模型参与）：
   - 未超阈值 → 直接返回 `null`，**不读内容、不改文件**；
   - 超阈值 → 先去除正文完全相同的重复块（无损），仍超限则从**最旧的块**开始裁剪
     （最新结论优先保留），仅在确有变化时原子重写文件。
   - 触发点：`Agent.composeSystemPrompt()`（会话构造 / `setCwd()`）与 `memory_write`
     （scope=long）写入之后。精简结果经 `Agent.pendingMemoryNotices` 攒起来、
     在首轮 `run()` 时提示（构造发生在终端接管之前，不能当场写输出区）。
   - `memoryMaxChars <= 0` = 不限制长度：仍然去重，但不裁剪。
2. **语义层**（模型参与）：只有当**单条块本身就超限**（裁剪至少要保留一条、删无可删）时，
   系统提示词才追加「⚠ 长期记忆仍然过长」段落，要求模型 `memory_read` 读全文、
   再用 `memory_compact` 提交精简后的完整版本（合并同主题、删除已过时条目）。

> 分工的原因：去重与裁剪是确定性的、不该交给模型（也不该等模型「想起来」）；
> 而「哪些内容已经过时」只有模型能判断，因此保留语义层作为兜底。

### 子代理（task）

`task` 工具派生一个**新的 `Agent` 实例**执行子任务，只把最终答复作为工具结果回灌主对话。
具体派谁、给什么工具与提示词，全部来自 `src/subagents` 的注册表（`findSubAgent(name)`）。

实现要点（`Agent.spawnSubAgent()`）：

- **上下文隔离**：子代理的正文不进主对话（`onText` 只累积、不渲染），只有最后的报告
  以 `ToolResult` 返回（超长时按 `MAX_SUBAGENT_REPORT_CHARS` 截断）—— 这是它存在的意义：
  几十屏的调研过程不挤占主上下文。
- **受限工具集**：`toolsForSubAgent(definition.toolNames)` 按子代理声明的白名单过滤 `TOOLS`，
  并**恒排除** `SUBAGENT_FORBIDDEN_TOOLS`（`task` 防无界递归；`todo_write` 与
  `memory_write` / `memory_compact` 因任务列表与记忆归属主会话）。
- **独立系统提示词**：由子代理定义自己提供（`definition.systemPrompt()`），
  而不是主提示词的变体 —— 例如 `code-explorer` 会声明只读并解释探索力度分级。
- **事件转发**：子代理的工具活动以 `[<子代理名>: <任务说明>]` 前缀走 `onNotice` 显示
  （并行时输出会交错，前缀里的任务说明用于区分来源）；危险操作确认**转发给主代理**，
  不因在子代理内而绕过；轮次用尽时 `onRoundLimit` 直接返回 false（子代理无法与用户交互），
  以已有内容收尾。

**并行执行**（`Agent.run()` 的工具循环）：

- 循环改成 `while (index < toolCalls.length)`：把**连续的、`parallelSafe` 为真的**调用
  收成一个批次并发执行，其余逐个串行。批内要求签名互不相同（同一消息里并列同一调用
  没有意义，且会与重复检测的计数语义打架）。
- 并发通过 `mapWithConcurrency(calls, this.parallelLimit(), ...)`（`src/utils/concurrency.ts`）：
  worker 池而非 `Promise.all(map)`，避免模型一口气返回 10 个 task 时同时开出 10 条对话流
  撞上速率限制。结果**按原调用顺序**回灌 —— `tool` 消息必须与 `assistant.tool_calls` 一一对应。
- 并发上限：`config.maxParallelAgents`（默认 4），经 `parallelLimit()` 夹到 `[1, 16]`；
  `1` 即退化为串行。
- 批次内单个调用抛错不影响整批（转为失败结果）；`aborted` 后整批收尾走 `commitPartialTurn()`。
- **确认串行化**：并行子代理可能同时请求确认，而 TUI 只有一个确认槽。`TuiApp.requestConfirm()`
  因此把请求串成一条链排队 —— 否则后到的会覆盖先到的 `resolve`，前一个 Promise 永不兑现，
  整个批次挂死。
- 死循环检测与自我修正逻辑保持不变；被跳过的调用一律用 `Agent.skipToolCalls()`
  补齐 `tool` 结果（原先只补当前一条，若一轮含多个调用会留下配不上的 `tool_calls`，
  下一次请求会被服务端 400 拒绝 —— 顺带修掉了）。

**触发率**（为什么还需要它）：`task` 与其他工具一样**每次请求都会发给模型**（无开关，
见「工具系统」的 `getToolSpecs()`），但工具描述里写「大范围调研时用它」属于**主观判断** ——
模型判定不了「多大算大」，实测表现就是全程自己 `read_file`/`grep`、子代理从不被调用。
因此除把触发条件写成可判定的阈值（「预计要读 3 个以上文件 / 要反复 glob、grep」）之外，
`Agent.run()` 还维护本轮的只读调研累计量（`EXPLORATION_TOOLS` 的调用次数与输出字符数），
首次超过阈值（8 次 / 40k 字符）时在该次工具结果**末尾追加**一条 `[系统提醒]`，
把「可改用子代理」明确摆到模型面前。约束：整轮只提醒一次；本轮已经调用过 `task` 时不再提醒
（它已经在用了，再提示只会是噪音）。

这是「**确定性触发 + 软引导**」的组合：触发条件是客观的、必然发生，是否采纳仍由模型判断 ——
比纯提示词可靠，又不像强制路由那样剥夺模型的选择权。

`Agent` 通过构造参数 `AgentOptions { tools?, systemPrompt? }` 支持这两项定制，主代理不传即用默认。

**新增子代理**：在 `src/subagents/` 实现 `SubAgentDefinition`（`name` / `description` /
`toolNames` / `systemPrompt`）并加进 `SUBAGENTS` 数组。`task` 的 `subagent_name` 枚举、
工具白名单与提示词都会自动跟随，无需改动 `tools/` 或 `core/`。

### 技能系统（Skills）

技能是一份指导模型使用某个**外部 CLI 工具**的指南，存放于 `skills/<name>/SKILL.md`。

- **发现**：`src/skills/index.ts` 扫描两个全局来源并解析 frontmatter 的 `name` / `description`，
  同名时用户技能（`~/.xzh/skills`）覆盖内置技能（`dist/skills`）。技能不做项目级隔离。
- **项目级工作区**：`src/workspace/index.ts` 的 `resolveProjectPaths(cwd)` **固定**返回
  `<cwd>/.xuanzhu`，**不做任何向上查找**——项目记忆与规则严格归属用户指定的项目路径，
  上级目录即使已有 `.xuanzhu` 也不复用。启动与 `/switch` 切换目录时，若该目录下尚无
  `.xuanzhu` 则自动创建，仅承载**项目记忆与项目规则**。细节：
  - `memory/MEMORY.md`（长期记忆）与 `memory/YYYY-MM-DD.md`（每日日志）由 `memory_read` /
    `memory_write` 工具读写，长期记忆还可由 `memory_compact` 整体重写（见「记忆精简」）；
    `Agent.composeSystemPrompt()` 在构造与 `setCwd()` 时读取并注入提示词（节选 1500 字符）。
  - `rules.md` 内容作为项目规则追加进系统提示词。
- **使用**：模型通过 `list_skills` 查看可用技能，通过 `load_skill` 加载 `SKILL.md` 全文，
  再借助 `bash` 执行指南中描述的命令。技能指南在对话中持续有效，无需重复加载。
- **构建**：esbuild 的 `copy-skills` 插件在构建结束时把仓库根目录的 `skills/` 复制到 `dist/skills`，
  使打包产物自带技能。
- **约定**：技能目录名即技能名；技能文件兼容 `SKILL.md` 与 `skill.md` 两种命名。
- **内置技能**：18 个，涵盖 playwright（浏览器自动化）、officecli（Office 文档）、
  github / gitlab、jira / linear、aws / kubernetes、数据库、监控与消息类。
- **依赖自动安装**：`src/skills/dependencies.ts` 以 TS 常量声明每个技能所需的 CLI
  （检测命令、各平台安装命令、postInstall）；`src/skills/installer.ts` 负责检测、安装与安装后复核。
  同一套机制也承载**玄猪自身的依赖**（`runtimeRequirements()` / `clipboardRequirements()`）——
  目前是 Linux 读取系统剪贴板所需的 `xclip`（X11）或 `wl-clipboard`（Wayland），
  按 `WAYLAND_DISPLAY` 二选一（多装一个只是多一份失败面，而 `readClipboardImage()` 本来就会两者都试）。
  macOS / Windows 有内置通路，不声明任何依赖。
  `load_skill` 在加载前自动确保依赖就绪（缺失时经 `ToolContext.confirm` 请求用户确认一次），
  `xzh setup` 可一次性预装全部依赖。

  **两种执行方式**（`installer.ts`）——这决定了 `sudo` 能不能用：

  | 方式 | stdio | 用途 | 命令里的 sudo |
  | --- | --- | --- | --- |
  | `runShell()` | 全部管道 | TUI 内安装、非交互场景 | 走 `[ -t 0 ]` 判定 → 无终端则 `sudo -n` **快速失败**，不会挂住等密码 |
  | `runShellInteractive()` | `stdio: "inherit"` | `xzh setup`、TUI 挂起后安装系统包 | 有终端 → 普通 `sudo`，正常提示密码 |

  安装命令自身用 `[ -t 0 ]` 在两种模式间自动切换（见 `linuxInstall()`），因此**同一份命令字符串**既能跑管道也能跑交互。
  Linux 安装命令还会按 `command -v` 自动识别包管理器（apt / dnf / yum / pacman / zypper / apk）。

  TUI 缺剪贴板工具时（`pasteFromClipboard` 拿到 `unavailable`）会弹一次确认框，
  确认后 `suspendUi()`（退出备用屏 + 关原始模式）→ `runShellInteractive()` →`resumeUi()`
  （重新接管终端并强制整屏重绘，重置 `lastPhysicalCount` 以免视口锚定算错）。
  挂起期间 `render()` 直接返回，否则界面输出会与安装输出互相踩踏。

## 7. 配置

- 路径：`~/.xzh/config.json`（权限 `600`，全局唯一一份；由旧 `~/.xuanzhu` 自动迁移）。
- API Key 也可来自环境变量（如 `DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`），优先级低于配置文件。
- `xzh config` 展示时对 Key 脱敏；`xzh config edit` 调用 nano 编辑原始文件。

### 多模型与调用权重

配置中的 `models: ModelEntry[]` 承载多模型与权重（`id = <provider>/<model>`，`weight` 默认 `10`）：

- **兼容旧配置**：`models` 为空时 `effectiveModels()` 把 `provider` / `model` 视为一个默认权重模型。
  任何「先改 provider/model、再操作 models」的流程都必须先调用 `materializeModels()` 固定列表，
  否则兼容回退会取到新值（早期实现正是因此丢失过模型）。
- **选择**：`pickModel()` = `rankedModels()[0]`，即权重最高者（同权重按配置顺序）。
- **降权**：`decayModelWeight(config, id)` 令权重 -1（下限 0）；若**全部**模型权重变为 0，
  则把全部权重重置为 `DEFAULT_MODEL_WEIGHT` 并返回 `reset: true`。
- **降级重试**：`Agent.streamAssistant()` 捕获非中断错误后调用 `handleModelFailure()`：
  降权 → 写回配置 → 选出下一个可用模型 → 用 `createProvider(config, entry)` 重建 provider → 重试。
  三条约束（缺一都会导致「空转」）：
  1. 仅在**尚未产出任何内容**（`produced === false`）时重试，避免重复输出；
  2. `handleModelFailure` 接收本次请求的 `tried: Set<modelId>`，`pickModel(config, tried)` 会跳过
     已尝试过的模型 —— **每个模型在一次请求内最多尝试一次**；
  3. 若选出的仍是当前模型（只有一个模型，或权重耗尽重置回它自己），**直接返回 false 不重试**：
     认证失败 / 模型名不存在 / baseUrl 错误这类配置问题用相同参数重试必然再次失败，
     只会白白消耗权重并让用户长时间等待。
  单次请求最多切换 `MAX_MODEL_SWITCHES`(3) 次；`Ctrl+C` 主动中断不计为失败。
- **启动兜底**：`startChat()` 若发现全部权重为 0（例如手工改坏配置），直接重置并提示。
- **界面反馈**：权重变化与切换通过 `AgentEvents.onModelChange` / `onNotice` 呈现，
  顶部与状态栏显示当前模型及权重（如 `gpt-4o w6`）。
- **序号语义**：`xzh model list` 按权重降序展示，`remove` / `weight` 的序号参数按**同一顺序**解析
  （`resolveModelKey` 优先精确匹配 id、再模型名、最后才是序号）。

## 8. 界面渲染

- 使用 ANSI 转义序列实现：交替屏幕缓冲（`?1049h`）、光标定位与隐藏、行清除。
- 输入为 raw mode 逐键处理，自行解析方向键 / PgUp / PgDn / 控制键。
- 输入解析对**转义序列分片**做容错：不完整前缀（如只收到 `\x1b` 或 `\x1b[`）会等待最多 40ms
  再判定——确为单独 ESC 才按 ESC 处理，其余不完整序列直接丢弃，避免残留字节被当作输入插入
  （终端与输入法在 pty 上分片发送时常见）。
- **扩展按键归一化**（`normalizeKey`）：Enter 系按键在不同终端下的编码完全不同，统一成本应用既有
  语义（`\r` 提交、`\n` 换行、`\x1b[Z` 切换焦点）。支持的来源：
  - `ESC CR`：legacy 终端的 `Ctrl+Enter`（xterm 系同时用它表示 `Alt+Enter`）；
  - `CSI 13;<mod>u`：kitty 键盘协议（report-all-keys 模式）下的 `Shift` / `Ctrl+Enter`；
  - `CSI 27;<mod>;13~`：xterm `modifyOtherKeys` 下的 `Shift` / `Ctrl+Enter`（含 `Alt` 等组合）；
  - 裸 `CSI 13u`、`CSI 13;<mod>u` 的 Tab（`9`）与退格（`8`/`127`）同样归一。
  同时把上报模式下的 `Ctrl+字母/符号` 还原回控制字符（`CSI 27;5;<code>~`、`CSI <code>;5u` → `0x01`…`0x1f`），
  否则开启上报后 `Ctrl+C` / `Ctrl+A` / `Ctrl+E` / `Ctrl+J` / `Ctrl+L` 会全部失效；无法映射的序列原样返回并被忽略。
- **上报协商**：启动时发送 `CSI > 4 ; 2 m`（xterm `modifyOtherKeys` level 2），退出时用 `CSI > 4 m`
  把该资源还原为终端初始值。多数终端默认把 `Shift+Enter` 与 `Enter` 编成同一个 `\r`，不协商就无法区分；
  而 kitty / Ghostty 会把这条 xterm 兼容序列映射到自家的 progressive enhancement 协议
  （level 2 ≈「所有按键都用转义码上报」，连普通字母都会变成 `CSI <code>u`）从而破坏输入，
  故 `extendedKeyRequest()` 对这两类终端（`KITTY_WINDOW_ID` / `TERM` / `TERM_PROGRAM`）跳过。
  不识别该序列的终端（如 xterm.js 内置终端）会直接忽略，无副作用；这类终端需要用户侧为该键
  绑定发送 `ESC [ 1 3 ; 2 u`（README 有 VS Code 示例）。
- 交替屏幕下启用鼠标上报（`?1000h` + `?1006h`）并解析 SGR 序列 `\x1b[<按钮;列;行M`：
  左键点击切换焦点（对话 ⇄ 终端），滚轮按指针所在列映射为左栏对话区或右栏终端的滚动。
  **滚轮分支必须先于「左键单击」判断**：滚轮按钮码为 64(上翻)/65(下翻)，其低位 `button & 3`
  与左键同为 0；若先判 `(button & 3) === 0`，上翻会被误判为点击并 `return`，表现为
  「只能向下、永远回不到历史聊天」（下翻又受 `maxScroll` 夹紧，看起来像完全不能滚动）。
  左键分支另需排除拖拽移动位（`button & 32`）。
- 关闭终端自动换行（`?7l`）并对状态栏做宽度兜底截断：任何一行的宽度计算误差都不会导致折行，
  从而避免因折行触发整屏滚动而造成的「内容重复 / 光标错位」。
- 显示宽度计算支持全角字符（中文占 2 列）。
- 渲染节流：状态变化合并到 ~16ms 一次重绘，避免闪烁。
- **Markdown 行渲染**（`src/tui/markdown.ts`）：逐行把模型输出转成带颜色的行，
  并跨 chunk 跟踪代码块状态。三条容易出错的约束：
  - **每一物理行必须自洽**：`wrapText()` 折行时在行尾补 `reset`、并在续行**重新打开**
    仍生效的样式。玄猪是一行一行独立写出的（`cursor.to()` + `\x1b[2K`），**不能假定
    终端会把上一行的 SGR 状态延续下来** —— 否则一段加粗/颜色跨过折行点后，续行会掉回
    默认色（表现为「同一句话前半段亮、后半段莫名变灰」）；行尾不封闭还会把样式泄漏到
    后面的其它行。
  - **行内标记不得破坏容器样式**：`renderInline(line, baseStyle)` 在行内片段
    （`` `代码` `` / `**粗体**`）结束时恢复**所在容器的样式**（如引用块的灰色），
    而不是一律 reset —— 否则引用块里出现一个行内代码，它之后的内容就会「断色」。
    列表项的内容同样要走 `renderInline`，否则 `` `命令` `` 会原样显示成反引号。
  - **预览与落定同规**：`peek()`（流式未完成行的预览）使用与 `renderLine()` 相同的
    渲染规则，只是**不改动**代码块状态（同一行会被处理两次：预览一次、落定一次，
    预览若翻转了 `inCodeBlock`，落定时会再翻一次导致围栏错位）。否则同一行会先以
    原始 Markdown（带 `**`、`>` 前缀）显示，落定的一瞬间又突然换个样子。
- **分栏布局**：左栏自上而下为「顶部固定头部」（品牌、模型、当前目录、提示、分隔线，不参与滚动，
  高度不超过终端高度的 1/3）→ 可滚动对话区 → 输入区（多行，随内容增高）。头部高度受 1/3 限制而
  需要裁剪时，从最下面的信息行开始裁，**末尾分隔线始终保留**（见 `TuiApp.render` 中的 `headerLines`），
  保证顶部信息区与对话区之间总有分界线；右栏为**终端面板**
  （`src/tui/terminal.ts`：标题行显示工作目录与运行状态，中部为可滚动命令输出，底部为命令输入行）；
  底部状态栏横跨全宽并显示当前焦点。左栏各行按左栏宽度渲染并 `padEnd` 补齐后，
  与竖向分隔线、右栏内容拼接成整行。
- **焦点模型**：`termFocus` 决定按键进入哪一侧（`Shift+Tab` 或鼠标点击切换）。两侧各自维护输入缓冲
  与历史（`input` / `termInput`），光标渲染在聚焦侧，状态栏显示 `对话▸` / `终端▸`。
- **中断与退出**：`Ctrl+C` 保持原有语义（中断任务 / 清空输入 / 空闲且输入为空则退出）；
  `Ctrl+D` **只结束本轮正在进行的对话，任何情况下都不退出界面**（复用同一条 `AbortController` 路径——
  无对话进行时按键无副作用），聚焦右侧终端时它中断运行中的命令。
  拆成两个键的原因：`Ctrl+C` 连按会在「中断后输入已为空」时直接退出程序，容易误伤。
  确认对话框弹出时 `Ctrl+D` 表示「拒绝该操作并终止本轮」。
- 右栏在终端宽度 < 80 列时自动隐藏（`/term` 可手动开关）；滚轮依据指针列号决定滚动哪一栏。
- **滚动模型**：左右两栏各自维护「距底部行数」（左栏 `scrollOffset`、右栏 `termScroll`，`0` 表示
  跟随最新输出）。偏移量在**物理行**（折行后）上计算，上限由渲染时按实际行数收敛，因此
  `Home` 之类的「跳到最早」只需置为一个极大值，无须提前知道总行数。
  - 左栏：`PgUp`/`PgDn` 翻页、`Shift+↑/↓` 逐行、`Home`/`End` 跳到最早/最新、滚轮（按指针所在栏）；
  - 右栏（聚焦时）：同样一套按键，另外滚轮在指针位于右栏时直接生效（无需先切换焦点）；
  - 状态栏在偏移量 > 0 时显示 `↑N`（左栏）/ `⇡N`（右栏），提示当前已上翻的行数与「需回到最新」。
- **视口锚定**：`scrollOffset > 0`（或 `termScroll > 0`）时，新到达的输出会把偏移量同步加上
  新增物理行数，使正在阅读的历史不被流式内容顶走；偏移量为 `0` 时始终跟随最新输出。
  终端 resize 会重置锚定计数（`lastPhysicalCount` / `lastTermPhysicalCount`），避免按旧宽度
  误判新增行数。
- 头部每帧重绘，因此 `/switch` 切换目录后头部目录与右侧终端工作目录立即更新
  （后者通过 `ShellPanel.setCwd()`）。
- **终端面板的执行模型**：每条命令以 `spawn(shell, ["-c", cmd], { cwd, detached: true })` 独立执行，
  stdout/stderr 合并后由 `ShellPanel.feed()` 消费——按 `\n` 分行、`\r` 覆盖当前行（进度条）、
  保留 SGR 颜色而丢弃其他控制序列（否则子进程的终端控制会破坏整屏渲染）。`cd` 由面板自行维护
  （`handleCd`）；`Ctrl+C` 向进程组发 `SIGINT`、超时后 `SIGKILL`，保证不留残留进程。
  取舍：不使用持久 PTY（避免原生依赖），故需要 TTY 的全屏交互程序与跨命令 `export` 不可用。
- **Tab 补全由客户端实现**（`completeTermInput`）：因为不存在持久 shell，shell 自身的补全不可用。
  命令位置扫描 PATH（结果缓存于 `commandCache`）并合入内建命令表；参数位置在面板当前目录下
  按前缀扫描（`cd` 只列目录，未显式输入 `.` 时不提示隐藏项）。唯一匹配直接补全（目录补 `/`、
  命令与文件补空格），多匹配先补公共前缀，无法再扩展时把候选交给 `ShellPanel.notice()` 展示到输出区
  （超过 24 项时截断并注明总数）。
- **补全的词法处理**（这些边界场景早期会完全无响应）：
  - 先剥离**尾部空白**再切词 —— 回退到上一个未完成的词，使 `cat src/tui/ ` + Tab 列出该目录内容，
    而不是错误地列出当前目录；
  - 剥离**开头引号**（`"` / `'`）参与补全，回填时补回引号；唯一匹配且为文件时补上闭合引号；
  - 识别 **`VAR=` 前缀**，只对 `=` 之后的部分做路径补全；
  - **`looksLikePath`**（以 `./` `../` `/` `~` 开头）时，即使在命令位置也按路径补全（否则 `./app` 会被当成命令名）。

## 9. 构建与分发

- 打包：esbuild 将 `src/cli/index.ts` 打包为单文件 `dist/cli.js`（CJS）。
- 第三方 SDK（openai / @anthropic-ai/sdk / @google/generative-ai）保持 external。
- `bin/xzh.js` 为可执行垫片，`package.json` 的 `bin` 字段注册 `xzh` 命令。

## 10. 与原 CodeBuddy（VSCode 扩展）的差异

| 维度 | 原 CodeBuddy | 玄猪 XuanZhu |
| --- | --- | --- |
| 运行形态 | VSCode 扩展（webview UI） | 终端 CLI + 全屏 TUI |
| 入口 | 编辑器命令 / 侧边栏 | `xzh` 命令 |
| UI 技术 | React webview | 纯 ANSI，无第三方 UI 依赖 |
| 工具实现 | 依赖 `vscode` API | Node 原生（fs / child_process） |
| 依赖规模 | 40+ 运行时依赖（LangChain、ChromaDB、Telemetry 等） | 3 个运行时依赖（各家 LLM SDK） |
| 配置 | VSCode settings + SecretStorage | `~/.xzh/config.json` + 环境变量 |

改造过程中的设计取舍记录在本文档与 `AGENTS.md` 中。

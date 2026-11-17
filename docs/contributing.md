# 贡献指南 / 安全策略 / 行为准则

> 本文件合并了原来根目录的三份文档：`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`
> （2026-11-17 统一迁入 `docs/`，根目录只保留 `README.md` 与 `AGENTS.md`）。
> 开发纪律与目录约定见 [`../AGENTS.md`](../AGENTS.md)；架构与机制见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

---

## 一、贡献指南

感谢你参与玄猪（XuanZhu）的开发。

### 开发环境

- Node.js >= 18

```bash
npm install         # 安装依赖
npm run build       # 构建到 dist/cli.js
npm run typecheck   # 类型检查
npm run dev         # 监听模式
node bin/xzh.js     # 本地运行（也可以用全局安装的 xzh）
```

### 代码规范

- TypeScript strict 模式，提交前必须通过 `npm run typecheck`。
- 遵循既有分层，不在下层反向依赖上层：

  ```
  src/cli  →  src/core  →  src/llm / src/tools  →  src/tui
  ```

- **禁止引入 `vscode` 依赖或任何编辑器专有 API**（本项目为纯终端应用）。
- 新增 LLM Provider：在 `src/llm/` 实现 `LLMProvider`，在 `src/llm/index.ts` 的
  `PROVIDERS` 注册元数据，并在 `createProvider()` 中接入。
- 新增工具：在 `src/tools/` 实现 `ToolDefinition`（含 JSON Schema 参数定义），
  加入 `src/tools/index.ts` 的 `TOOLS` 数组即可自动暴露给模型。
- 工具若具有破坏性，必须设置 `requiresConfirmation: true` 与 `danger: true`。
- 交易相关（A 股 / BTC）改动必须走 `docs/modules/a-share.md`、`docs/modules/btc.md` 列出的闸门，
  **不要新增绕过 `continuousSession()` / 三周期方向闸门 / 硬性风控的成交路径**。

### 提交规范

- 提交信息使用简明的祈使句，例如 `add glob tool`、`fix tui cursor position`。
- 一个提交聚焦一件事，避免混入无关重构。

### 文档同步

改代码必须同步改文档（`test/docs.test.ts` 会把过期文档变成红灯）：

- 目录/文件增删 → 改 `docs/ARCHITECTURE.md` 的「模块概览」文件数 + `docs/modules/*.md` 的文件表；
- 机制变化 → 改 `docs/ARCHITECTURE.md` 对应小节；
- 运行时文件变化 → 改 [`data-files.md`](./data-files.md)。

### 发布

只有维护者发版：`./release.sh [patch|minor|major|X.Y.Z]`（详见 `docs/ARCHITECTURE.md` §9 与
`docs/changelog.md`）。**不要主动发布新版本**。

---

## 二、安全策略

### 支持版本

| 版本 | 支持 |
| --- | --- |
| 0.17.x | ✅ |
| 0.1.x | ❌（已停止维护） |

### 报告漏洞

请不要通过公开 issue 报告安全漏洞。请通过私下渠道联系维护者，并提供复现步骤与影响说明。

### 安全机制

**凭据存储**

- 全局配置位于 `~/.xzh/config/config.json`（`XZH_HOME` 可重定向），文件权限 `600`。
- 交易所 Secret / 第三方密钥走本地加密库 `~/.xzh/vault`（AES-256-GCM，`0600`），**不写进 config.json**。
- `xzh config` 展示配置时对 API Key 脱敏（`sk-xx...xx`）。
- 也支持从环境变量读取 Key（如 `DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`）。

**命令执行**

- `bash` 工具在非交互式 shell 中执行命令，默认超时 120 秒（上限 600 秒），超时强制终止。
- 单次执行输出截断到 30,000 字符，避免上下文污染。
- 危险工具（删文件、`btc_paper_reset`、资金划转等）默认需要确认；
  后台巡检（无人值守）只按 `src/btc/unattended.ts` 的白名单放行交易与排期动作，
  **不放行** 写文件 / 执行命令 / 清账本。
- `autoApprove` 打开时写文件与执行命令不再逐项询问，可用 `/auto off` 关闭。

**文件访问**

- 相对路径以当前工作目录为基准解析。
- `read_file` 限制单文件 2MB / 2000 行；检测到二进制内容时拒绝读取。
- `glob` / `grep` 跳过 `.git`、`node_modules`、`dist` 等目录，单次结果上限 200 条；
  `grep` 跳过大于 1MB 的文件。

**依赖与代码质量**

- 运行时依赖仅官方 LLM SDK，无第三方 UI 框架（TUI 是纯 ANSI 手写）。
- TypeScript strict 模式。
- 不采集遥测，不上传任何代码或对话数据；所有请求仅发送至用户配置的模型服务商。

---

## 三、行为准则

本项目采用 [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)
的核心约定（原文 133 行的模板不再单独保留，只保留可执行的部分）：

- **尊重**：对事不对人；可以激烈讨论技术方案，不攻击个人。
- **包容**：欢迎不同经验水平的贡献者；不因年龄、性别、性取向、残障、种族、宗教等区别对待。
- **不接受**：性化语言或图像、人身攻击、骚扰、公开他人隐私信息。
- **处理**：违规内容会被删除，屡犯者会被移出讨论；举报走上面的私下渠道。

> 更完整的条款以 Contributor Covenant v2.1 原文为准。

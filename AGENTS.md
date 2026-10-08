不要主动发布新版本，发布时需要用户同意
解决当检测到模型陷入死循环时，agent通过某些方式解除陷入循环

# 玄猪（XuanZhu）项目指南

## 项目定位

玄猪是一款**专为终端打造的 AI 编码 Agent**，通过 `xzh` 命令启动全屏 TUI。
本项目由原 CodeBuddy（VSCode 扩展）改造而来，现已完全移除编辑器依赖。

## 目录约定（全局 vs 项目级）

玄猪的数据分两层，**职责与位置都必须分清**：

| 目录 | 位置 | 存什么 |
| --- | --- | --- |
| **`~/.xzh/`** | 用户**主目录**，与 cwd 无关 | **全局配置**：`config.json`（服务商、模型、权重、上下文窗口、`autoApprove` 等）；另含 `session.lock` / `crash.log`（异常退出诊断） |
| **`<cwd>/.xuanzhu/`** | 用户运行 `xzh` 时所处的目录，**含 `/switch` 切换后的目录** | **项目级数据**：`memory/`（按天记录 + `MEMORY.md` 长期记忆）、`rules.md`（项目规则，注入系统提示词） |

**必须遵守的规则**：

1. **全局配置只放 `~/.xzh`** —— 与具体项目无关的设置都在这里（换项目无需重配），
   且可用环境变量 `XZH_HOME` 整体重定向。
2. **项目级数据只放 `<cwd>/.xuanzhu`** —— 项目记忆、项目规则，以及将来任何
   「与这个目录绑定」的数据。**不要**写进 `~/.xzh`。
3. **`/switch <目录>` 之后项目级数据随之切换** —— `.xuanzhu` 在**新目录**下创建/读取，
   既不是回到 `~/.xzh`，也不是沿用旧目录。原因是 `resolveProjectPaths(cwd)`
   固定取 cwd 下一层、**不做向上查找**。
4. 两者**目录名不同**（`.xzh` vs `.xuanzhu`），因此即使在 `$HOME` 下运行 `xzh`
   也不会互相覆盖。
5. `.xuanzhu/` 是**运行时生成**的本地数据，须加入 `.gitignore`（本仓库已忽略）。

> 对应的实现：全局目录见 `src/utils/paths.ts` 的 `getConfigDir()`；
> 项目目录见 `src/workspace/index.ts` 的 `PROJECT_DIR_NAME` / `resolveProjectPaths()`。

## 技术栈与命令

- 语言：TypeScript + Node.js（>= 18）
- 打包：esbuild → 单文件 `dist/cli.js`（CJS，第三方 LLM SDK 保持 external）
- 常用命令：
  - `npm install` 安装依赖
  - `npm run build` 构建
  - `npm run typecheck` 类型检查
  - `npm run dev` 监听构建
  - `node bin/xzh.js` 本地运行

## 代码分层

```
src/cli   →  src/core  →  src/llm / src/tools  →  src/tui
```

- 新增 LLM Provider：在 `src/llm/` 实现并在 `src/llm/index.ts` 的 `PROVIDERS` 注册，
  同时在 `createProvider()` 中接入。
- 新增工具：在 `src/tools/` 实现 `ToolDefinition`，加入 `TOOLS` 数组即可。
- 禁止重新引入 `vscode` 依赖或任何编辑器专有 API。

## 文档同步（必须执行）

项目修改时，如有与本说明或 `docs/` 下的说明不一致的地方，**必须同步修改相应位置**，
并向用户说明与原设计的不同之处。

- 设计事实来源：本文件（`AGENTS.md`）与 `docs/ARCHITECTURE.md`。
- 原 CodeBuddy（VSCode 扩展）的设计文档在改造时已移除，本仓库以当前的 `AGENTS.md` 与
  `docs/ARCHITECTURE.md` 为准。

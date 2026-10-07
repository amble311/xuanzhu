# 玄猪（XuanZhu）项目指南

## 项目定位

玄猪是一款**专为终端打造的 AI 编码 Agent**，通过 `xzh` 命令启动全屏 TUI。
本项目由原 CodeBuddy（VSCode 扩展）改造而来，现已完全移除编辑器依赖。

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

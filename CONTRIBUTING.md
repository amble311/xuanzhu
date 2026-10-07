# 贡献指南

感谢你参与玄猪（XuanZhu）的开发。

## 开发环境

- Node.js >= 18

```bash
npm install         # 安装依赖
npm run build       # 构建到 dist/cli.js
npm run typecheck   # 类型检查
npm run dev         # 监听模式
node bin/xzh.js     # 本地运行
```

## 代码规范

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

## 提交规范

- 提交信息使用简明的祈使句，例如 `add glob tool`、`fix tui cursor position`。
- 一个提交聚焦一件事，避免混入无关重构。

## 文档同步

修改代码后，若与 `AGENTS.md` 或 `docs/ARCHITECTURE.md` 的描述不一致，
**必须同步更新对应文档**，并在说明中标注与原设计的不同之处。

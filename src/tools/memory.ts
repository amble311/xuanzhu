import {
  appendMemory,
  readProjectMemory,
  resolveProjectPaths,
} from "../workspace";
import type { ToolDefinition, ToolResult } from "./types";

const MAX_DISPLAY = 12_000;

/** memory_read —— 读取项目记忆 */
export const memoryReadTool: ToolDefinition = {
  name: "memory_read",
  description:
    "读取当前项目的记忆（存放在 <项目>/.xuanzhu/memory/）：包含长期记忆 MEMORY.md 与最近一份每日日志。" +
    "在开始处理需要项目背景的任务前调用它，可以了解此前积累的约定与结论。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(_args, ctx): Promise<ToolResult> {
    const memory = readProjectMemory(ctx.cwd);
    const paths = resolveProjectPaths(ctx.cwd);

    if (!memory.longTerm && !memory.recentDaily) {
      return {
        ok: true,
        content: `项目记忆为空（目录：${paths.memoryDir}）。`,
        summary: "暂无记忆",
      };
    }

    const parts: string[] = [];
    if (memory.longTerm) {
      parts.push(`## 长期记忆（MEMORY.md）\n\n${memory.longTerm}`);
    }
    if (memory.recentDaily) {
      parts.push(`## 最近日志（${memory.recentDailyName}）\n\n${memory.recentDaily}`);
    }

    const content = parts.join("\n\n---\n\n");
    return {
      ok: true,
      content:
        content.length > MAX_DISPLAY
          ? `${content.slice(0, MAX_DISPLAY)}\n\n…（内容过长，已截断）`
          : content,
      summary: "已读取项目记忆",
    };
  },
};

/** memory_write —— 写入项目记忆 */
export const memoryWriteTool: ToolDefinition = {
  name: "memory_write",
  description:
    "把值得跨会话保留的信息写入项目记忆（<项目>/.xuanzhu/memory/）。" +
    "在完成实质工作（实现功能、修复缺陷、确定技术方案、约定项目规范）后调用，以便后续会话复用。" +
    "scope=daily 追加到当日日志（默认，适合过程记录）；scope=long 追加到长期记忆 MEMORY.md（适合稳定的结论与约定）。" +
    "请写简洁的事实性内容，不要记录瞬时信息（临时路径、工具报错等）。",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "要记录的内容（Markdown，建议简洁、分点）",
      },
      scope: {
        type: "string",
        enum: ["daily", "long"],
        description: "daily=当日日志（默认）；long=长期记忆 MEMORY.md",
      },
    },
    required: ["content"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) {
      return { ok: false, content: "错误：content 不能为空。" };
    }
    const scope = args.scope === "long" ? "long" : "daily";

    try {
      const file = appendMemory(ctx.cwd, content, scope);
      const label = scope === "long" ? "长期记忆" : "当日日志";
      return {
        ok: true,
        content: `已写入${label}：${file}\n\n（记忆目录：${resolveProjectPaths(ctx.cwd).memoryDir}）`,
        summary: `已写入${label}`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `写入记忆失败：${err instanceof Error ? err.message : String(err)}\n（目标目录：${resolveProjectPaths(ctx.cwd).memoryDir}）`,
      };
    }
  },
};

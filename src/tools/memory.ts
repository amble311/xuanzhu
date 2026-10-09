import {
  appendMemory,
  compactLongTermMemoryIfNeeded,
  DEFAULT_MEMORY_MAX_CHARS,
  readProjectMemory,
  resolveProjectPaths,
  writeLongTermMemory,
} from "../workspace";
import type { ToolDefinition, ToolResult } from "./types";

const MAX_DISPLAY = 12_000;

/** memory_read —— 读取项目记忆 */
export const memoryReadTool: ToolDefinition = {
  name: "memory_read",
  description:
    "读取当前项目的记忆（存放在 <项目>/.xuanzhu/memory/）：包含长期记忆 MEMORY.md 与最近一份每日日志。" +
    "在开始处理需要项目背景的任务前调用它，可以了解此前积累的约定与结论。" +
    "当系统提示词提示「长期记忆过长」时，也应先用它读取全文，再调用 memory_compact 精简。",
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
    "请写简洁的事实性内容，不要记录瞬时信息（临时路径、工具报错等）。" +
    "长期记忆超出上限时会自动去重与精简，摘要中会说明精简结果。",
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

      // 长期记忆只追加会无界增长，而它每次启动都要注入提示词。写入后检查一次：
      // 达到阈值即自动去重 + 裁剪最旧块（只处理确定性部分，语义合并交给 memory_compact）。
      let compactNote = "";
      if (scope === "long") {
        const result = compactLongTermMemoryIfNeeded(
          ctx.cwd,
          ctx.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS,
        );
        if (result && (result.removedDuplicates > 0 || result.removedOldest > 0)) {
          const parts: string[] = [];
          if (result.removedDuplicates > 0) {
            parts.push(`去除 ${result.removedDuplicates} 条重复记录`);
          }
          if (result.removedOldest > 0) {
            parts.push(`丢弃 ${result.removedOldest} 条最旧记录`);
          }
          compactNote =
            `\n\n（长期记忆已自动精简：${parts.join("、")}，` +
            `${result.before} → ${result.after} 字符）`;
        }
      }

      return {
        ok: true,
        content: `已写入${label}：${file}${compactNote}\n\n（记忆目录：${resolveProjectPaths(ctx.cwd).memoryDir}）`,
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

/**
 * memory_compact —— 重写长期记忆（语义精简）。
 *
 * 确定性精简（去重、截断）只能处理「完全相同」或「超限」的情况，
 * 而记忆里真正需要的是**语义压缩**：合并同一主题的多条记录、删掉已经过时
 * 或被后续结论推翻的内容、把重复的探索过程浓缩成一句结论。
 * 这类判断只有模型能做，因此提供一个「整体重写」的工具：
 * 模型先用 memory_read 读取全文，再提交精简后的完整版本。
 */
export const memoryCompactTool: ToolDefinition = {
  name: "memory_compact",
  description:
    "用一份**精简后的完整内容**覆盖长期记忆 MEMORY.md（语义压缩）。" +
    "当长期记忆过长、内容重复或有过时条目时使用：先 memory_read 读取全文，" +
    "再合并同一主题、删除已过时/被推翻的内容、把冗长的过程浓缩为结论，" +
    "最后把重写结果通过本工具提交。" +
    "注意：提交的是**完整的新版本**（会整体覆盖），不要只提交增量；" +
    "必须保留仍然有效的关键结论、项目约定与踩坑经验。",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "精简后的长期记忆全文（Markdown，建议保留 `## 时间戳` 形式的条目结构）",
      },
    },
    required: ["content"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) {
      return {
        ok: false,
        content: "错误：content 不能为空。若要清空长期记忆，请提交非空说明内容。",
      };
    }

    try {
      const before = readProjectMemory(ctx.cwd).longTerm.length;
      const file = writeLongTermMemory(ctx.cwd, content);
      return {
        ok: true,
        content:
          `已重写长期记忆：${file}\n（${before} → ${content.length} 字符）`,
        summary: `长期记忆已精简（${before} → ${content.length} 字符）`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `重写长期记忆失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

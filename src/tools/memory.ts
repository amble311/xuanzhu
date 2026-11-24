import {
  appendMemoryAt,
  compactLongTermMemoryIfNeededAt,
  DEFAULT_GLOBAL_MEMORY_MAX_CHARS,
  DEFAULT_MEMORY_MAX_CHARS,
  readMemoryAt,
  resolveGlobalMemoryPaths,
  resolveProjectMemoryPaths,
  writeLongTermMemoryAt,
  type MemoryPaths,
} from "../workspace";
import { protectSecretsInText } from "../secrets/vault";
import { estimateTokens, sliceToTokenBudget } from "../llm/context";
import type { ToolDefinition, ToolResult } from "./types";

const MAX_DISPLAY = 6_000;

/** 记忆作用域：项目（默认）/ 全局（~/.xzh/data/memory）/ 同时读取 */
type MemoryTarget = "project" | "global" | "all";

function parseTarget(value: unknown): MemoryTarget {
  return value === "global" || value === "all" ? value : "project";
}

function pathsFor(target: MemoryTarget, cwd: string): MemoryPaths {
  return target === "global"
    ? resolveGlobalMemoryPaths()
    : resolveProjectMemoryPaths(cwd);
}

/**
 * 记忆是**每次请求都会进提示词**的内容，绝不能放密码原文。
 *
 * 写入前把 `密码: xxx` / `token=xxx` 这类赋值里的值替换成
 * `[加密凭据 sec_xxx]`：值用 AES-256-GCM 存进 ~/.xzh/vault，记忆只留引用。
 * 返回加密后的文本；加密失败必须拒绝写入，避免明文落盘。
 */
function protectForMemory(content: string): {
  content: string;
  credentialIds: string[];
  error?: string;
} {
  try {
    const protectedText = protectSecretsInText(content);
    return {
      content: protectedText.text,
      credentialIds: protectedText.credentialIds,
    };
  } catch (err) {
    return {
      content,
      credentialIds: [],
      error: `凭据加密失败，已拒绝写入记忆：${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** memory_read —— 读取项目 / 全局记忆 */
export const memoryReadTool: ToolDefinition = {
  name: "memory_read",
  description:
    "读取记忆：target=project（默认，当前项目）/global（跨项目）/all。" +
    "含长期记忆 MEMORY.md 与最近一份日志。需要项目背景、写长期记忆前先读；" +
    "提示「记忆过长」时先读全文再 memory_compact。",
  parameters: {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: ["project", "global", "all"],
        description: "project=当前项目（默认）；global=跨项目；all=两者都读",
      },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const target = parseTarget(args.target);
    const sections: string[] = [];

    const readOne = (label: string, paths: MemoryPaths): void => {
      const memory = readMemoryAt(paths);
      if (!memory.longTerm && !memory.recentDaily) {
        sections.push(`## ${label}\n\n（为空；目录：${paths.memoryDir}）`);
        return;
      }
      const parts: string[] = [];
      if (memory.longTerm) {
        parts.push(`### 长期记忆（MEMORY.md）\n\n${memory.longTerm}`);
      }
      if (memory.recentDaily) {
        parts.push(`### 最近日志（${memory.recentDailyName}）\n\n${memory.recentDaily}`);
      }
      sections.push(
        `## ${label}（${paths.memoryDir}）\n\n${parts.join("\n\n---\n\n")}`,
      );
    };

    if (target !== "global") readOne("项目记忆", pathsFor("project", ctx.cwd));
    if (target !== "project") readOne("全局记忆", resolveGlobalMemoryPaths());

    let content = sections.join("\n\n");
    const tokenCap = ctx.limits?.maxResultTokens;
    if (tokenCap && estimateTokens(content) > tokenCap) {
      content =
        sliceToTokenBudget(content, tokenCap) +
        "\n\n…（已按上下文预算截断，可用 target=global/all 或分次读取）";
    }
    return {
      ok: true,
      content:
        content.length > MAX_DISPLAY
          ? `${content.slice(0, MAX_DISPLAY)}\n\n…（内容过长，已截断）`
          : content,
      summary:
        target === "all"
          ? "已读取项目与全局记忆"
          : target === "global"
            ? "已读取全局记忆"
            : "已读取项目记忆",
    };
  },
};

/** memory_write —— 写入项目 / 全局记忆 */
export const memoryWriteTool: ToolDefinition = {
  name: "memory_write",
  description:
    "把值得跨会话保留的信息写入记忆。scope=daily（默认，当日日志）/long（长期记忆，仅全新主题；" +
    "已有主题先用 memory_compact 并入）。target=project（默认）/global。" +
    "密码/Token 会自动加密为 `[加密凭据 ...]` 并返回 `sec_xxx`（后续用 bash 的 stdin_secret），不要猜测其值。",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "要记录的内容（Markdown，简洁分点）",
      },
      scope: {
        type: "string",
        enum: ["daily", "long"],
        description: "daily=当日日志（默认）；long=长期记忆（仅全新主题）",
      },
      target: {
        type: "string",
        enum: ["project", "global"],
        description: "project=当前项目（默认）；global=跨项目",
      },
      source: {
        type: "string",
        enum: ["user", "tool", "model"],
        description: "user=用户要求；tool=从外部输出总结（project+tool 需确认）；model=推断",
      },
    },
    required: ["content"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const rawContent =
      typeof args.content === "string" ? args.content.trim() : "";
    if (!rawContent) {
      return { ok: false, content: "错误：content 不能为空。" };
    }
    const scope = args.scope === "long" ? "long" : "daily";
    const target = args.target === "global" ? "global" : "project";
    const source =
      args.source === "user" || args.source === "tool" ? args.source : "model";

    const protectedContent = protectForMemory(rawContent);
    if (protectedContent.error) {
      return { ok: false, content: protectedContent.error };
    }
    const content = protectedContent.content;
    const encryptedNote =
      protectedContent.credentialIds.length > 0
        ? `\n\n（已加密 ${protectedContent.credentialIds.length} 项凭据，` +
          "记忆只保留 `[加密凭据 ...]` 引用）\n" +
          `凭据引用：${protectedContent.credentialIds
            .map((id) => `\`${id}\``)
            .join("、")} —— 后续用 bash 的 \`stdin_secret\` 参数引用（如 ` +
          "`sudo -S`），不要把明文写进命令。"
        : "";

    // 项目记忆也可能被工具输出/网页内容里的指令污染。模型从外部内容总结记忆时
    // 必须标 source=tool，这里要求用户确认；用户明确要求（source=user）不打断。
    if (target === "project" && source === "tool" && ctx.confirm) {
      const approved = await ctx.confirm({
        tool: "memory_write",
        title: "写入项目记忆？",
        detail:
          "这段内容来自工具输出 / 文件 / 网页，可能包含 Prompt Injection。\n" +
          "确认要把以下内容写进项目记忆吗？\n\n" +
          content.slice(0, 1200),
        danger: false,
      });
      if (!approved) {
        return { ok: false, content: "已取消写入项目记忆。" };
      }
    }

    if (target === "global" && ctx.confirm) {
      const approved = await ctx.confirm({
        tool: "memory_write",
        title: "写入跨项目全局记忆？",
        detail:
          "以下内容将注入所有项目。请确认没有 Prompt Injection 或敏感信息：\n\n" +
          content.slice(0, 1200),
        danger: false,
      });
      if (!approved) {
        return { ok: false, content: "已取消写入全局记忆。" };
      }
    }

    const paths = pathsFor(target, ctx.cwd);
    const limit =
      target === "global"
        ? (ctx.globalMemoryMaxChars ?? DEFAULT_GLOBAL_MEMORY_MAX_CHARS)
        : (ctx.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS);

    try {
      const file = appendMemoryAt(paths, content, scope);
      const label = target === "global" ? "全局" : "项目";
      const kind = scope === "long" ? "长期记忆" : "当日日志";

      // 长期记忆会无界增长，而它每次启动都要注入提示词。写入后检查一次：
      // 达到阈值即自动去重 + 裁剪最旧的追加块（确定性部分），语义合并交给 memory_compact。
      let compactNote = "";
      if (scope === "long") {
        const result = compactLongTermMemoryIfNeededAt(paths, limit);
        if (result && (result.removedDuplicates > 0 || result.removedOldest > 0)) {
          const parts: string[] = [];
          if (result.removedDuplicates > 0) {
            parts.push(`去除 ${result.removedDuplicates} 条重复记录`);
          }
          if (result.removedOldest > 0) {
            parts.push(`丢弃 ${result.removedOldest} 条最旧的追加记录`);
          }
          compactNote =
            `\n\n（${label}长期记忆已自动精简：${parts.join("、")}，` +
            `${result.before} → ${result.after} 字符）`;
        }

        // 自动层只删得出「追加块」。剩下的若是按主题整理的稳定小节，就得当场把
        // 语义压缩交给模型。全局记忆更紧，必须提示用 target=global 精简。
        const size = readMemoryAt(paths).longTerm.length;
        if (limit > 0 && size > limit) {
          compactNote +=
            `\n\n⚠ ${label}长期记忆仍有 ${size} 字符（上限 ${limit}），自动精简已无法继续。` +
            `请**立即**用 memory_read${target === "global" ? " target=global" : ""} 读取全文，` +
            `再用 memory_compact${target === "global" ? " target=global" : ""} 提交合并/删减后的完整版本。`;
        }
      }

      return {
        ok: true,
        content:
          `已写入${label}${kind}：${file}${compactNote}${encryptedNote}\n\n` +
          `（记忆目录：${paths.memoryDir}）`,
        summary: `已写入${label}${kind}`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `写入记忆失败：${err instanceof Error ? err.message : String(err)}\n（目标目录：${paths.memoryDir}）`,
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
    "用精简后的**完整内容**覆盖长期记忆（语义压缩）：先 memory_read 读取全文，再按主题合并、" +
    "删除过时条目、把过程浓缩为结论，最后提交完整新版本（不是增量）。" +
    "target=project（默认）/global。密码/Token 会自动加密。",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "精简后的长期记忆全文（Markdown，按 `## 主题` 分节）",
      },
      target: {
        type: "string",
        enum: ["project", "global"],
        description: "project=当前项目（默认）；global=跨项目",
      },
      source: {
        type: "string",
        enum: ["user", "tool", "model"],
        description: "user=用户要求；tool=从外部输出总结（project+tool 需确认）；model=推断",
      },
    },
    required: ["content"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const rawContent =
      typeof args.content === "string" ? args.content.trim() : "";
    if (!rawContent) {
      return {
        ok: false,
        content: "错误：content 不能为空。若要清空长期记忆，请提交非空说明内容。",
      };
    }
    const target = args.target === "global" ? "global" : "project";
    const source =
      args.source === "user" || args.source === "tool" ? args.source : "model";
    const protectedContent = protectForMemory(rawContent);
    if (protectedContent.error) {
      return { ok: false, content: protectedContent.error };
    }
    const content = protectedContent.content;
    const encryptedNote =
      protectedContent.credentialIds.length > 0
        ? `\n（已加密 ${protectedContent.credentialIds.length} 项凭据）`
        : "";

    // 项目记忆也可能被工具输出/网页内容里的指令污染。模型从外部内容总结记忆时
    // 必须标 source=tool，这里要求用户确认；用户明确要求（source=user）不打断。
    if (target === "project" && source === "tool" && ctx.confirm) {
      const approved = await ctx.confirm({
        tool: "memory_write",
        title: "写入项目记忆？",
        detail:
          "这段内容来自工具输出 / 文件 / 网页，可能包含 Prompt Injection。\n" +
          "确认要把以下内容写进项目记忆吗？\n\n" +
          content.slice(0, 1200),
        danger: false,
      });
      if (!approved) {
        return { ok: false, content: "已取消写入项目记忆。" };
      }
    }

    if (target === "global" && ctx.confirm) {
      const approved = await ctx.confirm({
        tool: "memory_compact",
        title: "重写跨项目全局记忆？",
        detail:
          "以下内容将覆盖全局记忆并注入所有项目，请检查：\n\n" +
          content.slice(0, 1200),
        danger: false,
      });
      if (!approved) {
        return { ok: false, content: "已取消重写全局记忆。" };
      }
    }

    const paths = pathsFor(target, ctx.cwd);
    const label = target === "global" ? "全局" : "项目";

    try {
      const before = readMemoryAt(paths).longTerm.length;
      const file = writeLongTermMemoryAt(paths, content);
      return {
        ok: true,
        content:
          `已重写${label}长期记忆：${file}\n（${before} → ${content.length} 字符）` +
          encryptedNote,
        summary: `${label}长期记忆已精简（${before} → ${content.length} 字符）`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `重写${label}长期记忆失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

/**
 * `memory` —— 读 / 写 / 精简三合一。
 *
 * 三个动作的参数、权限与出错信息都不同，但**schema 每轮都要下发**：
 * 合成一个工具后每轮少发两份工具声明（约 400 tok），代价是模型必须多写一个
 * `action`。旧名通过 `aliases` 保留执行能力，恢复旧会话时不会「未知工具」。
 */
export const memoryTool: ToolDefinition = {
  name: "memory",
  smallProfile: true,
  description:
    "跨会话记忆。action=read（默认，读 project/global/all）/ write（scope=daily 或 long、target）/" +
    "compact（用完整新版覆盖长期记忆）。密码/Token 会自动加密，勿读取或猜测。",
  aliases: [
    { name: "memory_read", args: { action: "read" } },
    { name: "memory_write", args: { action: "write" } },
    { name: "memory_compact", args: { action: "compact" } },
  ],
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["read", "write", "compact"],
        description: "read=读取（默认）；write=写入；compact=用完整新版覆盖长期记忆",
      },
      target: {
        type: "string",
        enum: ["project", "global", "all"],
        description: "project=当前项目（默认）；global=跨项目；all=两者都读（仅 read）",
      },
      scope: {
        type: "string",
        enum: ["daily", "long"],
        description: "write 时：daily=当日日志（默认）；long=长期记忆（仅全新主题）",
      },
      content: {
        type: "string",
        description: "write / compact：要写入或保留的完整内容（Markdown）",
      },
      source: {
        type: "string",
        enum: ["user", "tool", "model"],
        description: "write / compact：user=用户要求；tool=从外部输出总结（需确认）；model=推断",
      },
    },
    required: ["action"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const action =
      args.action === "write" || args.action === "compact" ? args.action : "read";
    if (action === "write") return memoryWriteTool.execute(args, ctx);
    if (action === "compact") return memoryCompactTool.execute(args, ctx);
    return memoryReadTool.execute(args, ctx);
  },
};

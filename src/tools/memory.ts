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
import type { ToolDefinition, ToolResult } from "./types";

const MAX_DISPLAY = 12_000;

/** 记忆作用域：项目（默认）/ 全局（~/.xzh/memory）/ 同时读取 */
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
    "读取记忆。target=project（默认）读取当前项目 `<项目>/.xuanzhu/memory/`；" +
    "target=global 读取跨项目全局记忆 `~/.xzh/memory/`；target=all 同时读取。" +
    "长期记忆 MEMORY.md 是按主题整理的结论库，另附最近一份每日日志。" +
    "开始处理需要背景的任务前、写长期记忆前都应当先读；" +
    "当系统提示词提示「长期记忆过长」时，也应先用它读取全文，再调用 memory_compact 精简。",
  parameters: {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: ["project", "global", "all"],
        description: "project=当前项目（默认）；global=跨项目全局；all=两者都读",
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

    const content = sections.join("\n\n");
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
    "把值得跨会话保留的信息写入记忆。target=project（默认）写当前项目；" +
    "target=global 写入跨项目全局记忆（用户明确说「全局/所有项目/以后都」或提供跨项目环境事实时用）。" +
    "scope=daily 追加当日日志（默认，适合当天进展）；" +
    "scope=long 在长期记忆 MEMORY.md 末尾追加一块 —— **只适合全新主题**：" +
    "若新结论属于已有主题小节，应先 memory_read 再用 memory_compact 并进那个小节。" +
    "全局记忆会注入每次请求；密码/Token 原文会在写入前自动加密为 " +
    "`[加密凭据 ...]` 引用，不要读取或猜测其值。",
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
        description:
          "daily=当日日志（默认）；long=长期记忆 MEMORY.md（仅用于全新主题；已有主题请用 memory_compact 并入）",
      },
      target: {
        type: "string",
        enum: ["project", "global"],
        description: "project=当前项目（默认）；global=跨项目全局记忆",
      },
      source: {
        type: "string",
        enum: ["user", "tool", "model"],
        description:
          "信息来源：user=用户明确要求；tool=从命令/文件/网页输出总结；model=模型自行推断。project + tool 会要求确认",
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
          "记忆只保留 `[加密凭据 ...]` 引用）"
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
    "用一份**精简后的完整内容**覆盖长期记忆 MEMORY.md（语义压缩）。" +
    "target 选择项目或全局长期记忆。两个用途：① 把新结论**并进已有主题小节**" +
    "（长期记忆的常规更新方式，因为 memory_write 只会在文末追加）；② 过长/重复/有过时条目时整体整理。" +
    "做法：先 memory_read 读取全文，再按主题合并条目、删除已过时或被后续结论推翻的内容、" +
    "把冗长的过程浓缩为结论，最后提交完整的新版本（不是增量）。" +
    "密码/Token 原文会自动加密为 `[加密凭据 ...]` 引用，不会明文落盘。",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "精简后的长期记忆全文（Markdown：文首一行维护说明，正文按 `## 主题` 分节）",
      },
      target: {
        type: "string",
        enum: ["project", "global"],
        description: "project=当前项目长期记忆（默认）；global=全局长期记忆",
      },
      source: {
        type: "string",
        enum: ["user", "tool", "model"],
        description:
          "信息来源：user=用户明确要求；tool=从命令/文件/网页输出总结；model=模型自行推断。project + tool 会要求确认",
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

import * as fs from "fs";
import * as path from "path";
import { VERSION } from "../utils/version";
import { createProvider } from "../llm";
import type { ChatMessage, LLMProvider } from "../llm/types";
import type { ModelEntry, XuanZhuConfig } from "../config/store";
import { resolveAgentsFilePath } from "../workspace";
import { buildAgentsDoc, generateProjectDocs } from "./generate";
import { scanProject, type ProjectFacts } from "./scan";

/**
 * `xzh agents.md` / `/agents.md`：
 * 用项目扫描事实 + 现有 AGENTS.md，让当前模型重写/整合一份入口级规范。
 *
 * 这里不把整个仓库塞给模型：扫描结果（commands、目录、文件数）和已生成草稿
 * 足够描述“项目实际内容”，也避免 prompt 过大。现有 AGENTS 全文会保留在提示里，
 * 由模型负责合并，避免覆盖用户手写约定。
 */

export interface AgentsRewriteResult {
  content: string;
  existing: string | null;
  generated: string;
  facts: ProjectFacts;
  targetPath: string;
}

function localDate(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readExcerpt(file: string, max = 2_500): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8").trim();
    return text ? text.slice(0, max) : null;
  } catch {
    return null;
  }
}

/** 纯确定性草稿：模型不可用时仍能写出一份基于扫描事实的 AGENTS.md */
export function buildAgentsDraft(cwd: string): {
  content: string;
  facts: ProjectFacts;
} {
  const facts = scanProject(cwd);
  const docs = generateProjectDocs(facts, {
    version: VERSION,
    date: localDate(),
  });
  const content = buildAgentsDoc(facts, {
    version: VERSION,
    date: localDate(),
    generatedDocs: docs.map((doc) => doc.relPath),
  });
  return { content, facts };
}

function buildPrompt(
  cwd: string,
  facts: ProjectFacts,
  generated: string,
  existing: string | null,
): string {
  const readme = readExcerpt(path.join(cwd, "README.md"));
  const architecture = readExcerpt(path.join(cwd, "docs", "ARCHITECTURE.md"));
  const existingPart = existing
    ? `## 现有 AGENTS.md（必须整合，保留仍然有效的用户约定）\n\n${existing.slice(0, 12_000)}`
    : "## 现有 AGENTS.md\n\n（不存在，直接根据项目事实编写）";

  return [
    "你是项目规范整理器。请根据下面的项目扫描结果，重写一份项目根 `AGENTS.md`。",
    "",
    "固定设计（必须遵守）：",
    "1. **AGENTS.md 只描述入口级大纲**，详细内容写在 `docs/` 下的文件或子文件中；",
    "   不要在 AGENTS.md 展开完整命令表、目录树、模块职责、代码片段或长篇说明。",
    "2. **尽量简短**：目标是让 Agent 在 1 分钟内知道「项目是什么、怎么验证、去哪里看细节」，",
    "   全文控制在 3000 字符以内；能链接到 docs 的就不要抄进 AGENTS。",
    "3. 固定保持这些小节：项目概览、常用命令（只列关键命令）、目录结构（只列顶层/入口）、",
    "   开发约定（只留必须遵守的短规则）、文档索引（指向 docs/）。",
    "4. 已存在 AGENTS.md 时，保留仍然有效的用户约定；合并重复内容，删除空模板/过时内容；",
    "   原有细节压缩成摘要或指向 docs 的引用，不要因为压缩而丢关键约束。",
    "5. 命令和路径只能来自下面的事实或现有内容，不要编造；不要声称 docs 中已有未提供的内容。",
    "6. 固定加入「文档同步」小节：修改项目代码后必须同步修改 AGENTS.md 或 docs/ 下对应说明，",
    "   保持互相呼应；如果 md 改动涉及设计/目录/命令/约定变化，最终回复必须额外告知用户。",
    "7. 输出**完整的 AGENTS.md Markdown 正文**，不要解释、不要代码围栏、不要省略号；默认中文。",
    "",
    `## 项目扫描事实\n${JSON.stringify(facts, null, 2).slice(0, 8_000)}`,
    "",
    `## 自动生成草稿（可参考，不要照抄空小节）\n${generated.slice(0, 8_000)}`,
    "",
    existingPart,
    readme ? `\n## README.md 摘要\n${readme}` : "",
    architecture ? `\n## docs/ARCHITECTURE.md 摘要\n${architecture}` : "",
  ].join("\n");
}

/** 去掉模型偶尔多给的代码围栏/前置说明，只保留 Markdown 正文 */
export function extractAgentsMarkdown(raw: string): string {
  let text = raw.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();
  const firstHeading = text.search(/^#\s+/m);
  if (firstHeading > 0) text = text.slice(firstHeading);
  return `${text.trim()}\n`;
}

function collectText(provider: LLMProvider, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  return (async () => {
    let text = "";
    const stream = provider.chat({
      messages,
      tools: [],
      temperature: 0.2,
      maxTokens: 4_000,
      signal,
    });
    for await (const chunk of stream) {
      if (chunk.type === "text") text += chunk.text;
    }
    return text.trim();
  })();
}

export async function generateAgentsRewrite(
  cwd: string,
  config: XuanZhuConfig,
  entry?: ModelEntry | null,
  signal?: AbortSignal,
): Promise<AgentsRewriteResult> {
  const facts = scanProject(cwd);
  const docs = generateProjectDocs(facts, {
    version: VERSION,
    date: localDate(),
  });
  const generated = buildAgentsDoc(facts, {
    version: VERSION,
    date: localDate(),
    generatedDocs: docs.map((doc) => doc.relPath),
  });
  const targetPath = resolveAgentsFilePath(cwd);
  const existing = fs.existsSync(targetPath)
    ? fs.readFileSync(targetPath, "utf8").trim() || null
    : null;

  const provider = createProvider(config, entry ?? undefined);
  const text = await collectText(
    provider,
    [
      {
        role: "system",
        content:
          "你是项目规范整理器。AGENTS.md 只写入口级大纲，细节必须指向 docs/；" +
          "输出完整 Markdown，不要解释或代码围栏。",
      },
      { role: "user", content: buildPrompt(cwd, facts, generated, existing) },
    ],
    signal,
  );
  const content = extractAgentsMarkdown(text);
  if (!/^#\s+/m.test(content) || content.trim().length < 20) {
    throw new Error("模型没有返回有效的 AGENTS.md（缺少 Markdown 标题）。");
  }
  return { content, existing, generated, facts, targetPath };
}

/** 原子写入 AGENTS.md；覆盖已有文件前备份 */
export function writeAgentsFile(
  cwd: string,
  content: string,
): { target: string; backup?: string } {
  const target = resolveAgentsFilePath(cwd);
  let backup: string | undefined;
  if (fs.existsSync(target)) {
    backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(target, backup);
  }
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content.trim() ? `${content.trim()}\n` : "", "utf8");
  fs.renameSync(tmp, target);
  return { target, backup };
}

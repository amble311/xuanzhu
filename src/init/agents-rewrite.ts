import * as fs from "fs";
import * as path from "path";
import { VERSION } from "../utils/version";
import { createProvider } from "../llm";
import type { ChatMessage, LLMProvider } from "../llm/types";
import type { ModelEntry, XuanZhuConfig } from "../config/store";
import { resolveAgentsFilePath } from "../workspace";
import { buildAgentsDoc, generateProjectDocs } from "./generate";
import { scanProject, type ProjectFacts } from "./scan";

const ALLOWED_DOCS = new Set([
  "docs/README.md",
  "docs/ARCHITECTURE.md",
  "docs/COMMANDS.md",
  "docs/CONVENTIONS.md",
]);

/**
 * 对话内 `/init` 的模型完善阶段：
 * 用项目扫描事实 + 现有 AGENTS.md/docs，让当前模型整理入口大纲与详细文档。
 *
 * 这里不把整个仓库塞给模型：扫描结果（commands、目录、文件数）和已生成草稿
 * 足够描述“项目实际内容”，也避免 prompt 过大。现有 AGENTS 全文会保留在提示里，
 * 由模型负责合并，避免覆盖用户手写约定。
 */

export interface AgentsDocUpdate {
  path: string;
  content: string;
}

export interface AgentsRewriteResult {
  content: string;
  existing: string | null;
  generated: string;
  facts: ProjectFacts;
  targetPath: string;
  /** 缺失的 docs 初始化文件（确认后写入） */
  scaffold: Array<{ path: string; content: string }>;
  /** 模型建议更新的 docs 文件（相对项目根） */
  docs: AgentsDocUpdate[];
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
  docsContext: string,
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
    "7. 如果 AGENTS.md 的设计/目录/命令/约定发生变化，必须同步更新对应的 docs 文件；",
    "   未变化的 docs 不要输出。",
    "8. 输出格式必须严格如下：",
    "<AGENTS>",
    "（完整 AGENTS.md 正文）",
    "</AGENTS>",
    "如需修改 docs，额外输出（只输出需要修改的文件，最多 4 个）：",
    "<DOC path=\"docs/README.md\">",
    "（完整文件正文）",
    "</DOC>",
    "9. 不要解释、不要代码围栏、不要省略号；默认中文。AGENTS 正文控制在 3000 字符以内。",
    "",
    `## 项目扫描事实\n${JSON.stringify(facts, null, 2).slice(0, 8_000)}`,
    "",
    `## 自动生成草稿（可参考，不要照抄空小节）\n${generated.slice(0, 8_000)}`,
    "",
    existingPart,
    readme ? `\n## README.md 摘要\n${readme}` : "",
    architecture ? `\n## docs/ARCHITECTURE.md 摘要\n${architecture}` : "",
    docsContext ? `\n## 现有 docs 内容\n${docsContext}` : "",
  ].join("\n");
}

/** 去掉模型偶尔多给的代码围栏/前置说明，只保留 Markdown 正文 */
export function parseAgentsRewriteResponse(raw: string): {
  content: string;
  docs: AgentsDocUpdate[];
} {
  const agentsMatch = /<AGENTS>\s*([\s\S]*?)\s*<\/AGENTS>/i.exec(raw);
  const docs: AgentsDocUpdate[] = [];
  for (const match of raw.matchAll(/<DOC\s+path="([^"]+)">\s*([\s\S]*?)\s*<\/DOC>/gi)) {
    const rel = match[1].trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!ALLOWED_DOCS.has(rel)) continue;
    const content = extractAgentsMarkdown(match[2]);
    if (content.trim()) docs.push({ path: rel, content });
  }
  return {
    content: extractAgentsMarkdown(agentsMatch?.[1] ?? raw),
    docs,
  };
}

function docsContext(cwd: string): string {
  const chunks: string[] = [];
  for (const rel of ALLOWED_DOCS) {
    const text = readExcerpt(path.join(cwd, rel), 2_000);
    if (text) chunks.push(`### ${rel}\n${text}`);
  }
  return chunks.join("\n\n");
}

/** 生成缺失的 docs 初始化文件；不写盘 */
export function buildDocsScaffold(cwd: string): Array<{ path: string; content: string }> {
  const facts = scanProject(cwd);
  const docs = generateProjectDocs(facts, {
    version: VERSION,
    date: localDate(),
  });
  return docs
    .filter((doc) => doc.relPath.startsWith("docs/"))
    .filter((doc) => !fs.existsSync(path.join(cwd, doc.relPath)))
    .map((doc) => ({ path: doc.relPath, content: doc.content }));
}


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
      maxTokens: 10_000,
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

  const scaffold = buildDocsScaffold(cwd);
  const provider = createProvider(config, entry ?? undefined);
  const text = await collectText(
    provider,
    [
      {
        role: "system",
        content:
          "你是项目规范整理器。AGENTS.md 只写入口级大纲，细节指向 docs/；" +
          "按指定标签输出 AGENTS 和需要更新的 docs，不要解释或代码围栏。",
      },
      {
        role: "user",
        content: buildPrompt(
          cwd,
          facts,
          generated,
          existing,
          docsContext(cwd),
        ),
      },
    ],
    signal,
  );
  const parsed = parseAgentsRewriteResponse(text);
  if (!/^#\s+/m.test(parsed.content) || parsed.content.trim().length < 20) {
    throw new Error("模型没有返回有效的 AGENTS.md（缺少 Markdown 标题）。");
  }
  return {
    content: parsed.content,
    existing,
    generated,
    facts,
    targetPath,
    scaffold,
    docs: parsed.docs,
  };
}

/** 原子写入 docs 文件；只允许 docs/ 下白名单路径，覆盖前备份 */
export function writeDocsFiles(
  cwd: string,
  files: Array<{ path: string; content: string }>,
): Array<{ target: string; backup?: string }> {
  const root = path.resolve(cwd);
  const results: Array<{ target: string; backup?: string }> = [];
  for (const file of files) {
    const rel = file.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!ALLOWED_DOCS.has(rel)) continue;
    const target = path.join(root, rel);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(`${path.join(root, "docs")}${path.sep}`)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let backup: string | undefined;
    if (fs.existsSync(target)) {
      backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(target, backup);
    }
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, file.content.trim() ? `${file.content.trim()}\n` : "", "utf8");
    fs.renameSync(tmp, target);
    results.push({ target, backup });
  }
  return results;
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

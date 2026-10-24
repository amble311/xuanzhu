import * as fs from "fs";
import * as path from "path";
import { VERSION } from "../utils/version";
import { generateProjectDocs } from "./generate";
import { scanProject, type ProjectFacts } from "./scan";

/**
 * `xzh init` —— 生成 / 补全项目开发规范（AGENTS.md + docs/）。
 *
 * 设计原则（见 README「初始化项目规范」）：
 * - **只写事实**：命令与目录来自扫描，不靠模型猜；
 * - **不覆盖用户内容**：已存在的文件做「按 `## 小节` 合并」——
 *   只追加原文件缺失的小节；`--force` 才整体覆盖，且覆盖前备份；
 * - **幂等**：内容没有变化时不写盘；重复运行只报告「已是最新」。
 */

export type InitAction = "create" | "append" | "overwrite" | "skip";

export interface InitFilePlan {
  /** 相对项目根的路径（如 AGENTS.md、docs/ARCHITECTURE.md） */
  relPath: string;
  absPath: string;
  action: InitAction;
  /** 最终要写入的内容（skip 时为现有内容） */
  content: string;
  /** append 时新增的小节标题 */
  appendedSections: string[];
  /** 已存在、但保留原样的小节标题（供报告说明） */
  keptSections: string[];
  /** 原文件字节数（不存在为 0） */
  existingBytes: number;
}

export interface InitPlan {
  cwd: string;
  facts: ProjectFacts;
  files: InitFilePlan[];
}

export interface InitApplyResult {
  written: Array<{ relPath: string; action: InitAction }>;
  /** 覆盖前备份出来的文件（绝对路径） */
  backups: string[];
}

function localDate(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

interface MarkdownSection {
  heading: string;
  raw: string;
}

/** 把生成的 Markdown 拆成「前言 + 若干 `## 小节`」 */
function splitMarkdown(markdown: string): {
  preamble: string;
  sections: MarkdownSection[];
} {
  const parts = markdown.split(/^(?=##\s)/m);
  const preamble = (parts.shift() ?? "").trimEnd();
  const sections: MarkdownSection[] = [];
  for (const part of parts) {
    const raw = part.trimEnd();
    const match = /^##\s+(.+)$/m.exec(raw);
    if (!match) continue;
    sections.push({ heading: match[1].trim(), raw });
  }
  return { preamble, sections };
}

function normalizeHeading(heading: string): string {
  return heading.replace(/\s+/g, " ").trim().toLowerCase();
}

function existingHeadings(markdown: string): Set<string> {
  const headings = new Set<string>();
  for (const match of markdown.matchAll(/^##\s+(.+)$/gm)) {
    headings.add(normalizeHeading(match[1]));
  }
  return headings;
}

/**
 * 按小节合并：只追加原文件里不存在的小节。
 * 已有同名小节一律保留原内容（不尝试「修正」——自动改写用户文档的风险远大于收益）。
 */
function mergeMarkdown(
  existing: string,
  generated: string,
): { content: string; appended: string[]; kept: string[] } {
  const { sections } = splitMarkdown(generated);
  const present = existingHeadings(existing);
  const appended: string[] = [];
  const kept: string[] = [];
  const blocks: string[] = [];

  for (const section of sections) {
    if (present.has(normalizeHeading(section.heading))) {
      kept.push(section.heading);
      continue;
    }
    appended.push(section.heading);
    blocks.push(section.raw);
  }

  if (blocks.length === 0) {
    return { content: existing, appended, kept };
  }

  const base = existing.trimEnd();
  return {
    content: `${base}${base ? "\n\n" : ""}${blocks.join("\n\n")}\n`,
    appended,
    kept,
  };
}

/** 扫描 + 生成，产出「每个文件要做什么」，不写盘 */
export function planInit(cwd: string, options: { force?: boolean } = {}): InitPlan {
  const root = path.resolve(cwd);
  const facts = scanProject(root);
  const generated = generateProjectDocs(facts, {
    version: VERSION,
    date: localDate(),
  });

  const files: InitFilePlan[] = [];
  for (const doc of generated) {
    const absPath = path.join(root, doc.relPath);
    let existing = "";
    let existingBytes = 0;
    try {
      existing = fs.readFileSync(absPath, "utf8");
      existingBytes = Buffer.byteLength(existing, "utf8");
    } catch {
      // 不存在
    }

    if (!existing) {
      files.push({
        relPath: doc.relPath,
        absPath,
        action: "create",
        content: doc.content,
        appendedSections: [],
        keptSections: [],
        existingBytes: 0,
      });
      continue;
    }

    if (options.force) {
      files.push({
        relPath: doc.relPath,
        absPath,
        action: "overwrite",
        content: doc.content,
        appendedSections: [],
        keptSections: [],
        existingBytes,
      });
      continue;
    }

    const merged = mergeMarkdown(existing, doc.content);
    files.push({
      relPath: doc.relPath,
      absPath,
      action: merged.appended.length > 0 ? "append" : "skip",
      content: merged.content,
      appendedSections: merged.appended,
      keptSections: merged.kept,
      existingBytes,
    });
  }

  return { cwd: root, facts, files };
}

/** 写入计划中的变更；覆盖已有文件前先备份 */
export function applyInit(plan: InitPlan): InitApplyResult {
  const written: InitApplyResult["written"] = [];
  const backups: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (const file of plan.files) {
    if (file.action === "skip") continue;

    fs.mkdirSync(path.dirname(file.absPath), { recursive: true });

    if (file.action === "overwrite" && fs.existsSync(file.absPath)) {
      const backup = `${file.absPath}.bak-${stamp}`;
      try {
        fs.copyFileSync(file.absPath, backup);
        backups.push(backup);
      } catch {
        // 备份失败时不覆盖 —— 宁可报错，也不要无备份地毁掉用户文档
        throw new Error(`备份失败，已取消覆盖：${file.relPath}`);
      }
    }

    fs.writeFileSync(file.absPath, file.content, "utf8");
    written.push({ relPath: file.relPath, action: file.action });
  }

  return { written, backups };
}

/** 计划的可读摘要（纯文本，调用方自行加颜色） */
export function summarizePlan(plan: InitPlan): string[] {
  const counts = {
    create: 0,
    append: 0,
    overwrite: 0,
    skip: 0,
  };
  for (const file of plan.files) counts[file.action] += 1;

  const lines: string[] = [];
  const parts: string[] = [];
  if (counts.create > 0) parts.push(`新建 ${counts.create}`);
  if (counts.append > 0) parts.push(`补充 ${counts.append}`);
  if (counts.overwrite > 0) parts.push(`覆盖 ${counts.overwrite}`);
  if (counts.skip > 0) parts.push(`跳过 ${counts.skip}`);
  lines.push(
    `项目：${plan.facts.name}${plan.facts.version ? `（v${plan.facts.version}）` : ""}` +
      ` · 扫描到 ${plan.facts.fileCount} 个文件、${plan.facts.directories.length} 个顶层目录`,
  );
  lines.push(`变更：${parts.length > 0 ? parts.join(" · ") : "无"}`);

  for (const file of plan.files) {
    const mark =
      file.action === "create"
        ? "+"
        : file.action === "append"
          ? "~"
          : file.action === "overwrite"
            ? "!"
            : "·";
    let suffix = "";
    if (file.action === "append" && file.appendedSections.length > 0) {
      suffix = `（补充：${file.appendedSections.join("、")}）`;
    } else if (file.action === "overwrite") {
      suffix = "（--force：覆盖前会备份）";
    } else if (file.action === "skip") {
      suffix = file.keptSections.length > 0 ? "（已存在，保留原内容）" : "（无变化）";
    }
    lines.push(`  ${mark} ${file.relPath}${suffix}`);
  }

  return lines;
}

/** 供 `--dry-run` 展示的预览内容（只含有变更的文件） */
export function previewPlan(plan: InitPlan): Array<{ relPath: string; content: string }> {
  return plan.files
    .filter((file) => file.action !== "skip")
    .map((file) => ({ relPath: file.relPath, content: file.content }));
}

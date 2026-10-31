import type { ProjectMemory } from "./index";

/**
 * 全局记忆的「按相关性注入」与自动 TTL。
 *
 * 全局记忆每次请求都会被注入，但它不应该无脑整段塞进去：
 * - 短记忆（<= threshold）直接全文注入，信息最完整；
 * - 长记忆只注入目录（## 主题 + 首行），再按当前用户消息挑相关小节；
 * - 自动记录（`## 自动记录 · ...`）里的日期行超过 TTL 会被清理，手工整理的小节不动。
 */

export interface MemorySection {
  heading: string;
  body: string;
}

/** 解析 Markdown 记忆为 `## 主题` 小节；preface 是第一个 ## 之前的内容 */
export function splitMemorySections(text: string): {
  preface: string;
  sections: MemorySection[];
} {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const preface: string[] = [];
  const sections: MemorySection[] = [];
  let current: MemorySection | null = null;

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current) sections.push(current);
      current = { heading: line.trim(), body: "" };
      continue;
    }
    if (current) current.body += `${line}\n`;
    else preface.push(line);
  }
  if (current) sections.push(current);

  return {
    preface: preface.join("\n").trim(),
    sections: sections.map((section) => ({
      heading: section.heading,
      body: section.body.trim(),
    })),
  };
}

function tokensOf(query: string): string[] {
  const raw = query
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fff]+/)
    .filter((token) => token.length >= 2);
  // 中文没有空格，补 2-gram，让「代理端口」能命中「网络代理」
  const grams: string[] = [];
  for (const token of raw) {
    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length > 2) {
      for (let i = 0; i < token.length - 1; i++) grams.push(token.slice(i, i + 2));
    }
  }
  return [...new Set([...raw, ...grams])].slice(0, 24);
}

function scoreSection(section: MemorySection, tokens: string[]): number {
  const heading = section.heading.toLowerCase();
  const body = section.body.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (heading.includes(token)) score += 6;
    let index = body.indexOf(token);
    let hits = 0;
    while (index >= 0 && hits < 5) {
      score += 1;
      hits++;
      index = body.indexOf(token, index + token.length);
    }
  }
  return score;
}

/** 长记忆的目录；每节只占一行，足够模型知道有什么，不占满上下文 */
export function globalMemoryIndex(text: string, maxChars = 1_200): string {
  const { preface, sections } = splitMemorySections(text);
  const lines: string[] = [];
  if (preface) lines.push(preface);

  for (const section of sections) {
    const first = section.body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith(">"));
    lines.push(`- ${section.heading.replace(/^##\s+/, "")}${first ? `：${first.slice(0, 120)}` : ""}`);
  }

  let output = "";
  for (const line of lines) {
    if (output.length + line.length + 1 > maxChars) {
      output += "\n…（目录已截断，可用 memory_read target=global 查看）";
      break;
    }
    output += `${output ? "\n" : ""}${line}`;
  }
  return output;
}

/**
 * 按当前用户消息挑相关小节。
 * 没有任何 token 命中时退回前若干节，避免「一条都没注入」。
 */
export function selectRelevantGlobalMemory(
  text: string,
  query: string,
  maxChars = 1_800,
): string {
  const { preface, sections } = splitMemorySections(text);
  if (sections.length === 0) return text.slice(0, maxChars);
  const tokens = tokensOf(query);

  const scored = sections
    .map((section, index) => ({
      section,
      index,
      score: scoreSection(section, tokens),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const picked = (tokens.length > 0 ? scored.filter((item) => item.score > 0) : [])
    .slice(0, 4);
  const chosen = picked.length > 0 ? picked : scored.slice(0, 2);
  const selected = new Set(chosen.map((item) => item.index));

  const parts: string[] = [];
  let used = 0;
  if (preface && tokens.length > 0) {
    parts.push(preface);
    used += preface.length;
  }
  for (const section of sections) {
    if (!selected.has(sections.indexOf(section))) continue;
    const block = `${section.heading}\n${section.body}`;
    if (used + block.length + 2 > maxChars) {
      parts.push(`${section.heading}\n（内容较长，可用 memory_read target=global 查看）`);
      break;
    }
    parts.push(block);
    used += block.length + 2;
  }
  return parts.join("\n\n");
}

/**
 * 清理全局记忆中过期的**自动记录**行（`- YYYY-MM-DD：...`）。
 * 只动 `## 自动记录 · ...` 小节；手工整理的小节永远不删。
 */
export function pruneAutoMemory(
  text: string,
  days: number,
  now = new Date(),
): { text: string; removed: number } {
  if (!Number.isFinite(days) || days <= 0) return { text, removed: 0 };
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inAuto = false;
  let removed = 0;

  let skipContinuation = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inAuto = /^##\s+(?:自动记录|网络代理)/.test(line);
      skipContinuation = false;
      out.push(line);
      continue;
    }
    if (inAuto) {
      const match = /^-\s+(\d{4}-\d{2}-\d{2})\s*[：:]/.exec(line.trim());
      if (match && match[1] < cutoff) {
        removed++;
        skipContinuation = true;
        continue;
      }
      // 删除日期行时，连同它缩进的续行一起删掉，避免留下无主说明。
      if (skipContinuation && /^\s{2,}\S/.test(line)) continue;
      skipContinuation = false;
    }
    out.push(line);
  }

  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

/** 类型别名，避免调用方依赖 workspace 的具体接口 */
export type GlobalMemorySnapshot = Pick<ProjectMemory, "longTerm" | "recentDaily">;

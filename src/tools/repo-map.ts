import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";

/**
 * 第三期：仓库地图与符号检索。
 *
 * 小上下文模型最怕「整文件塞进上下文」。这里用确定性扫描（不调用模型）建立
 * 「文件 → 符号（名称 / 类型 / 行号 / 签名）」的轻量索引，提供三个工具：
 *
 * - `repo_map`：按查询返回最相关的文件 / 符号，或项目目录概览；
 * - `find_symbol`：按名称定位定义；
 * - `read_symbol`：只读某个符号的代码范围，而不是整个文件。
 *
 * 索引是**进程内缓存 + TTL**：仓库在会话中变化时用 `refresh: true` 重建。
 * 解析是正则近似（不引入 tree-sitter），宁可漏掉冷门语法，也不误报大段内容。
 */

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "method"
  | "heading";

export interface RepoSymbol {
  name: string;
  kind: SymbolKind;
  file: string;
  /** 1-based */
  line: number;
  signature: string;
}

export interface RepoFile {
  /** 相对项目根 */
  path: string;
  lines: number;
  symbols: RepoSymbol[];
  /** 增量索引用：mtime / ctime / 文件大小；旧缓存可能没有 */
  mtimeMs?: number;
  ctimeMs?: number;
  sizeBytes?: number;
  /** 文件内容 SHA-1；用于 mtime/ctime/size 都没变但内容被改写的极端情况 */
  contentHash?: string;
}

export interface RepoIndex {
  root: string;
  files: RepoFile[];
  symbols: RepoSymbol[];
  builtAt: number;
}

const SKIP_DIRS = new Set([
  ".git",
  ".xuanzhu",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode-test",
  "target",
  "vendor",
]);

const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".scala",
  ".lua",
  ".dart",
  ".zig",
  ".sol",
  ".vue",
  ".svelte",
  ".sh",
  ".md",
]);

const BRACE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".swift",
]);

const MAX_FILES = 2000;
const MAX_SYMBOLS = 6000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SCAN_LINES = 3000;
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, RepoIndex>();

/** 清空索引缓存（测试 / 外部显式刷新） */
export function clearRepoIndexCache(): void {
  cache.clear();
}

function kindOfLine(
  ext: string,
  line: string,
): { name: string; kind: SymbolKind } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#!") && ext !== ".py") {
    return null;
  }

  if (ext === ".md") {
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading?.[2]) return { name: heading[2].slice(0, 100), kind: "heading" };
    return null;
  }

  // TypeScript / JavaScript
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    let m = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(
      trimmed,
    );
    if (m?.[1]) return { name: m[1], kind: "function" };
    m = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(
      trimmed,
    );
    if (m?.[1]) return { name: m[1], kind: "class" };
    m = /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    if (m?.[1]) return { name: m[1], kind: "interface" };
    m = /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    if (m?.[1]) return { name: m[1], kind: "type" };
    m = /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    if (m?.[1]) return { name: m[1], kind: "enum" };
    m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/.exec(
      trimmed,
    );
    if (m?.[1]) return { name: m[1], kind: "const" };
    // 类 / 对象里的方法（private buildConversation(...) { ... }）
    const methodStart = /^(?!(?:if|for|while|switch|catch|return|function|class|interface|type|enum|const|let|var)\b)(?:(?:public|private|protected|static|async|readonly|get|set|override)\s+)*([A-Za-z_$][\w$]*)\s*\(/.exec(
      trimmed,
    );
    if (methodStart?.[1]) {
      // 单行完整签名（带 `)` / 返回类型 / `{`），或跨行签名（只到 `(`）
      if (
        /\([^)]*\)\s*(?::[^={]+)?\s*\{?$/.test(trimmed) ||
        /\([^)]*$/.test(trimmed)
      ) {
        return { name: methodStart[1], kind: "method" };
      }
    }
    return null;
  }

  // Python
  if (ext === ".py") {
    let m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(trimmed);
    if (m?.[1]) return { name: m[1], kind: "function" };
    m = /^class\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (m?.[1]) return { name: m[1], kind: "class" };
    return null;
  }

  // Go
  if (ext === ".go") {
    let m = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/.exec(trimmed);
    if (m?.[1]) return { name: m[1], kind: "function" };
    m = /^type\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (m?.[1]) return { name: m[1], kind: "type" };
    return null;
  }

  // Rust
  if (ext === ".rs") {
    let m = /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (m?.[1]) return { name: m[1], kind: "function" };
    m = /^(?:pub\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (m?.[1]) return { name: m[1], kind: "type" };
    return null;
  }

  // Lua / Shell
  if (ext === ".lua") {
    const m = /^(?:local\s+)?function\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (m?.[1]) return { name: m[1], kind: "function" };
    return null;
  }
  if (ext === ".sh") {
    const m = /^(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/.exec(trimmed);
    if (m?.[1]) return { name: m[1], kind: "function" };
    return null;
  }

  // Java / Kotlin / C# / C++ / Scala / Swift 等：类型 + 常见方法
  let m = /^(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|open\s+|internal\s+|suspend\s+|sealed\s+|data\s+|inline\s+)*(?:class|interface|enum|record|object|trait)\s+([A-Za-z_]\w*)/.exec(
    trimmed,
  );
  if (m?.[1]) return { name: m[1], kind: "class" };
  m = /^(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|synchronized\s+|async\s+|override\s+|suspend\s+|internal\s+|open\s+|inline\s+)*(?:fun|fn|func|def)\s+([A-Za-z_]\w*)/.exec(
    trimmed,
  );
  if (m?.[1]) return { name: m[1], kind: "function" };
  return null;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.name.startsWith(".") && SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) {
          files.push(full);
        }
      }
    }
  };
  walk(root);
  return files;
}

/** 构建（或读取缓存）仓库索引 */
export function buildRepoIndex(root: string, refresh = false): RepoIndex {
  const cached = cache.get(root);
  if (!refresh && cached && Date.now() - cached.builtAt < CACHE_TTL_MS) {
    return cached;
  }

  const absRoot = path.resolve(root);
  const files: RepoFile[] = [];
  const symbols: RepoSymbol[] = [];
  const previous = new Map(cached?.files.map((file) => [file.path, file]) ?? []);

  for (const full of walkFiles(absRoot)) {
    if (symbols.length >= MAX_SYMBOLS) break;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    const rel = path.relative(absRoot, full).split(path.sep).join("/");
    const old = previous.get(rel);
    let content: string | undefined;
    let contentHash: string | undefined;
    const sameStat =
      old &&
      old.mtimeMs === stat.mtimeMs &&
      old.ctimeMs === stat.ctimeMs &&
      old.sizeBytes === stat.size;

    // 统计信息相同还不足以证明内容没变：同一毫秒内改写且大小不变时，
    // 再比对内容 hash。refresh 时直接重读，跳过复用。
    if (!refresh && old && sameStat) {
      try {
        content = fs.readFileSync(full, "utf8");
        contentHash = crypto
          .createHash("sha1")
          .update(content, "utf8")
          .digest("hex");
      } catch {
        continue;
      }
      if (old.contentHash && old.contentHash === contentHash) {
        files.push(old);
        symbols.push(...old.symbols);
        continue;
      }
    }

    if (content === undefined) {
      try {
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
    }
    if (content.includes("\0")) continue;
    contentHash ??= crypto.createHash("sha1").update(content, "utf8").digest("hex");
    const ext = path.extname(full).toLowerCase();
    const lines = content.split("\n");
    const fileSymbols: RepoSymbol[] = [];
    const scanTo = Math.min(lines.length, MAX_SCAN_LINES);
    for (let i = 0; i < scanTo && symbols.length < MAX_SYMBOLS; i++) {
      const parsed = kindOfLine(ext, lines[i]);
      if (!parsed) continue;
      const symbol: RepoSymbol = {
        name: parsed.name,
        kind: parsed.kind,
        file: rel,
        line: i + 1,
        signature: lines[i].trim().slice(0, 180),
      };
      fileSymbols.push(symbol);
      symbols.push(symbol);
    }
    files.push({
      path: rel,
      lines: lines.length,
      symbols: fileSymbols,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      sizeBytes: stat.size,
      contentHash,
    });
  }

  const index: RepoIndex = {
    root: absRoot,
    files,
    symbols,
    builtAt: Date.now(),
  };
  cache.set(absRoot, index);
  return index;
}

function tokensOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fff]+/)
    .filter((token) => token.length >= 2)
    .slice(0, 8);
}

function scoreText(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const token of tokens) if (lower.includes(token)) score += 1;
  return score;
}

/** 符号名精确匹配权重最高，前缀次之，签名命中最低 */
function scoreSymbol(symbol: RepoSymbol, tokens: string[]): number {
  const name = symbol.name.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name === token) score += 8;
    else if (name.startsWith(token)) score += 5;
    else if (name.includes(token)) score += 2;
    score += scoreText(symbol.signature, [token]);
  }
  return score;
}

function scoreFile(file: RepoFile, tokens: string[]): number {
  const lowerPath = file.path.toLowerCase();
  const base = path.basename(lowerPath);
  let score = scoreText(lowerPath, tokens) * 3 + scoreText(base, tokens) * 4;
  for (const symbol of file.symbols) score += scoreSymbol(symbol, tokens);
  return score;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function outputLimit(ctx: ToolContext): number {
  return Math.max(1000, ctx.limits?.maxOutputChars ?? 12_000);
}

function renderRepoMap(index: RepoIndex, query: string, limit: number): string {
  const tokens = tokensOf(query);
  const lines: string[] = [
    `[仓库地图] ${index.files.length} 个文件 · ${index.symbols.length} 个符号`,
  ];

  if (tokens.length === 0) {
    const dirs = new Map<string, { files: number; symbols: number }>();
    for (const file of index.files) {
      const top = file.path.includes("/") ? file.path.split("/")[0] : "（根目录）";
      const entry = dirs.get(top) ?? { files: 0, symbols: 0 };
      entry.files += 1;
      entry.symbols += file.symbols.length;
      dirs.set(top, entry);
    }
    lines.push("目录概览：");
    for (const [name, entry] of [...dirs.entries()]
      .sort((a, b) => b[1].files - a[1].files)
      .slice(0, 12)) {
      lines.push(`- ${name}/：${entry.files} 文件 · ${entry.symbols} 符号`);
    }
    lines.push("", "符号较多的文件：");
    for (const file of [...index.files]
      .sort((a, b) => b.symbols.length - a.symbols.length)
      .slice(0, limit)) {
      lines.push(`- ${file.path}（${file.lines} 行 · ${file.symbols.length} 符号）`);
    }
  } else {
    const scored = index.files
      .map((file) => ({ file, score: scoreFile(file, tokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
      .slice(0, limit);

    if (scored.length === 0) {
      lines.push(`没有匹配「${clip(query, 80)}」的文件或符号。`);
    } else {
      for (const { file } of scored) {
        const matched = file.symbols
          .map((symbol) => ({ symbol, score: scoreSymbol(symbol, tokens) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 6)
          .map((item) => item.symbol);
        lines.push("", `${file.path}（${file.lines} 行 · ${file.symbols.length} 符号）`);
        for (const symbol of matched) {
          lines.push(`  - ${symbol.kind} ${symbol.name}（第 ${symbol.line} 行）`);
        }
      }
    }
  }

  lines.push("", "· 用 find_symbol <名称> 精确定位，read_symbol 只读目标符号。");
  return lines.join("\n");
}

export const repoMapTool: ToolDefinition = {
  name: "repo_map",
  description:
    "查看仓库地图：按查询返回最相关的文件与符号（名称 / 行号），或返回目录概览。"
    + "适合先定位再读文件；索引不调用模型，`refresh` 可重建。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "任务关键词 / 符号名；为空时返回目录概览" },
      limit: { type: "integer", description: "最多返回的文件数（默认 15，最大 40）" },
      refresh: { type: "boolean", description: "忽略缓存，重新扫描仓库" },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const limit = Math.min(40, Math.max(1, Number(args.limit) || 15));
    const index = buildRepoIndex(ctx.cwd, args.refresh === true);
    const text = renderRepoMap(index, query, limit);
    return {
      ok: true,
      content: text.slice(0, outputLimit(ctx)),
      summary: `仓库地图：${index.files.length} 文件 / ${index.symbols.length} 符号`,
    };
  },
};

export const findSymbolTool: ToolDefinition = {
  name: "find_symbol",
  description:
    "按名称查找函数 / 类 / 类型 / 变量定义，返回 `文件:行号` 与签名。"
    + "支持名称片段；用于替代「先 grep 再逐个读文件」。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "符号名或名称片段（大小写不敏感）" },
      limit: { type: "integer", description: "最多返回多少条（默认 20，最大 50）" },
    },
    required: ["name"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return { ok: false, content: "错误：name 不能为空。" };
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
    const index = buildRepoIndex(ctx.cwd);
    const needle = name.toLowerCase();
    const exact: RepoSymbol[] = [];
    const partial: RepoSymbol[] = [];
    for (const symbol of index.symbols) {
      const lower = symbol.name.toLowerCase();
      if (lower === needle) exact.push(symbol);
      else if (lower.includes(needle)) partial.push(symbol);
      if (exact.length >= limit) break;
    }
    const found = [...exact, ...partial].slice(0, limit);
    if (found.length === 0) {
      return {
        ok: true,
        content: `没有找到符号「${name}」。可用 repo_map 查看仓库里有哪些符号。`,
        summary: "未找到符号",
      };
    }
    const lines = found.map(
      (symbol) =>
        `${symbol.file}:${symbol.line} [${symbol.kind}] ${symbol.name} — ${clip(symbol.signature, 120)}`,
    );
    return {
      ok: true,
      content: `[符号] ${name}\n${lines.join("\n")}`.slice(0, outputLimit(ctx)),
      summary: `找到 ${found.length} 个符号`,
    };
  },
};

/** 粗略计算符号结束行：花括号配对 / Python 缩进 / Markdown 标题 */
function symbolEndLine(
  lines: string[],
  start: number,
  ext: string,
  kind: SymbolKind,
): number {
  if (ext === ".md") {
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{1,3}\s+/.test(lines[i])) return i;
    }
    return Math.min(lines.length, start + 120);
  }

  if (ext === ".py") {
    const indentOf = (line: string): number => line.length - line.trimStart().length;
    const baseIndent = indentOf(lines[start]);
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (indentOf(line) <= baseIndent) return i;
    }
    return Math.min(lines.length, start + 200);
  }

  if (BRACE_EXTS.has(ext)) {
    let depth = 0;
    let sawBrace = false;
    for (let i = start; i < lines.length && i < start + 400; i++) {
      for (const char of lines[i]) {
        if (char === "{") {
          depth += 1;
          sawBrace = true;
        } else if (char === "}") {
          depth -= 1;
        }
      }
      if (sawBrace && depth <= 0 && i > start) return i + 1;
    }
    return Math.min(lines.length, start + 120);
  }

  return Math.min(lines.length, start + 80);
}

export const readSymbolTool: ToolDefinition = {
  name: "read_symbol",
  description:
    "只读取某个符号（函数 / 类 / 类型 / Markdown 标题）的代码范围，返回带行号的文本。"
    + "比 read_file 更省上下文；名称有歧义时用 path 指定文件。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "符号名（可用 find_symbol 先确认）" },
      path: { type: "string", description: "可选：限定在某个文件（相对项目根）" },
      max_lines: { type: "integer", description: "最多返回多少行（默认 200）" },
    },
    required: ["name"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return { ok: false, content: "错误：name 不能为空。" };
    const index = buildRepoIndex(ctx.cwd);
    const wantedPath =
      typeof args.path === "string" ? args.path.trim().replace(/^\.\//, "") : "";
    const candidates = index.symbols.filter(
      (symbol) =>
        symbol.name.toLowerCase() === name.toLowerCase() &&
        (!wantedPath || symbol.file === wantedPath),
    );
    if (candidates.length === 0) {
      return {
        ok: false,
        content: `没有找到符号「${name}」${wantedPath ? `（文件 ${wantedPath}）` : ""}。`,
      };
    }
    const symbol = candidates[0];
    const full = path.join(ctx.cwd, symbol.file);
    let lines: string[];
    try {
      lines = fs.readFileSync(full, "utf8").split("\n");
    } catch (err) {
      return {
        ok: false,
        content: `读取失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const end = symbolEndLine(lines, symbol.line - 1, path.extname(full).toLowerCase(), symbol.kind);
    const maxLines = Math.min(
      Math.max(20, Number(args.max_lines) || 200),
      ctx.limits?.maxReadLines ?? 400,
    );
    const from = symbol.line - 1;
    const to = Math.min(end, from + maxLines);
    const body = lines
      .slice(from, to)
      .map((line, i) => `${String(from + i + 1).padStart(6)}| ${line}`)
      .join("\n");
    const note =
      to < end ? `\n\n…（符号共 ${end - from} 行，本次只显示前 ${to - from} 行）` : "";
    return {
      ok: true,
      content:
        `[符号] ${symbol.file}:${symbol.line} [${symbol.kind}] ${symbol.name}\n\n` +
        `${body}${note}`,
      summary: `读取 ${symbol.name}`,
    };
  },
};

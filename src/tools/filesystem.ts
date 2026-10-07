import * as fs from "fs";
import * as path from "path";
import { expandHome } from "../utils/paths";
import type { ToolDefinition, ToolResult } from "./types";

const MAX_READ_LINES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_RESULTS = 200;
const MAX_GREP_FILE_BYTES = 1024 * 1024; // 1MB
/** 单行参与正则匹配的最大字符数（见 looksCatastrophic 的说明） */
const MAX_GREP_LINE_CHARS = 2000;

/**
 * 灾难性回溯（ReDoS）的粗筛。
 *
 * `grep` 的模式由模型给出，而 JS 正则**无法设置执行超时**：
 * 一个 `(a+)+$` 遇到长行就能让整个进程（含 TUI 事件循环）卡死。
 * 这里拦掉最典型的「量词叠加在可重复分组上」的形态，宁可误报让模型改写模式。
 */
function looksCatastrophic(patternText: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]/.test(patternText);
}

const IGNORED_DIRS = new Set([
  ".git",
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
]);

/**
 * 读取目录下的 .gitignore 模式串。
 *
 * 目的不是完整实现 gitignore 语义，而是**避免把项目显式忽略的文件读进来发给模型** ——
 * `.env`、`*.pem`、`*.key`、凭据文件通常都在 .gitignore 里，而 grep/glob 若不过滤，
 * 一次 `grep {pattern:"key"}` 就能把它们的明文内容送上模型。
 */
function loadGitignore(root: string): string[] {
  try {
    const file = path.join(root, ".gitignore");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
  } catch {
    return [];
  }
}

/** 判断相对路径是否命中某个 .gitignore 模式（简化匹配，宁可多忽略） */
function matchesGitignore(relative: string, patterns: string[]): boolean {
  const normalized = relative.split(path.sep).join("/");
  const base = path.basename(normalized);
  for (const pattern of patterns) {
    const trimmed = pattern.replace(/^\//, "").replace(/\/$/, "");
    if (!trimmed) continue;
    if (trimmed.includes("*")) {
      try {
        if (globToRegExp(trimmed).test(normalized)) return true;
        if (globToRegExp(trimmed).test(base)) return true;
      } catch {
        // 非法模式直接忽略
      }
      continue;
    }
    if (normalized === trimmed || normalized.startsWith(`${trimmed}/`)) return true;
    if (base === trimmed) return true;
  }
  return false;
}

function resolvePath(input: string, cwd: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

/** read_file */
export const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "读取文本文件内容，返回带行号的文本。支持通过 offset/limit 读取指定行范围。" +
    "在修改文件前应先读取确认内容。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径（绝对或相对当前目录）" },
      offset: {
        type: "integer",
        description: "起始行号（从 1 开始，可选）",
      },
      limit: {
        type: "integer",
        description: `最多读取的行数（默认 ${MAX_READ_LINES}）`,
      },
    },
    required: ["path"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const target = resolvePath(asString(args.path), ctx.cwd);
    if (!fs.existsSync(target)) {
      return { ok: false, content: `错误：文件不存在：${target}` };
    }
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      return { ok: false, content: `错误：${target} 是一个目录，请使用 list_dir` };
    }
    // 只接受普通文件。设备文件 / 命名管道 / socket 必须挡在这里：
    // `/dev/zero` 的 size 恒为 0（绕过下面的体积检查）且永远读不到 EOF，
    // 无写者的 FIFO 会直接阻塞，而 readFileSync 不可中断 —— 整个进程会被挂死。
    if (!stat.isFile()) {
      return {
        ok: false,
        content: `错误：${target} 不是普通文件（设备文件 / 管道 / socket），拒绝读取`,
      };
    }
    if (stat.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        content: `错误：文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），超出 2MB 限制`,
      };
    }

    const buffer = fs.readFileSync(target);
    if (isBinaryBuffer(buffer)) {
      return { ok: false, content: `错误：${target} 是二进制文件，无法作为文本读取` };
    }

    const allLines = buffer.toString("utf8").split("\n");
    const offset = Math.max(1, asNumber(args.offset, 1));
    const limit = Math.max(1, asNumber(args.limit, MAX_READ_LINES));
    const slice = allLines.slice(offset - 1, offset - 1 + limit);

    const body = slice
      .map((line, index) => {
        const lineNo = offset + index;
        return `${String(lineNo).padStart(6, " ")}| ${line}`;
      })
      .join("\n");

    const truncated =
      offset - 1 + limit < allLines.length
        ? `\n…（文件共 ${allLines.length} 行，已截断）`
        : "";

    return {
      ok: true,
      content: body + truncated,
      summary: `读取 ${slice.length} 行`,
    };
  },
};

/** write_file */
export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "写入（覆盖）文件。会创建缺失的父目录。请谨慎使用，优先使用 edit_file 做局部修改。",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      content: { type: "string", description: "要写入的完整文件内容" },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const target = resolvePath(asString(args.path), ctx.cwd);
    const content = asString(args.content);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
      return {
        ok: true,
        content: `已写入 ${target}（${content.length} 字符）`,
        summary: "写入成功",
      };
    } catch (err) {
      return {
        ok: false,
        content: `写入失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

/** edit_file */
export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "精确替换文件中的文本。将 search 指定的文本替换为 replace。" +
    "search 必须与文件内容完全一致（含缩进）；若 search 匹配到多处则默认拒绝执行，" +
    "需提供更精确的 search 或设置 replace_all 为 true。",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      search: { type: "string", description: "要被替换的原文（需精确匹配）" },
      replace: { type: "string", description: "替换后的新文本" },
      replace_all: {
        type: "boolean",
        description: "是否替换所有匹配项（默认 false）",
      },
    },
    required: ["path", "search", "replace"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const target = resolvePath(asString(args.path), ctx.cwd);
    if (!fs.existsSync(target)) {
      return { ok: false, content: `错误：文件不存在：${target}` };
    }
    const search = asString(args.search);
    const replace = asString(args.replace);
    const replaceAll = args.replace_all === true;

    if (!search) {
      return { ok: false, content: "错误：search 不能为空" };
    }

    const original = fs.readFileSync(target, "utf8");
    if (!original.includes(search)) {
      return {
        ok: false,
        content: `错误：在 ${target} 中未找到匹配文本。请先用 read_file 确认内容（注意缩进与换行需完全一致）。`,
      };
    }

    const occurrences = original.split(search).length - 1;

    // 多处匹配时默认拒绝执行：静默替换「第一处」极易改错位置
    //（例如 search 只写了 `"` 就会破坏配置文件），必须让调用方给出更精确的 search
    // 或显式声明 replace_all。
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        content:
          `错误：search 在 ${target} 中出现 ${occurrences} 处，为避免误改未执行。\n` +
          "请提供更精确的 search（带上前后文），或显式设置 replace_all: true 以替换全部匹配。",
      };
    }

    // 用函数形式替换：字符串形式的 replace 会把替换文本里的 `$&`、`$'`、`$1` 等
    // 当成反向引用展开，含 `$` 的内容（模板字符串、shell 变量、正则）会被悄悄改写。
    const updated = replaceAll
      ? original.split(search).join(replace)
      : original.replace(search, () => replace);

    fs.writeFileSync(target, updated, "utf8");
    return {
      ok: true,
      content: `已更新 ${target}（替换 ${replaceAll ? occurrences : 1} 处）`,
      summary: `替换 ${replaceAll ? occurrences : 1} 处`,
    };
  },
};

/** list_dir */
export const listDirTool: ToolDefinition = {
  name: "list_dir",
  description: "列出目录中的文件与子目录。省略 path 时列出当前工作目录。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径（可选）" },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const target = args.path
      ? resolvePath(asString(args.path), ctx.cwd)
      : ctx.cwd;
    if (!fs.existsSync(target)) {
      return { ok: false, content: `错误：目录不存在：${target}` };
    }
    if (!fs.statSync(target).isDirectory()) {
      return { ok: false, content: `错误：${target} 不是目录` };
    }

    const entries = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((entry) => !IGNORED_DIRS.has(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const formatted = entries.map((entry) => {
      const suffix = entry.isDirectory() ? "/" : "";
      return `${entry.isDirectory() ? "DIR " : "FILE"} ${entry.name}${suffix}`;
    });

    return {
      ok: true,
      content: `${target}\n${formatted.join("\n") || "(空目录)"}`,
      summary: `${entries.length} 项`,
    };
  },
};

/** glob */
export const globTool: ToolDefinition = {
  name: "glob",
  description:
    "按通配符查找文件，支持 **、*、? 语法。例如 'src/**/*.ts'。返回匹配的文件路径。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob 模式，如 '**/*.ts'" },
      path: { type: "string", description: "搜索起始目录（可选，默认当前目录）" },
    },
    required: ["pattern"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const pattern = asString(args.pattern);
    if (!pattern) return { ok: false, content: "错误：pattern 不能为空" };
    const root = args.path ? resolvePath(asString(args.path), ctx.cwd) : ctx.cwd;
    const matcher = globToRegExp(pattern);
    const matches: string[] = [];

    walk(root, (filePath) => {
      if (matches.length >= MAX_GLOB_RESULTS) return;
      const relative = path.relative(root, filePath).split(path.sep).join("/");
      if (matcher.test(relative)) matches.push(relative);
    });

    if (matches.length === 0) {
      return { ok: true, content: "未找到匹配的文件。" };
    }
    const truncated =
      matches.length >= MAX_GLOB_RESULTS
        ? `\n…（已达 ${MAX_GLOB_RESULTS} 条上限）`
        : "";
    return {
      ok: true,
      content: matches.join("\n") + truncated,
      summary: `${matches.length} 个文件`,
    };
  },
};

/** grep */
export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "在文件中按正则表达式搜索文本内容。返回 文件:行号:内容。可通过 include 限定文件类型（如 '*.ts'）。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式" },
      path: { type: "string", description: "搜索目录（可选，默认当前目录）" },
      include: {
        type: "string",
        description: "文件名通配符过滤，如 '*.ts'（可选）",
      },
    },
    required: ["pattern"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const patternText = asString(args.pattern);
    if (!patternText) return { ok: false, content: "错误：pattern 不能为空" };
    if (looksCatastrophic(patternText)) {
      return {
        ok: false,
        content:
          `错误：正则可能存在灾难性回溯（嵌套量词，如 (a+)+），已拒绝执行以免卡死进程。\n` +
          `请改写为等价但更安全的模式，例如用 [^x]* 代替 (.*)+。`,
      };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(patternText);
    } catch (err) {
      return {
        ok: false,
        content: `错误：无效的正则表达式：${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const root = args.path ? resolvePath(asString(args.path), ctx.cwd) : ctx.cwd;
    const include = args.include ? globToRegExp(asString(args.include)) : null;
    const ignore = loadGitignore(root);
    const results: string[] = [];

    walk(root, (filePath) => {
      if (results.length >= MAX_GREP_RESULTS) return;
      // 跳过 .gitignore 里显式忽略的文件（.env / 密钥 / 凭据等）
      if (ignore.length > 0 && matchesGitignore(path.relative(root, filePath), ignore)) {
        return;
      }
      const relative = path.relative(root, filePath).split(path.sep).join("/");
      if (include && !include.test(relative) && !include.test(path.basename(filePath))) {
        return;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return;
      }
      if (stat.size > MAX_GREP_FILE_BYTES || stat.size === 0) return;

      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(filePath);
      } catch {
        return;
      }
      if (isBinaryBuffer(buffer)) return;

      const lines = buffer.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= MAX_GREP_RESULTS) return;
        const line = lines[i];
        // 截断后再匹配：指数级回溯需要足够长的输入才会爆炸，
        // 限制长度即可把最坏情况压回可接受范围（正常代码行远达不到此长度）。
        const subject =
          line.length > MAX_GREP_LINE_CHARS
            ? line.slice(0, MAX_GREP_LINE_CHARS)
            : line;
        if (regex.test(subject)) {
          results.push(`${relative}:${i + 1}: ${line.trim().slice(0, 300)}`);
        }
      }
    });

    if (results.length === 0) {
      return { ok: true, content: "未找到匹配内容。" };
    }
    const truncated =
      results.length >= MAX_GREP_RESULTS
        ? `\n…（已达 ${MAX_GREP_RESULTS} 条上限）`
        : "";
    return {
      ok: true,
      content: results.join("\n") + truncated,
      summary: `${results.length} 条匹配`,
    };
  },
};

function walk(root: string, onFile: (filePath: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walk(full, onFile);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      onFile(full);
    }
  }
}

/** 将 glob 模式编译为正则表达式 */
export function globToRegExp(pattern: string): RegExp {
  let regex = "";
  const normalized = pattern.split(path.sep).join("/");
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        // ** 跨目录匹配
        i++;
        if (normalized[i + 1] === "/") {
          i++;
          regex += "(?:.*/)?";
        } else {
          regex += ".*";
        }
      } else {
        regex += "[^/]*";
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else if (ch === "{") {
      const close = normalized.indexOf("}", i);
      if (close !== -1) {
        const options = normalized
          .slice(i + 1, close)
          .split(",")
          .map(escapeRegExp)
          .join("|");
        regex += `(?:${options})`;
        i = close;
      } else {
        regex += "\\{";
      }
    } else {
      regex += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${regex}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

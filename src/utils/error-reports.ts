import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getConfigDir } from "./paths";
import { VERSION } from "./version";

/**
 * 错误报告（bug 收集）。
 *
 * 目的：用户反馈「用着用着报错了」时，能拿到**可复现的现场**，而不是一句转述。
 * 因此把「出了什么错 + 在什么环境下出的」落成结构化文件，而不是只往 `crash.log` 里
 * 追加一段给人看的文本：
 *   - 位置：`~/.xzh/errors/`（全局，因为它描述的是**玄猪本身**的问题，与项目无关；
 *     报告里带 `cwd` / `project` 作为上下文）；
 *   - 一份报告 = 一个文件，文件名是**签名哈希**：同样的错误反复出现只累加 `count`，
 *     不会刷出几十份重复文件（这类噪音会让真正的新问题被埋掉）；
 *   - 上限 `MAX_REPORTS`：超出后按 `lastTime` 丢弃最旧的。
 *
 * 只记「异常」这一类信号，**不记**工具的正常失败（`ok: false` 的返回），
 * 也不记用户的配置错误之外的普通提示 —— 那是使用方式问题，不是 bug。
 */

/** 报告目录：`~/.xzh/errors` */
export function errorReportsDir(): string {
  return path.join(getConfigDir(), "errors");
}

/** 最多保留多少份不同签名的报告 */
export const MAX_ERROR_REPORTS = 50;

export type ErrorKind =
  | "uncaught-exception"
  | "unhandled-rejection"
  | "tool-error"
  | "turn-failed";

/**
 * 粗分类，用来快速判断「这是谁的问题」：
 * - `bug`：玄猪自身或工具实现抛异常（最需要收集）
 * - `provider`：模型服务返回错误（网络 / 限流 / 服务端）
 * - `config`：密钥、端点、模型名等配置问题
 * - `unknown`：判断不了，先记下来
 */
export type ErrorCategory = "bug" | "provider" | "config" | "unknown";

export interface ErrorReportContext {
  cwd?: string;
  /** 项目级目录（`<cwd>/.xuanzhu`） */
  project?: string;
  /** 当前模型 id（如 `custom/mix`） */
  model?: string;
  provider?: string;
}

export interface ErrorReportInput extends ErrorReportContext {
  kind: ErrorKind;
  category?: ErrorCategory;
  error: unknown;
  /** 出错的工具名（`kind: "tool-error"` 时） */
  tool?: string;
  /** 附加说明，例如「所有模型都失败」 */
  note?: string;
  /** 最近几条消息（用于复现；会被截断与脱敏） */
  recent?: Array<{ role: string; content: string }>;
}

export interface ErrorReport extends ErrorReportContext {
  /** 签名（文件名去掉 .json），同签名即同一类错误 */
  signature: string;
  kind: ErrorKind;
  category: ErrorCategory;
  message: string;
  stack?: string;
  firstTime: string;
  lastTime: string;
  count: number;
  version: string;
  node: string;
  platform: string;
  arch: string;
  pid: number;
  tool?: string;
  note?: string;
  recent?: Array<{ role: string; content: string }>;
}

/** 最近消息在报告里的单条上限（够看出上下文，又不至于把整段代码塞进去） */
const RECENT_MESSAGE_CHARS = 200;
/** 最近消息最多保留几条 */
const RECENT_MESSAGES = 6;
/** 堆栈最多保留多少字符 */
const STACK_CHARS = 4000;

/** 常见密钥形态：进报告前先抹掉，避免用户随手把报告贴到公开 issue 时泄露 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{8,}/g, "sk-***"],
  [/AIza[A-Za-z0-9_-]{10,}/g, "AIza***"],
  [/(gh[pousr]_)[A-Za-z0-9]{10,}/g, "$1***"],
  [/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1***"],
  [/((?:api[_-]?key|token|password|secret)\s*[":=]+\s*)[^\s",]{6,}/gi, "$1***"],
];

function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function stackOf(error: unknown): string | undefined {
  return error instanceof Error && error.stack
    ? truncate(redact(error.stack), STACK_CHARS)
    : undefined;
}

/** 签名：同一类错误（同种类 + 同工具 + 同消息 + 同堆栈前几行）归为一份报告 */
function signatureOf(kind: ErrorKind, tool: string | undefined, message: string, stack?: string): string {
  const stackHead = (stack ?? "").split("\n").slice(0, 3).join("\n");
  return crypto
    .createHash("sha1")
    .update(`${kind}|${tool ?? ""}|${message}|${stackHead}`)
    .digest("hex")
    .slice(0, 10);
}

let reporting = false;

/**
 * 记录一份错误报告，返回文件路径（写盘失败返回 `null`）。
 *
 * 永远不会抛错：它自己就在错误处理路径上，再抛一次只会把原始错误盖掉。
 */
export function recordErrorReport(input: ErrorReportInput): string | null {
  // 防重入：写报告期间若又触发未捕获异常，直接放弃这一次
  if (reporting) return null;
  reporting = true;
  try {
    const now = new Date().toISOString();
    const message = truncate(redact(messageOf(input.error)), 800);
    const stack = stackOf(input.error);
    const signature = signatureOf(input.kind, input.tool, message, stack);
    const dir = errorReportsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${signature}.json`);

    const recent = input.recent
      ?.slice(-RECENT_MESSAGES)
      .map((item) => ({
        role: item.role,
        content: truncate(redact(item.content ?? ""), RECENT_MESSAGE_CHARS),
      }));

    const common = {
      kind: input.kind,
      category: input.category ?? "unknown",
      message,
      version: VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      cwd: input.cwd ?? process.cwd(),
      project: input.project,
      model: input.model,
      provider: input.provider,
      tool: input.tool,
      note: input.note,
      recent,
    };

    const existing = readReportFile(file);
    const report: ErrorReport = existing
      ? {
          ...existing,
          // 复现环境取**最近一次**的（用户可能换了模型 / 目录），首次时间与堆栈保留
          ...common,
          signature,
          stack: existing.stack ?? stack,
          firstTime: existing.firstTime,
          lastTime: now,
          count: existing.count + 1,
        }
      : {
          signature,
          ...common,
          stack,
          firstTime: now,
          lastTime: now,
          count: 1,
        };

    writeReportFile(file, report);
    pruneErrorReports();
    return file;
  } catch {
    return null;
  } finally {
    reporting = false;
  }
}

function readReportFile(file: string): ErrorReport | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ErrorReport;
    if (!parsed || typeof parsed.signature !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeReportFile(file: string, report: ErrorReport): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 超出上限时按 lastTime 丢弃最旧的报告 */
function pruneErrorReports(): void {
  const reports = listErrorReports();
  if (reports.length <= MAX_ERROR_REPORTS) return;
  for (const report of reports.slice(MAX_ERROR_REPORTS)) {
    try {
      fs.rmSync(path.join(errorReportsDir(), `${report.signature}.json`), { force: true });
    } catch {
      // 尽力而为
    }
  }
}

/** 按 `lastTime` 从新到旧列出全部报告（损坏的文件跳过） */
export function listErrorReports(): ErrorReport[] {
  let names: string[];
  try {
    names = fs.readdirSync(errorReportsDir()).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const reports: ErrorReport[] = [];
  for (const name of names) {
    const report = readReportFile(path.join(errorReportsDir(), name));
    if (report) reports.push(report);
  }
  return reports.sort((a, b) => b.lastTime.localeCompare(a.lastTime));
}

/**
 * 把 `xzh errors show <选择器>` 的选择器解析成报告：
 * 支持 1 起的序号（按 `listErrorReports()` 的顺序）、签名、签名前缀或完整文件名。
 */
export function findErrorReport(
  selector: string,
  reports: ErrorReport[] = listErrorReports(),
): ErrorReport | undefined {
  const text = selector.trim().replace(/\.json$/, "");
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return reports[Number(text) - 1];
  return (
    reports.find((report) => report.signature === text) ??
    reports.find((report) => report.signature.startsWith(text))
  );
}

/** 清空全部报告，返回删除的份数 */
export function clearErrorReports(): number {
  const reports = listErrorReports();
  try {
    fs.rmSync(errorReportsDir(), { recursive: true, force: true });
  } catch {
    return 0;
  }
  return reports.length;
}

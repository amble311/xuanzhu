import * as fs from "fs";
import * as path from "path";
import type { XuanZhuConfig } from "../config/store";
import { resolveProjectPaths } from "../workspace";
import { redactSecrets } from "../llm/http";

/**
 * 自治等级：模型**能对环境做多大的改动**。
 *
 * 为什么要有三档而不是一个「自动批准」开关：真实使用里有第三种诉求 ——
 * **先看它打算做什么，再决定放不放行**。全自动不敢开（怕它一把改错），
 * 逐项确认又太打断（其实大部分操作都是对的）。`observe` 就是这一档：
 * 读照常做，**写与执行一律拦截并记账**，用户看完记录再切 `auto`。
 *
 * 三档的确定性边界（由代码执行，不靠提示词）：
 * - `ask`     —— 危险工具逐项确认；
 * - `observe` —— 危险工具**不执行**，只写一条 `observe.log`；
 * - `auto`    —— 全部直接执行。
 *
 * `observe` 只拦「改环境」的工具。记忆、任务清单、状态上报属于会话记账，
 * 拦掉它们只会让模型失去进度记忆，对安全没有帮助。
 */
export type AutonomyMode = "ask" | "observe" | "auto";

export const AUTONOMY_MODES: AutonomyMode[] = ["ask", "observe", "auto"];

/**
 * `observe` 模式下会被拦截的工具。
 *
 * 判断标准是「跑完之后本机状态会变」：写文件、执行命令、动手机。
 * 读文件 / 搜索 / 读后台输出都不拦 —— 观察模式的意义正是先把情况看清。
 */
export const OBSERVE_BLOCKED_TOOLS = new Set([
  "write_file",
  "edit_file",
  "bash",
  "bash_kill",
  "device_run",
  "device_push",
  "device_stop",
]);

/** 当前生效的自治等级；旧配置没有该字段时按 autoApprove 推导，行为不变 */
export function autonomyModeOf(config: XuanZhuConfig): AutonomyMode {
  const mode = config.autonomy;
  if (mode === "ask" || mode === "observe" || mode === "auto") return mode;
  return config.autoApprove === false ? "ask" : "auto";
}

/** observe 日志路径（项目级；与运行目录绑定，`/switch` 后落到新项目里） */
export function observeLogPath(cwd: string): string {
  return path.join(resolveProjectPaths(cwd).dir, "state", "observe.log");
}

/** 日志上限：超过后只保留最近一半，避免无限增长 */
const MAX_OBSERVE_LOG_BYTES = 256 * 1024;

/**
 * 记一条「本来会执行」的操作。
 *
 * 只记工具名与参数摘要（凭据已脱敏）：这份日志是给人看的，
 * 目的是让人快速判断「它想做什么」，不是完整审计流水。
 */
export function recordObservedAction(
  cwd: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  const file = observeLogPath(cwd);
  const detail = summarizeArgs(toolName, args);
  const line = `[${new Date().toISOString()}] ${toolName} ${detail}\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_OBSERVE_LOG_BYTES) {
        const raw = fs.readFileSync(file, "utf8");
        fs.writeFileSync(file, raw.slice(-Math.floor(MAX_OBSERVE_LOG_BYTES / 2)), "utf8");
      }
    } catch {
      // 文件还不存在
    }
    fs.appendFileSync(file, line, "utf8");
  } catch {
    // 记账失败不影响拦截本身
  }
  return file;
}

/** 读取最近的观察记录（供 `/autonomy` 展示），默认 10 条 */
export function readObservedActions(cwd: string, limit = 10): string[] {
  try {
    const raw = fs.readFileSync(observeLogPath(cwd), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

/** 单条记录里展示多少字符 */
const MAX_DETAIL = 200;

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  const pick = (key: string): string =>
    typeof args[key] === "string" ? (args[key] as string) : "";
  let detail: string;
  if (toolName === "bash") {
    detail = pick("command");
  } else if (toolName === "bash_kill") {
    detail = pick("job_id");
  } else if (toolName === "device_push" || toolName === "device_run") {
    detail = `${pick("file")}${pick("path")}`;
  } else if (toolName === "write_file" || toolName === "edit_file") {
    const size =
      typeof args.content === "string"
        ? `（${args.content.length} 字符）`
        : typeof args.new_str === "string"
          ? `（替换 ${args.new_str.length} 字符）`
          : "";
    detail = `${pick("path")}${size}`;
  } else {
    detail = Object.keys(args).join(",");
  }
  const flat = redactSecrets(detail).replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}…` : flat || "（无参数）";
}

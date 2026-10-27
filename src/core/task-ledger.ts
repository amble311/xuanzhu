import * as fs from "fs";
import * as path from "path";
import type { TodoItem } from "../tools/types";
import { resolveProjectPaths } from "../workspace";

/**
 * 任务账本（Phase 2）。
 *
 * 上下文是缓存，不是仓库：对话被裁剪后，模型不该靠残片猜「做到哪了」。
 * 这里把**确定性事实**落到 `<项目>/.xuanzhu/state/task.json`：
 * 当前任务、计划、已完成步骤、决策、改动文件、验证状态、未决问题、工作集。
 *
 * 生命周期规则（见 README）：
 * - 启动时把上次遗留的 `active` 降级为 `paused`，**绝不自动继续**；
 * - 用户中断且本轮 0 次工具调用 → `abandoned`（大概率误发）；
 * - 有工具副作用的中断 → `paused`（保留事实，等用户显式继续）；
 * - 完成目标 / 用户明确放弃 → `completed` / `abandoned`。
 */
export type TaskStatus = "active" | "paused" | "completed" | "abandoned";

export interface TaskVerification {
  command?: string;
  ok?: boolean;
  at: string;
}

export interface TaskLedger {
  version: 1;
  /** 用户最初的要求（截断后），用于列表与摘要 */
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  /** 最近一条用户消息 */
  lastUserMessage: string;
  /** 目标模式的目标文本 */
  goal?: string;
  /** todo_write 的最新快照 */
  plan: TodoItem[];
  /** 已完成的关键步骤 / 结论（新的在后，最多保留 12 条） */
  done: string[];
  /** 已确定的技术决策 */
  decisions: string[];
  /** 本次任务改动过的文件 */
  changedFiles: string[];
  /** 最近一次验证 */
  verification?: TaskVerification;
  /** 未决问题 / 需要用户决定的事项 */
  openQuestions: string[];
  /** `/focus` 钉住的工作集文件 */
  focusFiles: string[];
  /** `/compact` 生成的滚动摘要 */
  summary?: string;
  /** 最近一次最终答复的首行 */
  lastConclusion?: string;
}

const MAX_TITLE = 120;
const MAX_USER = 500;
const MAX_DONE = 12;
const MAX_DECISIONS = 8;
const MAX_OPEN = 8;
const MAX_FOCUS = 20;
const MAX_CONCLUSION = 240;

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const uniquePush = (list: string[], value: string, max: number): void => {
  const clean = value.trim();
  if (!clean) return;
  if (list.includes(clean)) return;
  list.push(clean);
  if (list.length > max) list.splice(0, list.length - max);
};

/** 任务账本文件路径 */
export function taskLedgerPath(cwd: string): string {
  return path.join(resolveProjectPaths(cwd).dir, "state", "task.json");
}

/** 新建一个任务账本 */
export function createTaskLedger(userMessage: string, now = new Date()): TaskLedger {
  const stamp = now.toISOString();
  const message = clip(userMessage, MAX_USER);
  return {
    version: 1,
    title: clip(message, MAX_TITLE) || "未命名任务",
    status: "active",
    createdAt: stamp,
    updatedAt: stamp,
    lastUserMessage: message,
    plan: [],
    done: [],
    decisions: [],
    changedFiles: [],
    openQuestions: [],
    focusFiles: [],
  };
}

/** 读取任务账本；不存在 / 损坏时返回 `null` */
export function loadTaskLedger(cwd: string): TaskLedger | null {
  const file = taskLedgerPath(cwd);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<TaskLedger>;
    if (!raw || raw.version !== 1 || typeof raw.title !== "string") return null;
    const now = new Date().toISOString();
    return {
      version: 1,
      title: clip(raw.title, MAX_TITLE),
      status:
        raw.status === "paused" ||
        raw.status === "completed" ||
        raw.status === "abandoned" ||
        raw.status === "active"
          ? raw.status
          : "paused",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
      lastUserMessage:
        typeof raw.lastUserMessage === "string"
          ? clip(raw.lastUserMessage, MAX_USER)
          : "",
      ...(typeof raw.goal === "string" && raw.goal.trim()
        ? { goal: clip(raw.goal, MAX_TITLE) }
        : {}),
      plan: Array.isArray(raw.plan)
        ? raw.plan
            .filter(
              (item): item is TodoItem =>
                Boolean(item) &&
                typeof item.content === "string" &&
                ["pending", "in_progress", "completed", "cancelled"].includes(
                  String(item.status),
                ),
            )
            .map((item) => ({ content: clip(item.content, 200), status: item.status }))
        : [],
      done: Array.isArray(raw.done)
        ? raw.done.filter((item): item is string => typeof item === "string").slice(-MAX_DONE)
        : [],
      decisions: Array.isArray(raw.decisions)
        ? raw.decisions
            .filter((item): item is string => typeof item === "string")
            .slice(-MAX_DECISIONS)
        : [],
      changedFiles: Array.isArray(raw.changedFiles)
        ? raw.changedFiles.filter((item): item is string => typeof item === "string")
        : [],
      ...(raw.verification && typeof raw.verification === "object"
        ? {
            verification: {
              ...(typeof raw.verification.command === "string"
                ? { command: clip(raw.verification.command, 200) }
                : {}),
              ...(typeof raw.verification.ok === "boolean"
                ? { ok: raw.verification.ok }
                : {}),
              at:
                typeof raw.verification.at === "string"
                  ? raw.verification.at
                  : now,
            },
          }
        : {}),
      openQuestions: Array.isArray(raw.openQuestions)
        ? raw.openQuestions
            .filter((item): item is string => typeof item === "string")
            .slice(-MAX_OPEN)
        : [],
      focusFiles: Array.isArray(raw.focusFiles)
        ? raw.focusFiles.filter((item): item is string => typeof item === "string").slice(-MAX_FOCUS)
        : [],
      ...(typeof raw.summary === "string" && raw.summary.trim()
        ? { summary: raw.summary.trim() }
        : {}),
      ...(typeof raw.lastConclusion === "string" && raw.lastConclusion.trim()
        ? { lastConclusion: clip(raw.lastConclusion, MAX_CONCLUSION) }
        : {}),
    };
  } catch {
    return null;
  }
}

/** 原子写入任务账本（失败不抛异常：账本是尽力而为） */
export function saveTaskLedger(cwd: string, ledger: TaskLedger): void {
  try {
    const file = taskLedgerPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } catch {
    // 账本写不进去不能影响主流程
  }
}

/** 删除任务账本（`/reset` 或用户放弃时） */
export function clearTaskLedger(cwd: string): void {
  try {
    fs.rmSync(taskLedgerPath(cwd), { force: true });
  } catch {
    // 忽略
  }
}

/** 更新 `updatedAt` 并写入 */
export function touchTaskLedger(cwd: string, ledger: TaskLedger): void {
  ledger.updatedAt = new Date().toISOString();
  saveTaskLedger(cwd, ledger);
}

/**
 * 账本摘要：在历史被裁剪 / `/compact` 后注入，让模型知道「做到哪了」。
 * 保持很短（默认 ≤ 700 字符），只放当前任务最关键的确定性事实。
 */
export function formatTaskDigest(task: TaskLedger, maxChars = 700): string | null {
  const lines: string[] = [];
  const status =
    task.status === "active"
      ? "进行中"
      : task.status === "paused"
        ? "已暂停"
        : task.status === "completed"
          ? "已完成"
          : "已放弃";
  lines.push(`- 任务：${clip(task.title, 100)}（${status}）`);

  if (task.summary) {
    lines.push(`- 摘要：${clip(task.summary, 260)}`);
  }
  const done = task.done.slice(-3);
  if (done.length > 0) {
    lines.push(`- 已完成：${done.map((item) => clip(item, 90)).join("；")}`);
  }
  if (task.decisions.length > 0) {
    lines.push(
      `- 决策：${task.decisions
        .slice(-2)
        .map((item) => clip(item, 90))
        .join("；")}`,
    );
  }
  if (task.openQuestions.length > 0) {
    lines.push(
      `- 未决：${task.openQuestions
        .slice(-3)
        .map((item) => clip(item, 90))
        .join("；")}`,
    );
  }
  if (task.focusFiles.length > 0) {
    lines.push(`- 工作集：${task.focusFiles.slice(-6).map((item) => clip(item, 60)).join("、")}`);
  }
  if (task.verification?.command) {
    lines.push(
      `- 最近验证：${clip(task.verification.command, 80)}（${
        task.verification.ok ? "通过" : "失败"
      }）`,
    );
  }

  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
  return text;
}

/** 记录一条已完成步骤/结论（自动去重、限量） */
export function addTaskDone(task: TaskLedger, conclusion: string): void {
  uniquePush(task.done, clip(conclusion, MAX_CONCLUSION), MAX_DONE);
}

/** 记录一条决策（自动去重、限量） */
export function addTaskDecision(task: TaskLedger, decision: string): void {
  uniquePush(task.decisions, clip(decision, 240), MAX_DECISIONS);
}

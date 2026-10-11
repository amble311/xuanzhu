import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ChatMessage } from "../llm/types";
import { ensureDir, getConfigDir } from "../utils/paths";

/**
 * 会话的**增量持久化**。
 *
 * 对话历史原本只在内存（Agent.history），退出 / 崩溃即丢失。
 * 每个会话对应一个 JSONL 文件（`~/.xzh/sessions/<项目>-<哈希>/<时间戳>.jsonl`）：
 * 第一行是元信息，其后每行一条消息 —— 每次提交历史时**增量追加**，
 * 因此即使进程崩溃，最多丢掉崩溃瞬间未提交的那一轮。
 *
 * 恢复用 `/resume`：读回消息数组整体替换 Agent.history，
 * 此后的轮次写入**新的**会话文件（旧文件保留为存档）。
 *
 * 图片（base64）**不写入**会话文件：一张截图就是几百 KB～几 MB，
 * 会把 JSONL 撑到不可读。恢复后的历史本来也会被 `stripStaleImages` 降级旧图，
 * 因此这里提前降级并标注，行为一致。
 */

function sessionsRoot(): string {
  return path.join(getConfigDir(), "sessions");
}

/** 会话目录按项目隔离：cwd 的 sha1 前 10 位 + 目录名 */
function sessionDirFor(cwd: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(path.resolve(cwd))
    .digest("hex")
    .slice(0, 10);
  const name = path.basename(cwd) || "project";
  return path.join(sessionsRoot(), `${name}-${hash}`);
}

export interface SessionInfo {
  file: string;
  /** 会话开始时间（取自元信息行；解析失败为 null） */
  startedAt: string | null;
  bytes: number;
}

/** 开启一个新会话文件，返回其路径（首个调用方负责传入 AgentOptions） */
export function startSession(cwd: string, version: string): string {
  const dir = sessionDirFor(cwd);
  ensureDir(dir);
  const file = path.join(
    dir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );
  try {
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        type: "meta",
        cwd: path.resolve(cwd),
        version,
        startedAt: new Date().toISOString(),
      })}\n`,
    );
  } catch {
    // 会话记录失败不影响主流程
  }
  return file;
}

/** 把消息**增量追加**到会话文件（图片降级为占位文本，见模块注释） */
export function appendSessionMessages(
  file: string,
  messages: ChatMessage[],
): void {
  if (messages.length === 0) return;
  try {
    const lines = messages.map((message) => {
      const saved =
        message.images && message.images.length > 0
          ? {
              ...message,
              images: undefined,
              content: `${message.content ?? ""}\n\n[图片已省略：会话文件不保存图片]`,
            }
          : message;
      return `${JSON.stringify({ type: "message", message: saved })}\n`;
    });
    fs.appendFileSync(file, lines.join(""));
  } catch {
    // 会话记录失败不影响主流程
  }
}

/** 列出当前项目的全部会话（按文件名倒序 = 新的在前） */
export function listSessions(cwd: string): SessionInfo[] {
  const dir = sessionDirFor(cwd);
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      let startedAt: string | null = null;
      const head = fs.readFileSync(file, "utf8").split("\n")[0] ?? "";
      try {
        startedAt = (JSON.parse(head) as { startedAt?: string }).startedAt ?? null;
      } catch {
        // 元信息行损坏不影响列出
      }
      sessions.push({ file, startedAt, bytes: fs.statSync(file).size });
    } catch {
      // 单个文件读不了就跳过
    }
  }
  return sessions;
}

/** 读回一个会话文件里的全部消息（供 /resume 整体替换历史） */
export function loadSessionMessages(file: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          message?: ChatMessage;
        };
        if (parsed.type === "message" && parsed.message?.role) {
          messages.push(parsed.message);
        }
      } catch {
        // 单行损坏跳过
      }
    }
  } catch {
    // 读不了就返回已解析的部分
  }
  return messages;
}

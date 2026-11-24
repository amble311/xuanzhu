import * as fs from "fs";
import * as path from "path";

/**
 * 「拉取式」摘要箱。
 *
 * 背景：iLink 的主动推送额度极小，巡检结论又是**可延迟内容** —— 硬推的结果是
 * 把额度耗在用户半夜不一定看的长文上，真正的成交 / 风控消息反而发不出去。
 *
 * 所以按重要性分级（见 `outbox.ts` 的 `OutboundKind`）：
 * - `trade` / `reply`：必须推，队列里重试；
 * - `inspect`：会话窗口开着就推，窗口关了就**落到这里**，等用户下次说话时
 *   在回复尾部提示「另有 N 轮巡检摘要，/digest 查看」，或直接 `/digest` 拉取。
 *
 * 落盘是 JSONL（`run/digest.jsonl`），只保留最近 `MAX_ENTRIES` 条：
 * 摘要箱是「最近没推出去的内容」，不是归档，完整内容仍在巡检日志里。
 */

export interface DigestEntry {
  at: string;
  /** 来自哪个转发器（btc / a-stream / a-actions） */
  source: string;
  text: string;
}

const FILE = "digest.jsonl";
const MAX_ENTRIES = 50;
/** 单条摘要最多存这么多字（完整内容在巡检日志） */
const MAX_CHARS = 4_000;

export function digestPath(gatewayHome: string): string {
  return path.join(gatewayHome, "run", FILE);
}

export function readDigest(gatewayHome: string): DigestEntry[] {
  try {
    const text = fs.readFileSync(digestPath(gatewayHome), "utf8");
    const entries: DigestEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as DigestEntry;
        if (parsed && typeof parsed.text === "string") entries.push(parsed);
      } catch {
        // 坏行跳过
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export function appendDigest(
  gatewayHome: string,
  entry: { source: string; text: string; at?: string },
): void {
  const body = entry.text.trim();
  if (!body) return;
  const file = digestPath(gatewayHome);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        at: entry.at ?? new Date().toISOString(),
        source: entry.source,
        text: body.slice(0, MAX_CHARS),
      })}\n`,
      "utf8",
    );
    compactDigest(gatewayHome);
  } catch {
    // 摘要箱写失败不该影响其他推送
  }
}

/** 超过上限就重写为最近 N 条（顺带清掉过期旧内容，避免无限增长） */
function compactDigest(gatewayHome: string): void {
  const entries = readDigest(gatewayHome);
  if (entries.length <= MAX_ENTRIES) return;
  const kept = entries.slice(-MAX_ENTRIES);
  const file = digestPath(gatewayHome);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
  fs.renameSync(tmp, file);
}

/** 用户看过 `/digest` 后清空：否则回复尾部的提示会一直挂着 */
export function clearDigest(gatewayHome: string): void {
  try {
    fs.rmSync(digestPath(gatewayHome), { force: true });
  } catch {
    // 删不掉只影响提示是否消失
  }
}

/** 未读摘要条数（doctor / 回复尾部提示用） */
export function digestCount(gatewayHome: string): number {
  return readDigest(gatewayHome).length;
}

/**
 * 给用户看的一行提示：只在确实有积压摘要时出现。
 *
 * 放在回复末尾而不是单独发一条：不占推送额度，也不会打断对话。
 */
export function digestHint(gatewayHome: string): string {
  const count = digestCount(gatewayHome);
  return count > 0 ? `（另有 ${count} 轮巡检摘要未推送，发送 /digest 查看）` : "";
}

/** 渲染最近 N 条摘要（`/digest` 命令） */
export function formatDigest(gatewayHome: string, limit = 3): string {
  const entries = readDigest(gatewayHome);
  if (entries.length === 0) return "没有未推送的巡检摘要。";
  const picked = entries.slice(-limit);
  const lines = [`未推送的巡检摘要 ${entries.length} 条（显示最近 ${picked.length} 条）：`];
  for (const entry of picked) {
    const time = entry.at.slice(11, 16);
    lines.push("", `— ${entry.source} ${time} —`, entry.text);
  }
  if (entries.length > picked.length) {
    lines.push("", `（还有 ${entries.length - picked.length} 条更早的，完整内容见巡检日志）`);
  }
  return lines.join("\n");
}

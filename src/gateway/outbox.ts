import * as fs from "fs";
import * as path from "path";

/**
 * 微信出站消息队列（磁盘持久化，重启不丢）。
 *
 * 为什么需要它：iLink 对连续/并发发送不稳定，直接 `await send()` 失败一次
 * 这条消息就永久丢了。这里改成「先落盘 → 串行发送 → 成功删除」：
 * - 发送失败按 5s / 15s / 60s … 退避重试，最长 5 分钟一次；
 * - gateway 重启后继续发未完成的消息；
 * - 队列上限 200 条，超出丢最老的（并写日志），避免无限堆积。
 *
 * 语义是 at-least-once：极端情况下（发送成功但删除前崩溃）可能重复一次，
 * 但不会丢。
 */

export interface OutboxItem {
  id: string;
  text: string;
  createdAt: string;
  attempts: number;
  /** 下一次可尝试时间（ISO） */
  nextAt: string;
}

const QUEUE_FILE = "outbox.json";
const MAX_ITEMS = 200;

function queuePath(gatewayHome: string): string {
  return path.join(gatewayHome, "run", QUEUE_FILE);
}

export function readOutbox(gatewayHome: string): OutboxItem[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(queuePath(gatewayHome), "utf8")) as OutboxItem[];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.text === "string") : [];
  } catch {
    return [];
  }
}

function writeOutbox(gatewayHome: string, items: OutboxItem[]): void {
  const file = queuePath(gatewayHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function backoffMs(attempts: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.min(attempts, 6));
}

export interface Outbox {
  enqueue: (text: string) => void;
  readonly size: number;
  stop: () => void;
}

export function startOutbox(options: {
  gatewayHome: string;
  send: (text: string) => Promise<boolean>;
  log?: (message: string) => void;
  intervalMs?: number;
}): Outbox {
  let items = readOutbox(options.gatewayHome);
  let stopped = false;
  let sending = false;

  const enqueue = (text: string): void => {
    const body = text.trim();
    if (!body) return;
    items.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      text: body,
      createdAt: new Date().toISOString(),
      attempts: 0,
      nextAt: new Date().toISOString(),
    });
    if (items.length > MAX_ITEMS) {
      const dropped = items.length - MAX_ITEMS;
      items = items.slice(-MAX_ITEMS);
      options.log?.(`出站队列超限，丢弃最老 ${dropped} 条`);
    }
    writeOutbox(options.gatewayHome, items);
  };

  const tick = async (): Promise<void> => {
    if (stopped || sending || items.length === 0) return;
    const now = Date.now();
    const index = items.findIndex((item) => Date.parse(item.nextAt) <= now);
    if (index < 0) return;

    sending = true;
    const item = items[index];
    try {
      const ok = await options.send(item.text);
      if (ok) {
        items = items.filter((entry) => entry.id !== item.id);
        writeOutbox(options.gatewayHome, items);
        return;
      }
      item.attempts += 1;
      item.nextAt = new Date(Date.now() + backoffMs(item.attempts)).toISOString();
      if (item.attempts === 1 || item.attempts % 5 === 0) {
        options.log?.(`出站消息发送失败，稍后重试（第 ${item.attempts} 次）`);
      }
      writeOutbox(options.gatewayHome, items);
    } catch (err) {
      item.attempts += 1;
      item.nextAt = new Date(Date.now() + backoffMs(item.attempts)).toISOString();
      writeOutbox(options.gatewayHome, items);
      options.log?.(
        `出站消息异常：${err instanceof Error ? err.message : String(err)}（稍后重试）`,
      );
    } finally {
      sending = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? 3_000);
  timer.unref?.();
  void tick();

  return {
    enqueue,
    get size() {
      return items.length;
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

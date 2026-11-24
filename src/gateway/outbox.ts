import * as fs from "fs";
import * as path from "path";
import { chunkText, type ChannelCapabilities } from "./channels";

/**
 * **单出站漏斗**（唯一出口）。
 *
 * 以前有两条出站路径：回复在 `channel.handle()` 里直接 `sendChunks`，巡检推送走
 * outbox —— 两者各有各的失败处理，互相插队，也没有共享「这个对端现在能不能发」的视图。
 * 2026-11-24 的故障正是这么来的：推送一直撞 `ret=-2`，而回复因为窗口刚好开着还能发，
 * 日志里一会儿「已送达」一会儿「未送达」，无法判断通道到底通不通。
 *
 * 现在所有出站（回复 / 成交 / 巡检 / 通知）都进这一个队列：
 *
 * ```
 * enqueue(msg) → 排序（优先级 + 时间）→ 闸门（会话窗口 / 探测退避）→ 分块发送 → 送达/延后/转摘要
 * ```
 *
 * 三条不变量：
 * 1. **按对端记录状态**：`lastInboundAt`（窗口）、`rejectStreak` / `nextProbeAt`（配额）；
 *    能否发送由状态**算出来**，而不是撞出来。
 * 2. **可暂停、可恢复、可放弃**：`inspect` 在窗口关闭时不是「排队硬撞」，而是转进
 *    摘要箱（`digest.ts`），下次对话或 `/digest` 拉取；`trade` 必达但也要遵守探测节奏。
 * 3. **断点续发**：正文被切块时记 `sent`，重试从下一块继续，不会把已送达的气泡重发。
 */

export type OutboundKind = "reply" | "trade" | "inspect" | "notice";

/** 优先级：数字越小越先发 */
const PRIORITY: Record<OutboundKind, number> = {
  reply: 0,
  trade: 1,
  notice: 2,
  inspect: 3,
};

/** 只有这些类别可以「降级成摘要」；成交与回复不允许丢 */
const DIGESTIBLE: ReadonlySet<OutboundKind> = new Set(["inspect", "notice"]);

export interface OutboundMessage {
  id: string;
  text: string;
  kind: OutboundKind;
  /** 目标对端；不传表示「最近联系的对端」 */
  peer?: string;
  createdAt: string;
  /** 超过这个时间还没送达就放弃（可延迟内容用） */
  deadline?: string;
  /** 幂等键：同一轮同一段重复入队只保留一条 */
  dedupeKey?: string;
  attempts: number;
  nextAt: string;
  /** 已送达的分块数（正文超长被切块时断点续发） */
  sent: number;
}

/** 每个对端的投递状态：窗口 + 配额探测 */
export interface PeerState {
  lastInboundAt?: string;
  lastDeliveredAt?: string;
  /** 连续被服务端拒收（`ret=-2`）的次数 */
  rejectStreak: number;
  /** 下一次允许探测的时间（退避期间所有消息都等它） */
  nextProbeAt?: string;
  lastError?: string;
}

export interface OutboxStats {
  delivered: number;
  dropped: number;
  lastDeliveredAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

interface OutboxFile {
  version: 2;
  items: OutboundMessage[];
  peers: Record<string, PeerState>;
  stats: OutboxStats;
}

export type OutboxSendResult =
  | boolean
  | { ok: boolean; error?: string; ret?: number; errcode?: number };

export type OutboxSend = (peer: string | undefined, text: string) => Promise<OutboxSendResult>;

const QUEUE_FILE = "outbox.json";
const MAX_ITEMS = 200;
/** 网络类失败：5s 起步，最长 5 分钟一次 */
const TRANSIENT_MAX_MS = 5 * 60_000;
/** 服务端拒收：10 分钟起步，最长 30 分钟一次（探测节奏） */
const THROTTLE_MIN_MS = 10 * 60_000;
const THROTTLE_MAX_MS = 30 * 60_000;
/**
 * 拒收多少次算「通道失效」。
 *
 * 实测 `ret=-2` 不是偶发抖动（2026-11-24 连续拒收 3 小时、1130 次），所以**一次**
 * 就应当如实上报状态（期间仍按 10/20/30 分钟节奏探测），否则用户看到的仍是
 * 「一切正常、消息在队列里」。
 */
export const BLOCK_AFTER_REFUSALS = 1;
/** 同类合并窗口与上限 */
const MERGE_WINDOW_MS = 10 * 60_000;
/** 等回复送达的最长时间（超时后消息仍在队列里重试） */
const REPLY_WAIT_MS = 60_000;

function queuePath(gatewayHome: string): string {
  return path.join(gatewayHome, "run", QUEUE_FILE);
}

function emptyStats(): OutboxStats {
  return { delivered: 0, dropped: 0 };
}

/**
 * 读队列（兼容 v1：旧版直接存一个数组）。
 *
 * 迁移是**只读兼容 + 下次写入自动升级**，不需要单独迁移脚本。
 */
export function readOutboxState(gatewayHome: string): OutboxFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(queuePath(gatewayHome), "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      return {
        version: 2,
        items: parsed.filter((item): item is OutboundMessage => Boolean(item?.text)),
        peers: {},
        stats: emptyStats(),
      };
    }
    const file = parsed as Partial<OutboxFile>;
    return {
      version: 2,
      items: Array.isArray(file.items)
        ? file.items.filter((item) => item && typeof item.text === "string")
        : [],
      peers: file.peers && typeof file.peers === "object" ? file.peers : {},
      stats: { ...emptyStats(), ...(file.stats ?? {}) },
    };
  } catch {
    return { version: 2, items: [], peers: {}, stats: emptyStats() };
  }
}

/** 只读队列条目（doctor / 测试用） */
export function readOutbox(gatewayHome: string): OutboundMessage[] {
  return readOutboxState(gatewayHome).items;
}

function writeOutbox(gatewayHome: string, state: OutboxFile): void {
  const file = queuePath(gatewayHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function backoffMs(attempts: number, refused: boolean): number {
  if (refused) {
    return Math.min(THROTTLE_MAX_MS, THROTTLE_MIN_MS * 2 ** Math.min(attempts - 1, 2));
  }
  return Math.min(TRANSIENT_MAX_MS, 5_000 * 2 ** Math.min(attempts, 6));
}

/** 这次失败是不是「服务端拒收」（而不是网络没通） */
export function isThrottleFailure(result: {
  error?: string;
  ret?: number;
  errcode?: number;
}): boolean {
  if (result.ret === -2 || result.errcode === -2) return true;
  const error = result.error ?? "";
  return /ret=-2\b|prepare failed|限频|会话.*(失效|过期)/i.test(error);
}

/** `[A 股巡检结论 · 2/2]` → `[A 股巡检结论]`；无标题返回空串 */
function bubbleTitle(text: string): string {
  const first = (text.split("\n")[0] ?? "").trim();
  if (!/^\[[^\]]+\]$/.test(first)) return "";
  return first.replace(/\s*·\s*\d+\/\d+\]$/, "]");
}

function bubbleBody(text: string): string {
  const lines = text.split("\n");
  return (bubbleTitle(text) ? lines.slice(1) : lines).join("\n").trim();
}

/** 会话窗口是否开着（`pushWindowMs = null` 的通道永远算开） */
export function windowOpen(
  peer: string | undefined,
  peers: Record<string, PeerState>,
  capabilities: ChannelCapabilities,
  now = Date.now(),
): boolean {
  if (capabilities.pushWindowMs === null) return true;
  const at = Date.parse(peers[peer ?? ""]?.lastInboundAt ?? "");
  return Number.isFinite(at) && now - at <= capabilities.pushWindowMs;
}

/** 这个对端当前是否被配额退避挡住 */
export function probeBlockedAt(
  peer: string | undefined,
  peers: Record<string, PeerState>,
  now = Date.now(),
): number | null {
  const at = Date.parse(peers[peer ?? ""]?.nextProbeAt ?? "");
  return Number.isFinite(at) && at > now ? at : null;
}

export interface EnqueueInput {
  text: string;
  kind: OutboundKind;
  peer?: string;
  deadline?: string;
  dedupeKey?: string;
}

export interface Outbox {
  enqueue: (input: EnqueueInput) => string;
  /** 回复：入队并等送达（或首次失败）后返回是否已送达 */
  enqueueReply: (peer: string | undefined, text: string) => Promise<boolean>;
  /** 入站消息到达：刷新窗口、清掉退避、立刻放行积压 */
  markInbound: (peer: string) => void;
  stats: () => OutboxStats & {
    size: number;
    oldestAt?: string;
    blockedPeers: string[];
  };
  readonly size: number;
  readonly blocked: boolean;
  stop: () => void;
}

export function startOutbox(options: {
  gatewayHome: string;
  capabilities: ChannelCapabilities;
  send: OutboxSend;
  /**
   * 没有显式指定 `peer` 的消息（巡检推送）落给谁。
   *
   * 必须在**入队时**解析成具体对端并写进消息：会话窗口与拒收退避都是按对端记的，
   * 若一直留空，`peers[""]` 会把「用户刚说过话」的窗口判定丢掉 —— 结果就是
   * 巡检结论全被降级成摘要、一条也发不出去。
   */
  defaultPeer?: () => string | undefined;
  log?: (message: string) => void;
  /** 被降级成摘要的内容（`inspect` / `notice` 窗口关闭时） */
  onDigest?: (message: { kind: OutboundKind; text: string; reason: string }) => void;
  /** 通道被连续拒收 / 恢复时上报（gateway 写进状态文件） */
  onBlocked?: (reason: string | null) => void;
  intervalMs?: number;
  now?: () => number;
}): Outbox {
  const caps = options.capabilities;
  const now = options.now ?? Date.now;
  const state = readOutboxState(options.gatewayHome);
  let items = state.items;
  let peers = state.peers;
  let counters = state.stats;
  let stopped = false;
  let sending = false;
  let blockedReported = false;
  const waiters = new Map<string, (ok: boolean) => void>();

  const persist = (): void => {
    writeOutbox(options.gatewayHome, { version: 2, items, peers, stats: counters });
  };

  const settle = (id: string, ok: boolean): void => {
    const waiter = waiters.get(id);
    if (!waiter) return;
    waiters.delete(id);
    waiter(ok);
  };

  const blockedNow = (): boolean =>
    Object.values(peers).some((peer) => peer.rejectStreak >= BLOCK_AFTER_REFUSALS);

  const reportBlocked = (): void => {
    const blocked = blockedNow();
    if (blocked === blockedReported) return;
    blockedReported = blocked;
    options.onBlocked?.(
      blocked
        ? `微信推送通道被拒收（iLink ret=-2）：正在按 10/20/30 分钟节奏探测，` +
            `期间巡检结论转入摘要（/digest 查看）。给 bot 发一条消息可立即恢复。`
        : null,
    );
  };

  const enqueue = (input: EnqueueInput): string => {
    const text = input.text.trim();
    if (!text) return "";
    const ts = now();
    const message: OutboundMessage = {
      id: `${ts}-${Math.random().toString(16).slice(2, 8)}`,
      text,
      kind: input.kind,
      peer: input.peer ?? options.defaultPeer?.(),
      createdAt: new Date(ts).toISOString(),
      deadline: input.deadline,
      dedupeKey: input.dedupeKey,
      attempts: 0,
      nextAt: new Date(ts).toISOString(),
      sent: 0,
    };

    if (input.dedupeKey) {
      const existing = items.find((item) => item.dedupeKey === input.dedupeKey);
      if (existing) return existing.id;
    }

    // 同类合并：同标题、同类别、同对端，且上一条还没开始重试
    const last = items[items.length - 1];
    if (
      last &&
      last.kind === message.kind &&
      last.peer === message.peer &&
      last.attempts === 0 &&
      last.sent === 0 &&
      ts - Date.parse(last.createdAt) <= MERGE_WINDOW_MS
    ) {
      const title = bubbleTitle(text);
      if (title && title === bubbleTitle(last.text)) {
        const merged = `${title}\n${bubbleBody(last.text)}\n${bubbleBody(text)}`.trim();
        if (merged.length <= caps.maxLen) {
          last.text = merged;
          persist();
          options.log?.(`出站队列合并同类消息（${merged.length} 字）`);
          return last.id;
        }
      }
    }

    items.push(message);
    if (items.length > MAX_ITEMS) {
      const dropped = items.length - MAX_ITEMS;
      items = items.slice(-MAX_ITEMS);
      counters.dropped += dropped;
      options.log?.(`出站队列超限，丢弃最老 ${dropped} 条`);
    }
    persist();
    return message.id;
  };

  /** 把不可推的 `inspect` / `notice` 转进摘要箱（不占推送额度） */
  const digestItem = (message: OutboundMessage, reason: string): void => {
    options.onDigest?.({ kind: message.kind, text: message.text, reason });
    counters.dropped += 1;
    items = items.filter((item) => item.id !== message.id);
    settle(message.id, false);
    options.log?.(`巡检内容转入摘要（${reason}，${message.text.length} 字）`);
    persist();
  };

  const markPeerError = (
    peer: string | undefined,
    refused: boolean,
    error: string,
    attempts: number,
  ): void => {
    const key = peer ?? "";
    const current = peers[key] ?? { rejectStreak: 0 };
    if (refused) {
      current.rejectStreak += 1;
      current.nextProbeAt = new Date(
        now() + backoffMs(current.rejectStreak, true),
      ).toISOString();
    } else {
      // 网络抖动不算「拒收」：不动窗口判定，但同样退避
      current.nextProbeAt = new Date(now() + backoffMs(attempts, false)).toISOString();
    }
    current.lastError = error;
    peers[key] = current;
    counters.lastError = error;
    counters.lastErrorAt = new Date(now()).toISOString();
  };

  const tick = async (): Promise<void> => {
    if (stopped || sending) return;
    sending = true;
    try {
      const at = now();
      // 过期的可延迟内容直接放弃（已经进了摘要或用户不再需要）
      const expired = items.filter(
        (item) => item.deadline && Date.parse(item.deadline) <= at,
      );
      for (const item of expired) {
        items = items.filter((entry) => entry.id !== item.id);
        counters.dropped += 1;
        settle(item.id, false);
        options.log?.(`出站消息过期丢弃（${item.kind}，${item.text.length} 字）`);
      }
      if (expired.length > 0) persist();

      const order = [...items].sort((a, b) => {
        const byPriority = PRIORITY[a.kind] - PRIORITY[b.kind];
        if (byPriority !== 0) return byPriority;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      });

      for (const message of order) {
        if (Date.parse(message.nextAt) > at) continue;
        const probeAt = probeBlockedAt(message.peer, peers, at);
        if (probeAt !== null) continue;

        if (DIGESTIBLE.has(message.kind) && !windowOpen(message.peer, peers, caps, at)) {
          digestItem(message, "会话窗口已关闭，改由 /digest 拉取");
          continue;
        }

        const chunks = chunkText(message.text, caps.maxLen);
        let failed = false;
        for (let index = message.sent; index < chunks.length; index += 1) {
          let raw: OutboxSendResult;
          try {
            raw = await options.send(message.peer, chunks[index]);
          } catch (err) {
            raw = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          const ok = typeof raw === "boolean" ? raw : raw.ok;
          if (!ok) {
            const detail: { error?: string; ret?: number; errcode?: number } =
              typeof raw === "boolean" ? {} : raw;
            const refused = isThrottleFailure(detail);
            const error = detail.error ?? "发送失败";
            message.attempts += 1;
            message.nextAt = new Date(
              now() + backoffMs(message.attempts, refused),
            ).toISOString();
            markPeerError(message.peer, refused, error, message.attempts);
            options.log?.(
              `出站消息未送达（第 ${message.attempts} 次尝试，${message.kind}，` +
                `${message.text.length} 字${refused ? "，服务端拒收 ret=-2" : ""}）：${error}`,
            );
            // 回复：第一次失败就结算，避免把长轮询的 handle() 拖住（消息仍在队列重试）
            settle(message.id, false);
            persist();
            reportBlocked();
            failed = true;
            break;
          }
          message.sent = index + 1;
          persist();
          if (index + 1 < chunks.length) {
            await sleep(caps.chunkDelayMs);
          }
        }
        if (failed) return;

        if (message.sent >= chunks.length) {
          items = items.filter((item) => item.id !== message.id);
          counters.delivered += 1;
          counters.lastDeliveredAt = new Date(now()).toISOString();
          const key = message.peer ?? "";
          const peer = peers[key];
          if (peer) {
            peer.rejectStreak = 0;
            peer.nextProbeAt = undefined;
            peer.lastDeliveredAt = counters.lastDeliveredAt;
          }
          persist();
          options.log?.(
            `出站消息已送达（${message.kind}，${message.text.length} 字` +
              `${message.attempts > 0 ? `，重试 ${message.attempts} 次` : ""}）`,
          );
          settle(message.id, true);
          reportBlocked();
          // 一轮只发一条，避免瞬间把窗口额度用光
          return;
        }
      }
    } finally {
      sending = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? 3_000);
  timer.unref?.();
  void tick();

  return {
    enqueue,
    enqueueReply: (peer, text) =>
      new Promise<boolean>((resolve) => {
        const id = enqueue({ text, kind: "reply", peer });
        if (!id) {
          resolve(false);
          return;
        }
        waiters.set(id, resolve);
        const guard = setTimeout(() => {
          if (waiters.delete(id)) resolve(false);
        }, REPLY_WAIT_MS);
        guard.unref?.();
      }),
    markInbound: (peer) => {
      const at = new Date(now()).toISOString();
      const current = peers[peer] ?? { rejectStreak: 0 };
      current.lastInboundAt = at;
      current.rejectStreak = 0;
      current.nextProbeAt = undefined;
      peers[peer] = current;
      // 窗口刚打开：把该对端的积压拨到「现在」，按优先级逐条补发
      items = items.map((item) =>
        (item.peer ?? "") === peer ? { ...item, nextAt: at } : item,
      );
      persist();
      reportBlocked();
      void tick();
    },
    stats: () => {
      const oldest = items
        .map((item) => Date.parse(item.createdAt))
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b)[0];
      return {
        ...counters,
        size: items.length,
        oldestAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : undefined,
        blockedPeers: Object.entries(peers)
          .filter(([, peer]) => peer.rejectStreak >= BLOCK_AFTER_REFUSALS)
          .map(([key]) => key),
      };
    },
    get size() {
      return items.length;
    },
    get blocked() {
      return blockedNow();
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

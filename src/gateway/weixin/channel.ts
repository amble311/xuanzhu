import * as fs from "fs";
import * as path from "path";
import { chunkText, WEIXIN_CAPABILITIES } from "../channels";
import {
  getUpdates,
  sendText,
  sendTyping,
  type WeixinMessage,
} from "./client";
import {
  loadSyncBuf,
  saveSyncBuf,
  loadContextTokens,
  saveContextTokens,
  type WeixinAccount,
} from "./paths";

/** 主动推送 / 回复的结果：只给 boolean 无法区分「没对象」与「服务端拒收」 */
export interface SendOutcome {
  ok: boolean;
  error?: string;
}

/** 长轮询的健康快照（写 `run/channel.json`，`xzh gateway doctor` 读它） */
export interface ChannelHealth {
  channel: "weixin";
  startedAt: string;
  /** 最近一次长轮询返回的时间 */
  lastPollAt?: string;
  /** 最近一次长轮询**成功**的时间（判断「失联」看这个） */
  lastOkAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  polls: number;
  errors: number;
  /** 收发的消息条数（累计，进程内） */
  received: number;
}

export interface WeixinChannelOptions {
  home: string;
  account: WeixinAccount;
  /** 收到一条文本 → 返回要发回去的回复（实际发送由 `deliver` 走统一出站队列） */
  onMessage: (text: string, peer: string) => Promise<string>;
  log: (message: string) => void;
  /** 允许的用户 ID；为空表示不限制（自己扫码绑定的 bot，默认只服务自己） */
  allowedUsers?: string[];
  /**
   * 回复的出口。**不在这里直接发**：统一进 outbox，参与优先级排序、
   * 会话窗口判定与配额退避（见 `src/gateway/outbox.ts`）。
   */
  deliver: (peer: string, text: string) => Promise<boolean>;
  /**
   * 新消息到达（去重之后）时回调：刷新该对端的会话窗口。
   *
   * 实测：iLink 的主动推送只有在「用户刚和 bot 说过话」的窗口里才发得出去，
   * 所以入站是**恢复推送**的唯一可靠时机。
   */
  onInbound?: (peer: string) => void;
}

export interface WeixinChannel {
  stop: () => void;
  readonly running: boolean;
  /** 最近一次对话的对端（没有入站过时是登录账号对应的自己） */
  readonly lastPeer: string | undefined;
  /**
   * 发一条文本给指定对端（单块；切块与重试由 outbox 负责）。
   *
   * `peer` 为空时退化为「最近联系的对端」。
   */
  sendTo: (peer: string | undefined, text: string) => Promise<SendOutcome>;
  health: () => ChannelHealth;
}

/**
 * 去重窗口（**有 msgId 时**）：iLink 在网络抖动时会重复投递同一条消息。
 * 同一个 msgId 5 分钟内只处理一次，安全。
 */
export const DEDUP_TTL_MS = 5 * 60_000;
/**
 * 去重窗口（**没有 msgId 时**）：只能退化成「对端 + 文本」，窗口必须很短。
 *
 * 用 5 分钟会误杀正常操作：先发一次 `/info`，切到另一个模式后再发 `/info`，
 * 文本一样就被当成重复消息**静默丢弃**（日志里一行都没有）—— 用户看到的就是
 * 「切换后 /info 没反应」。真正的重复投递发生在几百毫秒内，3 秒足够挡住。
 */
export const TEXT_DEDUP_MS = 3_000;
const RETRY_DELAY_MS = 5_000;
/** 健康快照的落盘节流：长轮询 35 秒一轮，不必每条都写盘 */
const HEALTH_WRITE_MS = 30_000;

/**
 * 消息去重器：key 已处理的返回 false，未处理的记下来并返回 true。
 *
 * 抽成独立函数是为了能离线测试「同一文本 5 秒后必须能再次处理」这条约束。
 */
export function createDeduper(now: () => number = Date.now): (
  key: string,
  ttlMs: number,
) => boolean {
  // 每条记录带自己的 ttl：msgId 键 5 分钟、文本键 3 秒，不能共用一个窗口
  const seen = new Map<string, { at: number; ttl: number }>();
  return (key, ttlMs) => {
    const at = now();
    for (const [id, item] of seen) {
      if (at - item.at > item.ttl) seen.delete(id);
    }
    const hit = seen.get(key);
    if (hit && at - hit.at <= ttlMs) return false;
    seen.set(key, { at, ttl: ttlMs });
    return true;
  };
}

export function healthFile(home: string): string {
  return path.join(home, "run", "channel.json");
}

/**
 * 按微信上限切块（保留给测试与工具复用）。
 *
 * 真正的切块发生在 outbox（它要跨通道复用 `chunkText`）；这里只是同一套能力的
 * 便捷入口，避免调用方各自写一份 1500/2000 的魔数。
 */
export function splitChunks(text: string): string[] {
  return chunkText(text, WEIXIN_CAPABILITIES.maxLen);
}

/**
 * 微信频道：长轮询 → 交给 gateway 的 agent → 回复交给出站队列。
 *
 * 三条稳定性要求：
 * 1. `get_updates_buf` 必须持久化（断点续传），否则重启会重放老消息；
 * 2. 回复必须带该对端最近的 `context_token`，且 token 要落盘（重启后还能续聊）；
 * 3. 消息去重（5 分钟窗口）：iLink 在网络抖动时会重复投递。
 *
 * 2026-11-24 起职责收窄：**只做协议**。不再自己切块/重试/直接发送 ——
 * 那些属于出站队列（`outbox.ts`），否则回复与巡检推送会各自维护一套失败策略。
 */
export function startWeixinChannel(options: WeixinChannelOptions): WeixinChannel {
  const { account, home, log } = options;
  const allowed = (options.allowedUsers ?? []).filter(Boolean);
  let stopped = false;
  let syncBuf = loadSyncBuf(home);
  const tokens = loadContextTokens(home);
  const remember = createDeduper();
  /** 最近一次对话的对端：主动推送没指定 peer 时用它 */
  let lastPeer: string | undefined = account.userId;

  const health: ChannelHealth = {
    channel: "weixin",
    startedAt: new Date().toISOString(),
    polls: 0,
    errors: 0,
    received: 0,
    lastOkAt: new Date().toISOString(),
  };
  let lastHealthWrite = 0;

  const writeHealth = (force = false): void => {
    const at = Date.now();
    if (!force && at - lastHealthWrite < HEALTH_WRITE_MS) return;
    lastHealthWrite = at;
    const file = healthFile(home);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(health, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, file);
    } catch {
      // 健康快照写失败不影响收发
    }
  };

  /** 单块发送（带 2 次短重试）；切块与长退避由 outbox 负责 */
  const sendOne = async (peer: string, text: string): Promise<SendOutcome> => {
    let lastError = "未知错误";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await sendText({
          baseUrl: account.baseUrl,
          token: account.token,
          to: peer,
          text,
          contextToken: tokens[peer],
        });
        return { ok: true };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === 0) await sleep(600);
      }
    }
    return { ok: false, error: lastError };
  };

  const sendTo = async (peer: string | undefined, text: string): Promise<SendOutcome> => {
    const target = peer || lastPeer;
    if (!target) return { ok: false, error: "没有可发送的对端（微信还没有过会话）" };
    const outcome = await sendOne(target, text);
    if (!outcome.ok) log(`微信：推送失败 ${outcome.error ?? "未知"}`);
    return outcome;
  };

  const handle = async (message: WeixinMessage): Promise<void> => {
    const peer = message.fromUserId;
    lastPeer = peer;
    if (allowed.length > 0 && !allowed.includes(peer)) {
      log(`微信：忽略非白名单用户 ${peer}`);
      return;
    }
    // bot 自己发的消息（message_type=2）会被原样投递回来，必须过滤，否则会自我对话
    if (message.msgType === 2) return;

    if (message.contextToken) {
      tokens[peer] = message.contextToken;
      saveContextTokens(tokens, home);
    }

    // 真正由用户发来的消息（已过白名单、已排除 bot 自己的回显）→ 会话窗口被刷新
    try {
      options.onInbound?.(peer);
    } catch {
      // 刷新窗口失败不该影响这条消息的处理
    }

    // 每条都记一行：出问题（比如「切模式后 /info 没回复」）时至少能确认消息到没到、
    // 回了多长、花了多久 —— 以前这里什么都不记，只能靠猜。
    log(
      `微信收到 ${peer.slice(-6)}：${message.text.replace(/\s+/g, " ").slice(0, 60)}` +
        `（${message.text.length} 字）`,
    );
    health.received += 1;
    const startedAt = Date.now();

    const typing = await sendTyping({
      baseUrl: account.baseUrl,
      token: account.token,
      to: peer,
      contextToken: tokens[peer],
      status: 1,
    });
    if (!typing.ok) {
      log(`微信：打字状态不可用（${typing.error ?? "未知"}），长任务改用占位提示`);
    }

    /**
     * 微信的「正在输入」只维持几秒：Agent 跑几分钟时手机端早就看不着了，
     * 所以处理期间每 4 秒续一次；接口本身不可用时，超过 6 秒就补一条「收到，正在处理…」，
     * 保证用户至少知道消息没丢。
     */
    const typingTimer = typing.ok
      ? setInterval(() => {
          void sendTyping({
            baseUrl: account.baseUrl,
            token: account.token,
            to: peer,
            contextToken: tokens[peer],
            status: 1,
          });
        }, 4_000)
      : undefined;
    typingTimer?.unref?.();

    let finished = false;
    const ackTimer = typing.ok
      ? undefined
      : setTimeout(() => {
          if (!finished) {
            void sendTo(peer, "⏳ 收到，正在处理…").catch(() => undefined);
          }
        }, 6_000);
    ackTimer?.unref?.();

    let reply: string;
    try {
      reply = await options.onMessage(message.text, peer);
    } catch (err) {
      reply = `处理失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      finished = true;
      if (typingTimer) clearInterval(typingTimer);
      if (ackTimer) clearTimeout(ackTimer);
      await sendTyping({
        baseUrl: account.baseUrl,
        token: account.token,
        to: peer,
        contextToken: tokens[peer],
        status: 2,
      });
    }
    log(
      `微信回复 ${peer.slice(-6)}：${reply.length} 字，用时 ${Math.round((Date.now() - startedAt) / 1000)}s`,
    );
    try {
      // 统一出口：排队发送（回复优先级最高，通常立即发出）
      await options.deliver(peer, reply);
    } catch (err) {
      log(`微信：回复投递失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const result = await getUpdates({
          baseUrl: account.baseUrl,
          token: account.token,
          syncBuf,
        });
        health.polls += 1;
        health.lastPollAt = new Date().toISOString();
        health.lastOkAt = health.lastPollAt;
        writeHealth();

        // -14：会话过期（要重新扫码）；-2：限频，退避后继续
        if (result.ret === -14 || result.errcode === -14) {
          log("微信：会话已过期，请运行 `xzh gateway weixin login` 重新扫码");
          health.lastError = "会话已过期（-14）";
          health.lastErrorAt = new Date().toISOString();
          writeHealth(true);
          stopped = true;
          break;
        }

        if (result.syncBuf && result.syncBuf !== syncBuf) {
          syncBuf = result.syncBuf;
          saveSyncBuf(syncBuf, home);
        }

        for (const message of result.msgs) {
          if (stopped) break;
          // 有 msgId 就按 msgId 去重（5 分钟，抗重复投递）；没有 msgId 只能按文本，
          // 窗口压到 3 秒 —— 否则「先 /info，切模式，再 /info」会被当成重复消息吞掉。
          const key = message.msgId
            ? `id:${message.msgId}`
            : `text:${message.fromUserId}:${message.text}`;
          const ttl = message.msgId ? DEDUP_TTL_MS : TEXT_DEDUP_MS;
          if (!remember(key, ttl)) {
            log(
              `微信：忽略重复投递（${
                message.msgId ? `msgId ${message.msgId}` : `无 msgId，同文本 ${TEXT_DEDUP_MS / 1000}s 内`
              }）：${message.text.replace(/\s+/g, " ").slice(0, 40)}`,
            );
            continue;
          }
          await handle(message);
        }

        if (result.ret === -2 || result.errcode === -2) {
          log("微信：接口限频，退避 30 秒");
          health.lastError = "接口限频（-2）";
          health.lastErrorAt = new Date().toISOString();
          writeHealth(true);
          await sleep(30_000);
        }
      } catch (err) {
        if (stopped) break;
        health.errors += 1;
        health.lastError = err instanceof Error ? err.message : String(err);
        health.lastErrorAt = new Date().toISOString();
        writeHealth(true);
        log(`微信：长轮询失败（${health.lastError}），5 秒后重试`);
        await sleep(RETRY_DELAY_MS);
      }
    }
    log("微信频道已停止");
  };

  void loop();

  return {
    stop: () => {
      stopped = true;
    },
    sendTo,
    health: () => ({ ...health }),
    get running() {
      return !stopped;
    },
    get lastPeer() {
      return lastPeer;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

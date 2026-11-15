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

export interface WeixinChannelOptions {
  home: string;
  account: WeixinAccount;
  /** 收到一条文本 → 返回要发回去的回复 */
  onMessage: (text: string, peer: string) => Promise<string>;
  log: (message: string) => void;
  /** 允许的用户 ID；为空表示不限制（自己扫码绑定的 bot，默认只服务自己） */
  allowedUsers?: string[];
}

export interface WeixinChannel {
  stop: () => void;
  readonly running: boolean;
  /**
   * 主动把一条文本发给最近联系的对端（巡检 / 监控推送用）。
   *
   * 返回 false 表示当前没有可发的对象（微信未绑定 / 没有历史会话），
   * 调用方应保留未发送内容，下次再试。
   */
  sendToLastPeer: (text: string) => Promise<boolean>;
}

/** 单条消息的长度上限：微信气泡太长了体验很差，按行切成多块 */
const CHUNK = 1_500;
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

export function splitChunks(text: string): string[] {
  const body = text.trim();
  if (body.length <= CHUNK) return body ? [body] : [];
  const chunks: string[] = [];
  let current = "";
  for (const line of body.split("\n")) {
    if ((current + line).length > CHUNK && current) {
      chunks.push(current.trimEnd());
      current = "";
    }
    // 单行本身超长时硬切
    let rest = line;
    while (rest.length > CHUNK) {
      chunks.push(rest.slice(0, CHUNK));
      rest = rest.slice(CHUNK);
    }
    current += `${rest}\n`;
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks;
}

/**
 * 微信频道：长轮询 → 交给 gateway 的 agent → 把回复发回去。
 *
 * 三条稳定性要求：
 * 1. `get_updates_buf` 必须持久化（断点续传），否则重启会重放老消息；
 * 2. 回复必须带该对端最近的 `context_token`，且 token 要落盘（重启后还能续聊）；
 * 3. 消息去重（5 分钟窗口）：iLink 在网络抖动时会重复投递。
 */
export function startWeixinChannel(options: WeixinChannelOptions): WeixinChannel {
  const { account, home, log } = options;
  const allowed = (options.allowedUsers ?? []).filter(Boolean);
  let stopped = false;
  let syncBuf = loadSyncBuf(home);
  const tokens = loadContextTokens(home);
  const remember = createDeduper();
  /** 最近一次对话的对端：主动推送（巡检 / 监控）只发给 TA */
  let lastPeer: string | undefined;

  /**
   * 所有出站消息串行化：回复、巡检推送可能同时发生，iLink 对并发发送不稳定
   * （后一条偶发丢失）。这里用一条 Promise 链保证「一条发完再发下一条」。
   */
  let sendChain: Promise<void> = Promise.resolve();
  const enqueueSend = (task: () => Promise<void>): Promise<void> => {
    const run = sendChain.then(task, task);
    sendChain = run.catch(() => undefined);
    return run;
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const sendChunks = async (to: string, reply: string): Promise<void> => {
    const chunks = splitChunks(reply);
    for (let index = 0; index < chunks.length; index += 1) {
      // 多条气泡之间留间隔：连续 send 太快时 iLink 会丢后一条
      if (index > 0) await sleep(450);
      const chunk = chunks[index];
      await enqueueSend(async () => {
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await sendText({
              baseUrl: account.baseUrl,
              token: account.token,
              to,
              text: chunk,
              contextToken: tokens[to],
            });
            return;
          } catch (err) {
            lastError = err;
            await sleep(600 * (attempt + 1));
          }
        }
        log(
          `微信：分块发送失败（${index + 1}/${chunks.length}）：${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`,
        );
      });
    }
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

    // 每条都记一行：出问题（比如「切模式后 /info 没回复」）时至少能确认消息到没到、
    // 回了多长、花了多久 —— 以前这里什么都不记，只能靠猜。
    log(
      `微信收到 ${peer.slice(-6)}：${message.text.replace(/\s+/g, " ").slice(0, 60)}` +
        `（${message.text.length} 字）`,
    );
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
          if (!finished) void sendChunks(peer, "⏳ 收到，正在处理…");
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
    log(`微信回复 ${peer.slice(-6)}：${reply.length} 字，用时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
    await sendChunks(peer, reply);
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const result = await getUpdates({
          baseUrl: account.baseUrl,
          token: account.token,
          syncBuf,
        });

        // -14：会话过期（要重新扫码）；-2：限频，退避后继续
        if (result.ret === -14 || result.errcode === -14) {
          log("微信：会话已过期，请运行 `xzh gateway weixin login` 重新扫码");
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
          await new Promise((resolve) => setTimeout(resolve, 30_000));
        }
      } catch (err) {
        if (stopped) break;
        log(`微信：长轮询失败（${err instanceof Error ? err.message : String(err)}），5 秒后重试`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
    log("微信频道已停止");
  };

  void loop();

  const sendToLastPeer = async (text: string): Promise<boolean> => {
    // 重启后没有 lastPeer 时，若历史里只有一个对端（自己扫码绑定的），就用它
    const peer = lastPeer ?? (Object.keys(tokens).length === 1 ? Object.keys(tokens)[0] : undefined);
    if (!peer) return false;
    try {
      await sendChunks(peer, text);
      return true;
    } catch (err) {
      log(`微信：推送失败 ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  return {
    stop: () => {
      stopped = true;
    },
    sendToLastPeer,
    get running() {
      return !stopped;
    },
  };
}

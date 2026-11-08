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
const DEDUP_TTL_MS = 5 * 60_000;
const RETRY_DELAY_MS = 5_000;

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
  const seen = new Map<string, number>();
  /** 最近一次对话的对端：主动推送（巡检 / 监控）只发给 TA */
  let lastPeer: string | undefined;

  const remember = (key: string): boolean => {
    const now = Date.now();
    for (const [id, at] of seen) {
      if (now - at > DEDUP_TTL_MS) seen.delete(id);
    }
    if (seen.has(key)) return false;
    seen.set(key, now);
    return true;
  };

  const sendChunks = async (to: string, reply: string): Promise<void> => {
    for (const chunk of splitChunks(reply)) {
      await sendText({
        baseUrl: account.baseUrl,
        token: account.token,
        to,
        text: chunk,
        contextToken: tokens[to],
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

    await sendTyping({
      baseUrl: account.baseUrl,
      token: account.token,
      to: peer,
      contextToken: tokens[peer],
      status: 1,
    });

    let reply: string;
    try {
      reply = await options.onMessage(message.text, peer);
    } catch (err) {
      reply = `处理失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      await sendTyping({
        baseUrl: account.baseUrl,
        token: account.token,
        to: peer,
        contextToken: tokens[peer],
        status: 2,
      });
    }
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
          const key = message.msgId ?? `${message.fromUserId}:${message.text}`;
          if (!remember(key)) continue;
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

/**
 * 通道能力（capability）抽象。
 *
 * 为什么需要它：投递策略不该写死「微信 900 字」「微信分 5 条」。以前这些常量散在
 * `feed.ts`，换一个通道（Telegram / 邮件 / 本地 websocket）就得把策略复制一遍。
 * 这里只声明**能力**，由出站队列（`outbox.ts`）据此决定切块、节奏与「能不能主动推」。
 *
 * 目前只有微信一个实现。接新通道时新增一份 capabilities + 一个 `send(peer, text)`
 * 适配器即可，队列与重试逻辑完全复用。
 */

export interface ChannelCapabilities {
  /** 通道名（日志与 doctor 用） */
  name: string;
  /** 单条消息的字符上限：超过就切块，切块仍算「同一条消息」 */
  maxLen: number;
  /**
   * 主动推送的「会话窗口」：用户最后一条消息之后这么久内才允许主动推送。
   *
   * `null` = 不受限（邮件、webhook 之类）。微信实测：用户不发消息时
   * `sendmessage` 会被服务端以 `ret=-2` 拒收，只有刚聊过的那几分钟能推。
   */
  pushWindowMs: number | null;
  /** 连续切块之间的间隔（iLink 连发会丢后一条） */
  chunkDelayMs: number;
  /** 单条消息内部分块失败时最多重试几次（整体重试由队列负责） */
  chunkRetries: number;
}

/**
 * 微信（iLink Bot）的实际能力。
 *
 * - 2000 字：实测单条 2000 字左右稳定，再长没有收益（用户也不读）；
 * - 会话窗口 10 分钟：观测到的可用窗口是「几分钟」，取 10 分钟作为乐观上界，
 *   真正能不能发由 `ret=-2` 反馈修正（见 `PeerState.nextProbeAt`）。
 */
export const WEIXIN_CAPABILITIES: ChannelCapabilities = {
  name: "weixin",
  maxLen: 2_000,
  pushWindowMs: 10 * 60_000,
  chunkDelayMs: 400,
  chunkRetries: 2,
};

/** 按通道上限切块：优先在换行处断开，避免把一句话劈成两半 */
export function chunkText(text: string, limit: number): string[] {
  const body = text.trim();
  if (!body) return [];
  const size = Math.max(80, Math.floor(limit));
  if (body.length <= size) return [body];

  const chunks: string[] = [];
  let buffer = "";
  for (const line of body.split("\n")) {
    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (candidate.length <= size) {
      buffer = candidate;
      continue;
    }
    if (buffer) {
      chunks.push(buffer);
      buffer = "";
    }
    let rest = line;
    while (rest.length > size) {
      // 在标点处断开，实在没有就硬切
      const window = rest.slice(0, size);
      const point = Math.max(
        window.lastIndexOf("。"),
        window.lastIndexOf("；"),
        window.lastIndexOf("，"),
      );
      const cut = point > size * 0.6 ? point + 1 : size;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    buffer = rest;
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

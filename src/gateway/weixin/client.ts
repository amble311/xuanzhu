import { randomBytes } from "crypto";
import { fetch as httpFetch } from "undici";

/**
 * 腾讯 iLink Bot API 客户端（个人微信）。
 *
 * 协议参考 hermes-agent 的 `plugins/platforms/weixin/adapter.py`：
 * - 长轮询 `ilink/bot/getupdates` 收消息，不需要公网 webhook；
 * - 每条回复必须回显该对端最近的 `context_token`；
 * - 登录是扫码：`get_bot_qrcode` → `get_qrcode_status` 轮询。
 *
 * 这里只做**文本**：媒体走 AES-128-ECB 加密 CDN，属于另一套流程，
 * 先不把复杂度引进来（文档里已标为未支持）。
 */

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const APP_ID = "bot";
const CHANNEL_VERSION = "2.2.0";
/** (2 << 16) | (2 << 8) | 0 = 131584，与参考实现一致 */
const APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;

const API_TIMEOUT_MS = 15_000;
const LONG_POLL_TIMEOUT_MS = 35_000;
const QR_TIMEOUT_MS = 35_000;

export type QrStatus =
  | "wait"
  | "scaned"
  | "scaned_but_redirect"
  | "expired"
  | "confirmed"
  | "unknown";

export interface QrStatusResult {
  status: QrStatus;
  redirectHost?: string;
  accountId?: string;
  token?: string;
  baseUrl?: string;
  userId?: string;
}

export interface WeixinMessage {
  fromUserId: string;
  toUserId?: string;
  msgType?: number;
  msgId?: string;
  contextToken?: string;
  text: string;
}

export interface GetUpdatesResult {
  msgs: WeixinMessage[];
  syncBuf: string;
  /** iLink 的业务错误码：`-14` 会话过期、`-2` 限频 */
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** `X-WECHAT-UIN` 要的是「随机 uint32 的十进制字符串再 base64」，不是手机号 */
function randomUin(): string {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function headers(token: string | undefined, body?: string): Record<string, string> {
  const result: Record<string, string> = {
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": String(APP_CLIENT_VERSION),
    "X-WECHAT-UIN": randomUin(),
  };
  if (body !== undefined) {
    result["Content-Type"] = "application/json";
    result["AuthorizationType"] = "ilink_bot_token";
    result["Content-Length"] = String(Buffer.byteLength(body, "utf8"));
  }
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function requestJson<T>(
  method: "GET" | "POST",
  options: {
    baseUrl?: string;
    endpoint: string;
    token?: string;
    payload?: unknown;
    timeoutMs?: number;
  },
): Promise<T> {
  const base = (options.baseUrl ?? ILINK_BASE_URL).replace(/\/+$/, "");
  const body =
    options.payload === undefined
      ? undefined
      : JSON.stringify({
          ...(options.payload as Record<string, unknown>),
          base_info: { channel_version: CHANNEL_VERSION },
        });

  let response: Awaited<ReturnType<typeof httpFetch>>;
  try {
    response = await httpFetch(`${base}/${options.endpoint}`, {
      method,
      headers: headers(options.token, body),
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(
        `iLink ${options.endpoint} 超时（${options.timeoutMs ?? API_TIMEOUT_MS}ms）`,
      );
    }
    throw err;
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `iLink ${method} ${options.endpoint} HTTP ${response.status}：${raw.slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`iLink 返回的不是 JSON：${raw.slice(0, 200)}`);
  }
}

/** 取登录二维码：返回扫码用的 URL（微信要扫的是 `qrcode_img_content`，不是裸 token） */
export async function fetchQrCode(
  botType = "3",
): Promise<{ qrcode: string; url: string }> {
  const data = await requestJson<{ qrcode?: string; qrcode_img_content?: string }>(
    "GET",
    { endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, timeoutMs: QR_TIMEOUT_MS },
  );
  return {
    qrcode: String(data.qrcode ?? ""),
    url: String(data.qrcode_img_content ?? ""),
  };
}

export async function fetchQrStatus(
  qrcode: string,
  baseUrl = ILINK_BASE_URL,
): Promise<QrStatusResult> {
  const data = await requestJson<Record<string, unknown>>("GET", {
    baseUrl,
    endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    timeoutMs: QR_TIMEOUT_MS,
  });
  const status = String(data.status ?? "wait") as QrStatus;
  return {
    status: status === "wait" ||
      status === "scaned" ||
      status === "scaned_but_redirect" ||
      status === "expired" ||
      status === "confirmed"
      ? status
      : "unknown",
    redirectHost: data.redirect_host ? String(data.redirect_host) : undefined,
    accountId: data.ilink_bot_id ? String(data.ilink_bot_id) : undefined,
    token: data.bot_token ? String(data.bot_token) : undefined,
    baseUrl: data.baseurl ? String(data.baseurl) : undefined,
    userId: data.ilink_user_id ? String(data.ilink_user_id) : undefined,
  };
}

/** 从一条 update 里取出纯文本（只认 type=1 的 text_item） */
function extractText(item: Record<string, unknown>): string {
  const list = item.item_list;
  if (!Array.isArray(list)) return "";
  const parts: string[] = [];
  for (const entry of list) {
    const raw = (entry ?? {}) as Record<string, unknown>;
    if (Number(raw.type) !== 1) continue;
    const textItem = (raw.text_item ?? {}) as { text?: unknown };
    if (typeof textItem.text === "string" && textItem.text.trim()) {
      parts.push(textItem.text);
    }
  }
  return parts.join("\n").trim();
}

export async function getUpdates(options: {
  baseUrl: string;
  token: string;
  syncBuf: string;
}): Promise<GetUpdatesResult> {
  const data = await requestJson<{
    ret?: number;
    errcode?: number;
    errmsg?: string;
    msgs?: Array<Record<string, unknown>>;
    get_updates_buf?: string;
  }>("POST", {
    baseUrl: options.baseUrl,
    endpoint: "ilink/bot/getupdates",
    token: options.token,
    payload: { get_updates_buf: options.syncBuf },
    // 长轮询：服务端没消息时会挂住，超时是**正常**情况
    timeoutMs: LONG_POLL_TIMEOUT_MS,
  });

  const msgs: WeixinMessage[] = [];
  for (const raw of data.msgs ?? []) {
    const message = (raw ?? {}) as Record<string, unknown>;
    const text = extractText(message);
    const fromUserId = String(message.from_user_id ?? "");
    if (!fromUserId || !text) continue;
    msgs.push({
      fromUserId,
      toUserId: message.to_user_id ? String(message.to_user_id) : undefined,
      msgType: typeof message.msg_type === "number" ? message.msg_type : undefined,
      msgId: message.msg_id ? String(message.msg_id) : undefined,
      contextToken: message.context_token ? String(message.context_token) : undefined,
      text,
    });
  }

  return {
    msgs,
    syncBuf: typeof data.get_updates_buf === "string" ? data.get_updates_buf : options.syncBuf,
    ret: data.ret,
    errcode: data.errcode,
    errmsg: data.errmsg,
  };
}

/** 发文本；`-2 unknown error` 这类陈旧会话会让 iLink 拒绝，去掉 context_token 再试一次 */
export async function sendText(options: {
  baseUrl: string;
  token: string;
  to: string;
  text: string;
  contextToken?: string;
}): Promise<void> {
  const send = async (contextToken: string | undefined): Promise<void> => {
    await requestJson("POST", {
      baseUrl: options.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      token: options.token,
      payload: {
        msg: {
          from_user_id: "",
          to_user_id: options.to,
          client_id: `${Date.now()}-${randomBytes(4).toString("hex")}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: options.text } }],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
      },
    });
  };

  try {
    await send(options.contextToken);
  } catch (err) {
    if (!options.contextToken) throw err;
    // 会话不新鲜时 token 反而是障碍；参考实现同样「去 token 重试一次」
    await send(undefined);
  }
}

export async function sendTyping(options: {
  baseUrl: string;
  token: string;
  to: string;
  contextToken?: string;
  /** 1 = 开始，2 = 结束 */
  status?: 1 | 2;
}): Promise<void> {
  try {
    await requestJson("POST", {
      baseUrl: options.baseUrl,
      endpoint: "ilink/bot/sendtyping",
      token: options.token,
      payload: {
        ilink_user_id: options.to,
        typing_status: options.status ?? 1,
        ...(options.contextToken ? { context_token: options.contextToken } : {}),
      },
      timeoutMs: 8_000,
    });
  } catch {
    // 打字状态是锦上添花，失败不影响收发
  }
}

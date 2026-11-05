import * as crypto from "crypto";
import { fetch as undiciFetch } from "undici";

/**
 * 币安**私有接口**（需要签名）。
 *
 * ## 边界（这里就是「代码级」的那道门）
 *
 * | 类别 | 端点 | 说明 |
 * |---|---|---|
 * | 只读 | `/fapi/v2/account` | 合约余额 |
 * | 只读 | `/fapi/v2/positionRisk` | 持仓 |
 * | 只读 | `/fapi/v1/openOrders` | 挂单 |
 * | 交易 | `POST /fapi/v1/order` | 下单（市价 / 限价） |
 * | 交易 | `DELETE /fapi/v1/order` · `/fapi/v1/allOpenOrders` | 撤单 |
 * | 设置 | `POST /fapi/v1/leverage` | 杠杆 |
 * | 划转 | `POST /sapi/v1/asset/transfer`（**仅 type=2**） | 合约 → 现货 |
 *
 * **刻意没有**：提现（`/sapi/v1/capital/withdraw/apply`）、现货交易（`/api/v3/order`）、
 * 以及「现货 → 合约」方向的划转。`transferContractToSpot` 把 `type` 写死为 2，
 * 调用方连参数都传不进来 —— 这是用户要求的「单向」。
 *
 * 端点全部写死在常量里：不接受调用方传路径或 baseUrl，拼错就等于连到别的环境。
 */

const FUTURES_BASE = "https://fapi.binance.com";
/** sapi 在现货域；只有单向划转用得到它 */
const SPOT_BASE = "https://api.binance.com";

const READ_ENDPOINTS = {
  account: "/fapi/v2/account",
  positions: "/fapi/v2/positionRisk",
  openOrders: "/fapi/v1/openOrders",
  exchangeInfo: "/fapi/v1/exchangeInfo",
} as const;

export type PrivateReadKind = keyof typeof READ_ENDPOINTS;

export interface PrivateCredential {
  apiKey: string;
  apiSecret: string;
}

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";

/** 取运行时 fetch：`applyProxyConfig()` 换掉的是 `globalThis.fetch` */
/**
 * 取**运行时**的 fetch。
 *
 * 不能存成模块级常量：`applyProxyConfig()` 会把 `globalThis.fetch` 换成带代理
 * dispatcher 的版本，而模块在进程启动时就已加载完 —— 存下来的旧函数虽然因为
 * `setGlobalDispatcher` 也走代理，但一旦哪天改掉那行就会静默失效。
 */
function runtimeFetch(): typeof undiciFetch {
  return (globalThis as { fetch?: typeof undiciFetch }).fetch ?? undiciFetch;
}

function sign(query: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

interface SignedRequestOptions {
  method: "GET" | "POST" | "DELETE";
  /** 完整 URL 前缀（只来自本文件的常量） */
  base: string;
  path: string;
  params?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
}

/**
 * 带签名的请求。
 *
 * 参数统一放进 query（币安对 POST 也接受 query），因此签名与 URL 是同一份字符串，
 * 不会出现「body 与签名不一致」这种难查的错误。
 */
async function signedRequest<T>(
  options: SignedRequestOptions,
  credential: PrivateCredential,
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value === undefined) continue;
    query.set(key, String(value));
  }
  query.set("recvWindow", "5000");
  query.set("timestamp", String(Date.now()));

  const payload = query.toString();
  const url = `${options.base}${options.path}?${payload}&signature=${sign(
    payload,
    credential.apiSecret,
  )}`;

  const response = await runtimeFetch()(url, {
    method: options.method,
    headers: { "X-MBX-APIKEY": credential.apiKey },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // 币安错误体形如 `{"code":-2015,"msg":"Invalid API-key..."}`：把 code 带出来，
    // 再翻成**可操作**的话 —— 模型看到「-2015」只会瞎猜，看到「权限不足」才知道下一步做什么
    let code: number | undefined;
    let msg: string | undefined;
    try {
      const parsed = JSON.parse(body) as { code?: number; msg?: string };
      code = typeof parsed.code === "number" ? parsed.code : undefined;
      msg = typeof parsed.msg === "string" ? parsed.msg : undefined;
    } catch {
      // 非 JSON（网关 502、HTML 错误页等）：保持原样截断
    }

    const hint = code === undefined ? undefined : ERROR_HINTS[code];
    const detail = msg ?? (body ? body.slice(0, 300) : "");
    throw new Error(
      `币安私有接口返回 HTTP ${response.status}` +
        (code !== undefined ? `（${code}）` : "") +
        (detail ? `：${detail}` : "") +
        (hint ? `\n→ ${hint}` : ""),
    );
  }
  return (await response.json()) as T;
}

/**
 * 常见错误码 → 可操作提示。
 *
 * 只收「看到之后知道该干什么」的码：不认识的码保持原样透传，
 * 编一段似是而非的解释比不解释更糟。
 */
const ERROR_HINTS: Record<number, string> = {
  [-2015]: "API Key 无效或权限不足：需要开启「合约交易」权限，并确认 IP 白名单包含本机",
  [-1021]: "本机时间与币安服务器偏差过大：校准系统时间（NTP）后重试",
  [-1022]: "签名不匹配：检查 API Secret 是否输错，或该 Key 已被重置",
  [-1111]: "精度错误：数量或价格不符合该交易对的 stepSize / tickSize",
  [-1013]: "下单数量不在允许区间（低于最小步长或超过单笔上限）",
  [-4003]: "数量超过单笔最大限制：拆小或改用 notional",
  [-4131]: "名义价值不足：加大数量（合约有最小下单金额）",
  [-4164]: "名义价值不足最小下单金额（minNotional）",
  [-2019]: "保证金不足：降低杠杆、减少数量或先平掉部分仓位",
  [-2011]: "撤单失败：订单已成交或已撤销",
  [-2022]: "reduceOnly 被拒：当前没有可减的持仓（不要用它开仓）",
};

/** 只读 GET（持牌白名单） */
export async function privateGet<T>(
  kind: PrivateReadKind,
  params: Record<string, string | number | undefined>,
  credential: PrivateCredential,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  return signedRequest<T>(
    {
      method: "GET",
      base: FUTURES_BASE,
      path: READ_ENDPOINTS[kind],
      params,
      timeoutMs: options.timeoutMs,
    },
    credential,
  );
}

export interface CreateOrderParams {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity?: string;
  price?: string;
  stopPrice?: string;
  timeInForce?: "GTC" | "IOC" | "FOK";
  reduceOnly?: boolean;
  /**
   * 平掉全部仓位（条件单用）。
   *
   * 与 `reduceOnly + quantity` 相比，它不锁定数量：仓位变了也仍然全平，
   * 而且是「限价开仓还没成交」时挂保护单的唯一安全写法。
   */
  closePosition?: boolean;
  /** 条件单用：触发价类型 */
  workingType?: "MARK_PRICE" | "CONTRACT_PRICE";
}

export interface OrderResponse {
  orderId?: number;
  symbol?: string;
  status?: string;
  side?: string;
  type?: string;
  origQty?: string;
  executedQty?: string;
  avgPrice?: string;
  price?: string;
  stopPrice?: string;
}

/** 下单（市价 / 限价 / 条件单） */
export async function createOrder(
  params: CreateOrderParams,
  credential: PrivateCredential,
): Promise<OrderResponse> {
  return signedRequest<OrderResponse>(
    {
      method: "POST",
      base: FUTURES_BASE,
      path: "/fapi/v1/order",
      params: {
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        quantity: params.quantity,
        price: params.price,
        stopPrice: params.stopPrice,
        timeInForce: params.timeInForce,
        reduceOnly: params.reduceOnly,
        closePosition: params.closePosition,
        workingType: params.workingType,
        newOrderRespType: "RESULT",
      },
    },
    credential,
  );
}

/**
 * 查询交易对当前杠杆。
 *
 * 开仓前算保证金要用已知杠杆：模型没显式给时不能假设 1x（BTC 永续常见 5–10x，
 * 按 1x 估算会把可用保证金高估成 1/9，明明能开的单被拒）。
 */
export async function fetchLeverage(
  params: { symbol: string },
  credential: PrivateCredential,
): Promise<number> {
  const result = await signedRequest<{ leverage?: number }>(
    {
      method: "GET",
      base: FUTURES_BASE,
      path: "/fapi/v1/leverage",
      params: { symbol: params.symbol },
    },
    credential,
  );
  const leverage = Number(result?.leverage);
  return Number.isFinite(leverage) && leverage > 0 ? leverage : 0;
}

/** 查单（确认限价单是否成交） */
export async function queryOrder(
  params: { symbol: string; orderId: string | number },
  credential: PrivateCredential,
): Promise<OrderResponse> {
  return signedRequest<OrderResponse>(
    {
      method: "GET",
      base: FUTURES_BASE,
      path: "/fapi/v1/order",
      params: { symbol: params.symbol, orderId: params.orderId },
    },
    credential,
  );
}

/** 撤单（按 orderId） */
export async function cancelOrder(
  params: { symbol: string; orderId: string | number },
  credential: PrivateCredential,
): Promise<unknown> {
  return signedRequest(
    {
      method: "DELETE",
      base: FUTURES_BASE,
      path: "/fapi/v1/order",
      params: { symbol: params.symbol, orderId: params.orderId },
    },
    credential,
  );
}

/** 撤掉某个交易对的全部挂单 */
export async function cancelAllOrders(
  params: { symbol: string },
  credential: PrivateCredential,
): Promise<unknown> {
  return signedRequest(
    {
      method: "DELETE",
      base: FUTURES_BASE,
      path: "/fapi/v1/allOpenOrders",
      params: { symbol: params.symbol },
    },
    credential,
  );
}

/** 设置杠杆 */
export async function setLeverage(
  params: { symbol: string; leverage: number },
  credential: PrivateCredential,
): Promise<unknown> {
  return signedRequest(
    {
      method: "POST",
      base: FUTURES_BASE,
      path: "/fapi/v1/leverage",
      params: { symbol: params.symbol, leverage: params.leverage },
    },
    credential,
  );
}

export interface TransferResult {
  tranId?: number;
  /** 实际划转的金额（USDT） */
  amount: number;
}

/**
 * 合约 → 现货 划转（**单向，写死 type=2**）。
 *
 * 用途：把已实现收益挪到现货，避免继续当作保证金被杠杆放大。
 * 反向（现货 → 合约）不提供：那等于给交易加弹药，风险性质完全不同。
 *
 * `type: 2` 是币安定义的「USDT 本位合约 → 现货」；这里不接受 type 参数，
 * 调用方也无法改成 1（现货 → 合约）。
 */
export async function transferContractToSpot(
  amount: number,
  credential: PrivateCredential,
): Promise<TransferResult> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("划转金额必须大于 0");
  }
  const result = await signedRequest<{ tranId?: number }>(
    {
      method: "POST",
      base: SPOT_BASE,
      path: "/sapi/v1/asset/transfer",
      params: {
        type: 2,
        asset: "USDT",
        amount: amount.toFixed(8),
      },
    },
    credential,
  );
  return { tranId: result.tranId, amount };
}

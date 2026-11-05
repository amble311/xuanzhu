import type { AccountSnapshot } from "./account";
import type { BtcAction } from "./actions";

/**
 * 挂单时效（order TTL）。
 *
 * 为什么需要：限价单挂出去之后，**当初的理由会过期** —— 价格可能已经走到
 * 相反方向、信号可能已经失效，但单子还挂在盘上等一个再也不该成交的价格。
 * 模型只在巡检时才会看，而巡检可能被排到 8 小时后，于是「一挂挂一天」。
 *
 * 分工：
 * - 下单时落一个 `expiresAt`（实盘写动作账本，模拟盘写 `paper_orders.expires_at`）；
 * - 常驻后端每 5 分钟检查一次，超时且仍未成交 / 只部分成交 → **叫醒一轮巡检**；
 * - 叫醒只负责「摆到眼前」，撤单 / 改价仍由模型决定（与 `btc_trigger` 同一原则）。
 *
 * 去重：同一个单只叫醒一次（记在 `run/events.json` 的 `orderTtlNotified`）。
 * 否则超时后每分钟叫一次，会变成烧钱循环。
 */

export const DEFAULT_ORDER_TTL_MIN = 60;
export const MAX_ORDER_TTL_MIN = 24 * 60;
/** 检查节拍：5 分钟（与叫醒条件一致；再密也没意义，行情不会因此变快） */
export const ORDER_TTL_CHECK_INTERVAL_MS = 5 * 60_000;

/** 计算挂单到期时间（ISO）；非法/缺失回落默认值 */
export function computeExpiresAt(
  ttlMinutes?: number,
  now = Date.now(),
): string {
  const minutes =
    typeof ttlMinutes === "number" && Number.isFinite(ttlMinutes) && ttlMinutes > 0
      ? Math.min(MAX_ORDER_TTL_MIN, Math.max(1, Math.round(ttlMinutes)))
      : DEFAULT_ORDER_TTL_MIN;
  return new Date(now + minutes * 60_000).toISOString();
}

export interface PaperOpenOrder {
  id: number;
  side: string;
  qty: number;
  limit_price: number;
  expires_at?: string | null;
}

export interface ExpiredOrderInfo {
  source: "live" | "paper";
  /** 开仓单还是平仓单：平仓单超时意味着「仓位还在」，更紧急 */
  kind: "open" | "close";
  /** 交易所订单号（实盘）或模拟盘订单 id */
  orderId?: number;
  symbol: string;
  side: "long" | "short";
  qty: number;
  limitPrice?: number;
  /** 已成交数量（实盘从交易所读；模拟盘无部分成交，恒为 0） */
  filledQty?: number;
  status: "unfilled" | "partial";
  expiresAt: string;
  /** 超时多久（分钟，向上取整） */
  overdueMin: number;
  /** 去重键：`action:<id>` / `paper:<id>` */
  key: string;
}

export interface FindExpiredInput {
  /** 实盘动作账本（模拟盘为空） */
  actions: BtcAction[];
  /** 模拟盘未成交挂单（实盘为空） */
  paperOrders?: PaperOpenOrder[];
  /** 实盘账户快照（用来判断「还在不在盘上、成交了多少」） */
  snapshot?: AccountSnapshot | null;
  now: number;
  /** 已提醒过的键（避免重复叫醒） */
  notified?: Record<string, string>;
}

/**
 * 找出「已超时但还在盘上」的挂单（纯函数）。
 *
 * 实盘刻意**要求能在 `snapshot.orders` 里找到该订单**：
 * 找不到说明它已经成交或已被撤销 —— 那是 preflight 的事，不该由 TTL 再叫一次。
 * 模拟盘没有「部分成交」概念，只看 `status='open'` 且过期。
 */
export function findExpiredOrders(input: FindExpiredInput): ExpiredOrderInfo[] {
  const { now } = input;
  const notified = input.notified ?? {};
  const result: ExpiredOrderInfo[] = [];

  for (const action of input.actions) {
    // 平仓单也要管：限价平仓不成交时，仓位与止损都还在，比开仓单超时更危险
    if (action.kind !== "open" && action.kind !== "close") continue;
    if (action.status !== "pending") continue;
    if (!action.expiresAt || !action.orderId) continue;
    const expires = Date.parse(action.expiresAt);
    if (Number.isNaN(expires) || expires > now) continue;

    const key = `action:${action.id}`;
    if (notified[key]) continue;

    // `snapshot.orders` 用可选链再兜一层：账户读不到时 snapshot 可能是 null，
    // 直接 `.find` 会抛 TypeError 把整轮 tick 打断（平仓单 pending 时就会走到这里）
    const order = (input.snapshot?.orders ?? []).find(
      (item) => item.orderId === action.orderId,
    );
    if (!order) continue; // 已成交 / 已撤销：交给前置核对，不重复叫醒

    const filledQty = order.filledQty ?? 0;
    result.push({
      source: "live",
      kind: action.kind === "close" ? "close" : "open",
      orderId: action.orderId,
      symbol: action.symbol,
      side: action.side ?? "long",
      qty: order.qty || action.qty || 0,
      limitPrice: action.limitPrice ?? order.price,
      filledQty,
      status: filledQty > 0 ? "partial" : "unfilled",
      expiresAt: action.expiresAt,
      overdueMin: Math.max(1, Math.ceil((now - expires) / 60_000)),
      key,
    });
  }

  for (const order of input.paperOrders ?? []) {
    if (!order.expires_at) continue;
    const expires = Date.parse(order.expires_at);
    if (Number.isNaN(expires) || expires > now) continue;

    const key = `paper:${order.id}`;
    if (notified[key]) continue;

    result.push({
      source: "paper",
      kind: "open",
      orderId: order.id,
      symbol: "",
      side: order.side === "short" ? "short" : "long",
      qty: order.qty,
      limitPrice: order.limit_price,
      filledQty: 0,
      status: "unfilled",
      expiresAt: order.expires_at,
      overdueMin: Math.max(1, Math.ceil((now - expires) / 60_000)),
      key,
    });
  }

  return result;
}

/** 注入巡检提示词的一段话（写清「是哪张单、超了多久、部分成交多少」） */
export function describeExpiredOrders(orders: ExpiredOrderInfo[]): string {
  return orders
    .map((order) => {
      const side = order.side === "long" ? "多" : "空";
      const price = order.limitPrice ? ` @ ${order.limitPrice}` : "";
      const label = order.kind === "close" ? "平仓单" : "开仓单";
      const partial =
        order.status === "partial"
          ? `，已部分成交 ${order.filledQty}/${order.qty}`
          : "，完全未成交";
      const extra =
        order.kind === "close"
          ? "；**仓位还在**，止损仍然有效"
          : "";
      return `- #${order.orderId ?? "?"} ${label} ${side} ${order.qty}${price}：已超时 ${order.overdueMin} 分钟${partial}${extra}`;
    })
    .join("\n");
}

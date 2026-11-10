import * as fs from "fs";
import * as path from "path";
import type { Quote } from "../exchange/ashare";
import { monitorDir } from "./watchlist";

/**
 * A 股挂单状态机（对齐 btc open → filled / cancelled / expired）。
 *
 * 模拟盘默认立即成交；只有用户/巡检显式要求 `pending: true` 时才会挂单。
 * 监控 tick 每轮检查一次：价格穿越则按限价成交，收盘前未成交则过期。
 */

export type OrderStatus = "open" | "filled" | "cancelled" | "expired";

export interface PendingOrder {
  id: string;
  code: string;
  name: string;
  side: "buy" | "sell";
  qty: number;
  limitPrice: number;
  status: OrderStatus;
  createdAt: string;
  expiresAt: string;
  reason: string;
  origin?: "inspect" | "manual";
}

interface OrderFile {
  version: number;
  orders: PendingOrder[];
}

const FILE = "run/pending-orders.json";

function filePath(): string {
  return path.join(monitorDir(), FILE);
}

function readFile(): OrderFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8")) as OrderFile;
    return { version: 1, orders: Array.isArray(parsed.orders) ? parsed.orders : [] };
  } catch {
    return { version: 1, orders: [] };
  }
}

function writeFile(file: OrderFile): void {
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
}

export function listOrders(): PendingOrder[] {
  return readFile().orders;
}

export function createOrder(input: {
  code: string;
  name: string;
  side: "buy" | "sell";
  qty: number;
  limitPrice: number;
  reason?: string;
  ttlMinutes?: number;
}): { ok: true; order: PendingOrder } | { ok: false; error: string } {
  if (!/^\d{6}$/.test(input.code)) return { ok: false, error: "股票代码必须是 6 位数字" };
  if (!Number.isFinite(input.limitPrice) || input.limitPrice <= 0) {
    return { ok: false, error: "限价必须为正数" };
  }
  if (!Number.isFinite(input.qty) || input.qty < 100) return { ok: false, error: "数量至少 100 股" };
  const now = new Date();
  const close = new Date(now);
  close.setHours(15, 0, 0, 0);
  if (close.getTime() <= now.getTime()) {
    // 收盘后/盘前：顺延到下一个工作日 15:00
    do {
      close.setDate(close.getDate() + 1);
      close.setHours(15, 0, 0, 0);
    } while (close.getDay() === 0 || close.getDay() === 6);
  }
  const ttl = new Date(now.getTime() + Math.max(1, input.ttlMinutes ?? 120) * 60_000);
  const expiresAt = ttl < close ? ttl : close;
  const order: PendingOrder = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    code: input.code,
    name: input.name,
    side: input.side,
    qty: Math.floor(input.qty / 100) * 100,
    limitPrice: input.limitPrice,
    status: "open",
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    reason: input.reason?.trim() || "挂单",
    origin: process.env.XZH_A_INSPECT === "1" ? "inspect" : "manual",
  };
  const file = readFile();
  file.orders.push(order);
  writeFile(file);
  return { ok: true, order };
}

export function cancelOrder(id: string): { ok: boolean; order?: PendingOrder; error?: string } {
  const file = readFile();
  const order = file.orders.find((item) => item.id === id);
  if (!order) return { ok: false, error: "没有找到该挂单" };
  if (order.status !== "open") return { ok: false, error: `挂单已经是 ${order.status}` };
  order.status = "cancelled";
  writeFile(file);
  return { ok: true, order };
}

/** 每轮监控调用：返回待成交 / 已过期，并把状态落盘 */
export function matchOrders(
  quotes: Map<string, Quote>,
  now = new Date(),
): { fills: PendingOrder[]; expired: PendingOrder[] } {
  const file = readFile();
  const fills: PendingOrder[] = [];
  const expired: PendingOrder[] = [];
  for (const order of file.orders) {
    if (order.status !== "open") continue;
    if (Date.parse(order.expiresAt) <= now.getTime()) {
      order.status = "expired";
      expired.push(order);
      continue;
    }
    const quote = quotes.get(order.code);
    if (!quote || quote.price <= 0) continue;
    const crossed =
      order.side === "buy" ? quote.price <= order.limitPrice : quote.price >= order.limitPrice;
    if (crossed) {
      order.status = "filled";
      fills.push(order);
    }
  }
  if (fills.length > 0 || expired.length > 0) writeFile(file);
  return { fills, expired };
}

export function describeOrder(order: PendingOrder): string {
  return `${order.side === "buy" ? "买" : "卖"} ${order.code} ${order.qty} @ ${order.limitPrice}（${order.status}）`;
}

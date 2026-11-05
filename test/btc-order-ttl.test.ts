import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountSnapshot } from "../src/btc/account";
import {
  appendAction,
  readActions,
  renewActionTtls,
  type BtcAction,
} from "../src/btc/actions";
import {
  computeExpiresAt,
  DEFAULT_ORDER_TTL_MIN,
  describeExpiredOrders,
  findExpiredOrders,
  MAX_ORDER_TTL_MIN,
} from "../src/btc/order-ttl";

/**
 * 挂单时效。
 *
 * 这类判定的价值全在边界上：
 * - 超时但**已经成交/撤销**的单不该再叫醒（否则每次巡检都要看一张不存在的单）；
 * - 部分成交必须叫醒（剩余部分的风险比全未成交更大）；
 * - 同一张单只叫醒一次，否则超时后每 5 分钟烧一轮模型。
 */
describe("挂单时效", () => {
  const now = Date.parse("2026-11-05T14:00:00Z");
  const overdue = new Date(now - 10 * 60_000).toISOString();
  const future = new Date(now + 30 * 60_000).toISOString();

  const openAction = (patch: Partial<BtcAction> = {}): BtcAction => ({
    id: "a1",
    ts: new Date(now - 70 * 60_000).toISOString(),
    kind: "open",
    symbol: "BTCUSDT",
    side: "short",
    qty: 1.2,
    limitPrice: 80276,
    orderId: 111,
    status: "pending",
    reason: "test",
    expiresAt: overdue,
    ...patch,
  });

  const snapshot = (orders: Array<{ orderId: number; qty: number; filledQty: number }>) =>
    ({ orders }) as unknown as AccountSnapshot;

  it("超时且仍在盘上、完全未成交 → 叫醒", () => {
    const result = findExpiredOrders({
      actions: [openAction()],
      snapshot: snapshot([{ orderId: 111, qty: 1.2, filledQty: 0 }]),
      now,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: "live",
      orderId: 111,
      status: "unfilled",
      overdueMin: 10,
    });
    expect(result[0].key).toBe("action:a1");
  });

  it("部分成交要单独标出（剩余部分风险更大）", () => {
    const result = findExpiredOrders({
      actions: [openAction()],
      snapshot: snapshot([{ orderId: 111, qty: 1.2, filledQty: 0.4 }]),
      now,
    });
    expect(result[0]).toMatchObject({ status: "partial", filledQty: 0.4 });
    expect(describeExpiredOrders(result)).toContain("已部分成交 0.4/1.2");
  });

  it("订单已不在盘上（成交/撤销）时不再叫醒 —— 那是前置核对的事", () => {
    const result = findExpiredOrders({
      actions: [openAction()],
      snapshot: snapshot([{ orderId: 999, qty: 1.2, filledQty: 0 }]),
      now,
    });
    expect(result).toEqual([]);
  });

  it("未到时效不叫醒", () => {
    const result = findExpiredOrders({
      actions: [openAction({ expiresAt: future })],
      snapshot: snapshot([{ orderId: 111, qty: 1.2, filledQty: 0 }]),
      now,
    });
    expect(result).toEqual([]);
  });

  it("同一张单只叫醒一次", () => {
    const result = findExpiredOrders({
      actions: [openAction()],
      snapshot: snapshot([{ orderId: 111, qty: 1.2, filledQty: 0 }]),
      now,
      notified: { "action:a1": new Date(now - 5 * 60_000).toISOString() },
    });
    expect(result).toEqual([]);
  });

  it("已撤销 / 已成交的动作不参与时效判定", () => {
    for (const status of ["filled", "cancelled"] as const) {
      const result = findExpiredOrders({
        actions: [openAction({ status })],
        snapshot: snapshot([{ orderId: 111, qty: 1.2, filledQty: 0 }]),
        now,
      });
      expect(result).toEqual([]);
    }
  });

  it("模拟盘：只看 status=open 且过期的挂单", () => {
    const result = findExpiredOrders({
      actions: [],
      paperOrders: [
        { id: 7, side: "long", qty: 1, limit_price: 76000, expires_at: overdue },
        { id: 8, side: "short", qty: 1, limit_price: 81000, expires_at: future },
        { id: 9, side: "long", qty: 1, limit_price: 75000, expires_at: null },
      ],
      now,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ source: "paper", orderId: 7, status: "unfilled" });
  });

  describe("续期（继续等时用）", () => {
    let home: string;

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-renew-"));
      process.env.XZH_BTC_HOME = home;
    });

    afterEach(() => {
      delete process.env.XZH_BTC_HOME;
      fs.rmSync(home, { recursive: true, force: true });
    });

    it("只续期仍未结算的开/平仓单，已成交的不动", () => {
      const open = appendAction(home, {
        kind: "open",
        symbol: "BTCUSDT",
        side: "short",
        qty: 1,
        orderId: 1,
        reason: "t",
        expiresAt: overdue,
      });
      appendAction(home, {
        kind: "close",
        symbol: "BTCUSDT",
        side: "long",
        qty: 1,
        orderId: 2,
        reason: "t",
        expiresAt: overdue,
      });
      const filled = appendAction(home, {
        kind: "open",
        symbol: "BTCUSDT",
        side: "long",
        qty: 1,
        orderId: 3,
        status: "filled",
        reason: "t",
        expiresAt: overdue,
      });

      const result = renewActionTtls(home, { minutes: 30, now });
      expect(result.renewed).toHaveLength(2);
      expect(Date.parse(result.expiresAt)).toBe(now + 30 * 60_000);

      const after = readActions(home);
      expect(after.find((item) => item.id === open.id)?.expiresAt).toBe(
        result.expiresAt,
      );
      expect(after.find((item) => item.id === filled.id)?.expiresAt).toBe(
        overdue,
      );
    });

    it("按 orderId 只续期指定的一张；没有挂单时返回空", () => {
      appendAction(home, {
        kind: "open",
        symbol: "BTCUSDT",
        side: "short",
        qty: 1,
        orderId: 11,
        reason: "t",
        expiresAt: overdue,
      });
      appendAction(home, {
        kind: "open",
        symbol: "BTCUSDT",
        side: "short",
        qty: 1,
        orderId: 12,
        reason: "t",
        expiresAt: overdue,
      });

      const one = renewActionTtls(home, { orderId: 11, minutes: 10, now });
      expect(one.renewed).toHaveLength(1);
      expect(one.renewed[0].orderId).toBe(11);

      const none = renewActionTtls(home, { orderId: 999, minutes: 10, now });
      expect(none.renewed).toEqual([]);
    });
  });

  it("computeExpiresAt：默认 60 分钟、上限一天、非法值回落默认", () => {
    const base = Date.parse("2026-11-05T14:00:00Z");
    expect(Date.parse(computeExpiresAt(undefined, base)) - base).toBe(
      DEFAULT_ORDER_TTL_MIN * 60_000,
    );
    expect(Date.parse(computeExpiresAt(9999, base)) - base).toBe(
      MAX_ORDER_TTL_MIN * 60_000,
    );
    expect(Date.parse(computeExpiresAt(0, base)) - base).toBe(
      DEFAULT_ORDER_TTL_MIN * 60_000,
    );
  });
});

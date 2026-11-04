import { describe, expect, it } from "vitest";
import {
  dueMarketEvent,
  lastDailyClose,
  lastFundingSettle,
  lastHourClose,
  volatilityDue,
  VOLATILITY_COOLDOWN_MS,
} from "../src/btc/market-events";

/**
 * 市场事件的时点判断（纯函数，用固定 UTC 时间测）。
 *
 * 这些规则存在的理由：模型把巡检定在 8 小时后，日线收盘 / 资金费结算 / 暴跌
 * 都会错过。代码必须自己兜住，且**不能重复触发**（宽限期 + 已处理标记）。
 */
describe("市场事件时点", () => {
  const at = (iso: string) => Date.parse(iso);

  it("日线收盘 / 资金费 / 整点的取整正确", () => {
    const now = at("2026-11-04T13:07:22Z");
    expect(lastDailyClose(now)).toBe(at("2026-11-04T00:00:00Z"));
    expect(lastFundingSettle(now)).toBe(at("2026-11-04T08:00:00Z"));
    expect(lastHourClose(now)).toBe(at("2026-11-04T13:00:00Z"));

    // 16:00 之后进入当天的第三个资金费时段
    expect(lastFundingSettle(at("2026-11-04T16:00:01Z"))).toBe(
      at("2026-11-04T16:00:00Z"),
    );
    // 00:00 刚过 = 新一天的日线收盘
    expect(lastDailyClose(at("2026-11-04T00:00:30Z"))).toBe(
      at("2026-11-04T00:00:00Z"),
    );
  });

  it("日线收盘后 1 分钟内触发，超过宽限期不补跑", () => {
    const close = at("2026-11-04T00:00:00Z");
    expect(
      dueMarketEvent(close + 60_000, { hasPosition: false, lastHandled: {} })
        ?.kind,
    ).toBe("daily-close");

    // 后端停机很久才起来：不该把几小时前的时点补一遍
    expect(
      dueMarketEvent(close + 10 * 60_000, {
        hasPosition: false,
        lastHandled: {},
      }),
    ).toBeNull();
  });

  it("同一时刻的多个事件要一起标记，否则下一分钟会再触发", () => {
    const close = at("2026-11-04T00:00:00Z");
    const first = dueMarketEvent(close + 60_000, {
      hasPosition: false,
      lastHandled: {},
    });
    expect(first?.kind).toBe("daily-close");
    // UTC 00:00 也是资金费结算点
    expect(first?.sameInstant).toContain("funding");

    // 只标记日线收盘：资金费仍会命中（这正是需要 sameInstant 的原因）
    expect(
      dueMarketEvent(close + 60_000, {
        hasPosition: false,
        lastHandled: { "daily-close": close },
      })?.kind,
    ).toBe("funding");

    // 两个都标记后不再触发
    expect(
      dueMarketEvent(close + 60_000, {
        hasPosition: false,
        lastHandled: { "daily-close": close, funding: close },
      }),
    ).toBeNull();
  });

  it("资金费结算点触发", () => {
    const funding = at("2026-11-04T08:00:00Z");
    const hit = dueMarketEvent(funding + 30_000, {
      hasPosition: false,
      lastHandled: {},
    });
    expect(hit?.kind).toBe("funding");
    expect(hit?.reason).toContain("资金费");
  });

  it("小时线只在有持仓（或挂单）时才值得跑", () => {
    const hour = at("2026-11-04T13:00:00Z");
    // 无持仓：13:00 距日线收盘 13 小时、距资金费 5 小时，都不在宽限期 → 什么都不触发
    expect(
      dueMarketEvent(hour + 30_000, { hasPosition: false, lastHandled: {} }),
    ).toBeNull();

    expect(
      dueMarketEvent(hour + 30_000, { hasPosition: true, lastHandled: {} })
        ?.kind,
    ).toBe("hourly-close");
  });
});

describe("波动触发", () => {
  it("达到阈值才算（默认 2.5%）", () => {
    expect(volatilityDue({ price: 102.5, lastPrice: 100, now: 0 }).due).toBe(true);
    expect(volatilityDue({ price: 101, lastPrice: 100, now: 0 }).due).toBe(false);
    // 下跌同样算
    expect(volatilityDue({ price: 97, lastPrice: 100, now: 0 }).due).toBe(true);
  });

  it("没有基准价时不触发（刚启动，没有可比对象）", () => {
    expect(volatilityDue({ price: 100, now: 0 }).due).toBe(false);
    expect(volatilityDue({ price: 100, lastPrice: 0, now: 0 }).due).toBe(false);
  });

  it("冷却期内不重复触发，冷却结束才允许", () => {
    const base = { price: 105, lastPrice: 100, lastTriggeredAt: 1_000 };

    expect(volatilityDue({ ...base, now: 1_000 + 60_000 }).due).toBe(false);
    expect(
      volatilityDue({ ...base, now: 1_000 + VOLATILITY_COOLDOWN_MS + 1 }).due,
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  adjustmentChanged,
  buildIndicators,
  computeIndicators,
  dropUnclosedDaily,
  toAdjustedBar,
  weekdayGap,
} from "../src/a/indicators";
import { createMemoryBarStore } from "../src/a/bar-store";
import { dailyIndicatorsFor, periodBarsFor } from "../src/a/signal";
import type { Bar } from "../src/exchange/ashare";
import type { SnapshotRow } from "../src/a/snapshot";

/**
 * 全市场日线的**增量**更新（`bars.db`）。
 *
 * 关键不变量：
 * ① 库里已有 140 根 + 今天收盘快照 → 只补今天这一根，**不再发请求**；
 * ② 除权（ratio 变了）→ 该股票整段重取，不能拿旧比例补；
 * ③ 中间漏了交易日（进程停过 / 长假）→ 整段重取，不能拿不连续的历史算趋势；
 * ④ 盘中快照不落库（那一根还没收完）。
 */

const CODE = "600519";
const TODAY = "2026-11-19";
/** 2026-11-19 16:00（本地时区）：已收盘，快照可以落成一根日线 */
const NOW = new Date(2026, 10, 19, 16, 0, 0);

function bars(count: number, close: number, end = "2026-11-18"): Bar[] {
  const last = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const at = last - (count - 1 - index) * 86_400_000;
    const day = new Date(at).toISOString().slice(0, 10);
    return {
      time: day,
      open: close,
      high: close * 1.02,
      low: close * 0.98,
      close,
      volume: 1000,
      amount: 10_000_000,
    };
  });
}

function snapshotRow(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    code: CODE,
    name: "贵州茅台",
    price: 10,
    preClose: 10,
    pct: 0,
    open: 10,
    high: 10.2,
    low: 9.8,
    volume: 1000,
    amount: 10_000_000,
    board: "main",
    st: false,
    ...overrides,
  };
}

function snapshotOf(row: SnapshotRow = snapshotRow(), date = TODAY) {
  return { date, rows: new Map([[row.code, row]]) };
}

const neverFetch = (): Promise<Bar[]> => {
  throw new Error("不应发起网络请求");
};

describe("复权换算与除权检测", () => {
  it("原始 bar × ratio 得到后复权 bar，量额不变", () => {
    const bar = toAdjustedBar(snapshotRow({ price: 16.18, open: 16, high: 16.5, low: 15.9 }), TODAY, 46.2);
    expect(bar.time).toBe(TODAY);
    expect(bar.close).toBeCloseTo(747.52, 1);
    expect(bar.open).toBeCloseTo(739.2, 1);
    expect(bar.volume).toBe(1000);
    expect(bar.amount).toBe(10_000_000);
  });

  it("preClose × ratio 与库内后复权收盘一致 → 未除权", () => {
    expect(adjustmentChanged(747.44, 16.18, 46.2)).toBe(false);
  });

  it("分红 / 送转让 preClose 变了 → 判定为除权", () => {
    // 10 派 1 元：preClose 从 16.18 降到 16.08，乘出来的后复权价差 0.6%
    expect(adjustmentChanged(747.44, 15.0, 46.2)).toBe(true);
  });
});

describe("漏交易日判断（不查日历）", () => {
  it("周五 → 下周一算相邻交易日", () => {
    expect(weekdayGap("2026-11-13", "2026-11-16")).toBe(0);
  });

  it("漏了周一至周三 → 必须重取", () => {
    expect(weekdayGap("2026-11-13", "2026-11-19")).toBe(3);
  });
});

/**
 * 占位 K 线：2026-11-20 实测同花顺对 601939 / 601328 / 601838 返回
 * `open/high/low = 0、volume = 0`、只有 close 有值的当天日线。
 * 它是「日线数据不足」的直接原因（low20 被算成 0 → dailyTrend 的 !low20 命中）。
 */
describe("占位 K 线（OHLC=0）", () => {
  const placeholder = (): Bar => ({
    time: TODAY,
    open: 0,
    high: 0,
    low: 0,
    close: 10,
    volume: 0,
    amount: 0,
  });

  it("computeIndicators 会剔除它，low20 不再变成 0", () => {
    const list = [...bars(139, 10, "2026-11-19"), placeholder()];
    const item = computeIndicators(CODE, list);
    expect(item?.bars).toBe(139);
    expect(item?.low20).toBeGreaterThan(0);
    expect(item?.high20).toBeGreaterThan(0);
  });

  it("收盘后也会丢掉它（不是「没收盘」，是坏数据）", () => {
    const list = [...bars(2, 10, "2026-11-18"), placeholder()];
    expect(dropUnclosedDaily(NOW, list)).toHaveLength(2);
  });

  it("库里最后一根是占位 K 线 → 整段重取并修好", async () => {
    const store = createMemoryBarStore();
    store.upsert(CODE, [...bars(139, 10, "2026-11-19"), placeholder()], {
      code: CODE,
      ratio: 1.478,
      lastDate: TODAY,
      rawClose: 10,
      updatedAt: NOW.toISOString(),
    });

    let calls = 0;
    const result = await buildIndicators([CODE], {
      store,
      snapshot: snapshotOf(snapshotRow({ price: 10.4, preClose: 10 })),
      now: NOW,
      verifySample: 0,
      fetchDaily: async () => {
        calls += 1;
        return bars(140, 10, TODAY);
      },
    });

    expect(calls).toBe(1);
    expect(result.items[0].low20).toBeGreaterThan(0);
    // 重取后入库的那根必须是有效 OHLC
    expect(store.load(CODE, 1)[0].open).toBeGreaterThan(0);
  });
});

describe("未收盘数据不入库（崩溃场景）", () => {
  it("盘中取回的日线会带一根「正在走」的当天 K 线，必须丢掉", () => {
    const intraday = new Date(2026, 10, 19, 14, 0, 0);
    const barsToDay = bars(3, 10, TODAY);
    expect(dropUnclosedDaily(NOW, barsToDay)).toHaveLength(3);
    const dropped = dropUnclosedDaily(intraday, barsToDay);
    expect(dropped).toHaveLength(2);
    expect(dropped[dropped.length - 1].time.slice(0, 10)).toBe("2026-11-18");
  });

  it("盘中构建：当天那根不落库，指标停在上一交易日", async () => {
    const store = createMemoryBarStore();
    const result = await buildIndicators([CODE], {
      store,
      now: new Date(2026, 10, 19, 14, 0, 0),
      verifySample: 0,
      // 同花顺的 last.js 会带上当天正在走的那根
      fetchDaily: async () => bars(140, 10, TODAY),
    });

    expect(result.items[0].asOf).toBe("2026-11-18");
    expect(store.meta(CODE)?.lastDate).toBe("2026-11-18");
  });
});

/**
 * 巡检里「日线数据不足」的真正来源：`a_signal` 以前不传全市场指标缓存，
 * 每只股票都各拉 140 根日线；同花顺连续请求偶发失败 → 那一只直接判 unknown。
 */
describe("单只日线指标的三级兜底", () => {
  it("全市场缓存命中：不再发请求", async () => {
    const cached = new Map([
      [
        CODE,
        {
          code: CODE,
          asOf: "2026-11-19",
          close: 10,
          ma20: 9,
          ma50: 8,
          high20: 11,
          low20: 9,
          rsi14: 55,
          bars: 140,
        } as never,
      ],
    ]);
    const value = await dailyIndicatorsFor(CODE, { indicators: cached, fetchDaily: neverFetch });
    expect(value?.ma20).toBe(9);
  });

  it("单只请求失败：退回本地日线仓库，不把方向判成 unknown", async () => {
    const store = createMemoryBarStore();
    store.upsert(CODE, bars(140, 10), {
      code: CODE,
      ratio: 1,
      lastDate: "2026-11-19",
      rawClose: 10,
      updatedAt: NOW.toISOString(),
    });
    const value = await dailyIndicatorsFor(CODE, {
      store,
      fetchDaily: async () => {
        throw new Error("同花顺偶发失败");
      },
    });
    expect(value?.bars).toBe(140);
    expect(value?.ma20).toBeCloseTo(10, 5);
  });

  it("缓存与仓库都没有：返回 null（结论如实说数据缺失）", async () => {
    const value = await dailyIndicatorsFor(CODE, {
      store: createMemoryBarStore(),
      fetchDaily: async () => {
        throw new Error("失败");
      },
    });
    expect(value).toBeNull();
  });
});

/**
 * 周线 / 月线是巡检里最容易「偶发失败」的两类请求（每轮每只各一次）。
 * 失败一次就让三周期变 unknown，所以要有「上次成功」的兜底。
 */
describe("周/月线缓存兜底", () => {
  it("成功时写入仓库", async () => {
    const store = createMemoryBarStore();
    const got = await periodBarsFor(CODE, "week", 80, {
      store,
      fetch: async () => bars(80, 10, "2026-11-20"),
    });
    expect(got).toHaveLength(80);
    expect(store.loadPeriod(CODE, "week", 80)).toHaveLength(80);
  });

  it("网络失败时用上次成功的序列", async () => {
    const store = createMemoryBarStore();
    store.upsertPeriod(CODE, "week", bars(70, 9, "2026-11-13"));
    const got = await periodBarsFor(CODE, "week", 80, {
      store,
      fetch: async () => {
        throw new Error("同花顺 502");
      },
    });
    expect(got).toHaveLength(70);
    expect(got?.[got.length - 1].close).toBe(9);
  });

  it("返回空数组也算失败（同样走缓存）", async () => {
    const store = createMemoryBarStore();
    store.upsertPeriod(CODE, "month", bars(30, 8, "2026-11-01"));
    const got = await periodBarsFor(CODE, "month", 60, { store, fetch: async () => [] });
    expect(got).toHaveLength(30);
  });

  it("从来没成功过才返回 null（让结论如实说缺失）", async () => {
    const got = await periodBarsFor(CODE, "month", 60, {
      store: createMemoryBarStore(),
      fetch: async () => {
        throw new Error("失败");
      },
    });
    expect(got).toBeNull();
  });
});

describe("增量构建指标", () => {
  it("有完整历史 + 收盘快照：只补今天一根，不发请求", async () => {
    const store = createMemoryBarStore();
    store.upsert(CODE, bars(140, 10), {
      code: CODE,
      ratio: 1,
      lastDate: "2026-11-18",
      rawClose: 10,
      updatedAt: NOW.toISOString(),
    });

    const result = await buildIndicators([CODE], {
      store,
      snapshot: snapshotOf(snapshotRow({ price: 10.4, preClose: 10, open: 10, high: 10.5, low: 9.9 })),
      now: NOW,
      fetchDaily: neverFetch,
    });

    expect(result.fetched).toBe(0);
    expect(result.reused).toBe(1);
    expect(result.items[0].asOf).toBe(TODAY);
    expect(result.items[0].close).toBe(10.4);
    // 计算窗口仍是最近 140 根（补进来的那根挤掉了最老的一根）
    expect(result.items[0].bars).toBe(140);
    expect(store.meta(CODE)?.lastDate).toBe(TODAY);
  });

  it("除权后整段重取，并按新比例入库", async () => {
    const store = createMemoryBarStore();
    store.upsert(CODE, bars(140, 20), {
      code: CODE,
      ratio: 2,
      lastDate: "2026-11-18",
      rawClose: 10,
      updatedAt: NOW.toISOString(),
    });

    let calls = 0;
    const result = await buildIndicators([CODE], {
      store,
      // 原始 preClose 9.5 × 旧 ratio 2 = 19，与库内 20 差 5% → 除权
      snapshot: snapshotOf(snapshotRow({ price: 9.6, preClose: 9.5, open: 9.5, high: 9.7, low: 9.4 })),
      now: NOW,
      fetchDaily: async () => {
        calls += 1;
        return bars(140, 19.2, TODAY);
      },
    });

    expect(calls).toBe(1);
    expect(result.fetched).toBe(1);
    expect(result.items[0].close).toBe(19.2);
    // 新比例 = 后复权收盘 19.2 / 原始价 9.6
    expect(store.meta(CODE)?.ratio).toBeCloseTo(2, 5);
  });

  it("中间漏了交易日：不吃旧历史，整段重取", async () => {
    const store = createMemoryBarStore();
    store.upsert(CODE, bars(140, 10), {
      code: CODE,
      ratio: 1,
      lastDate: "2026-11-13",
      rawClose: 10,
      updatedAt: NOW.toISOString(),
    });

    let calls = 0;
    const result = await buildIndicators([CODE], {
      store,
      snapshot: snapshotOf(),
      now: NOW,
      fetchDaily: async () => {
        calls += 1;
        return bars(140, 10, TODAY);
      },
    });

    expect(calls).toBe(1);
    expect(result.fetched).toBe(1);
  });

  it("盘中快照不落库（那一根还没收完）", async () => {
    const store = createMemoryBarStore();
    store.upsert(CODE, bars(140, 10), {
      code: CODE,
      ratio: 1,
      lastDate: "2026-11-18",
      rawClose: 10,
      updatedAt: NOW.toISOString(),
    });

    const result = await buildIndicators([CODE], {
      store,
      snapshot: snapshotOf(snapshotRow({ price: 10.4 })),
      // 14:00 仍在连续竞价
      now: new Date(2026, 10, 19, 14, 0, 0),
      fetchDaily: neverFetch,
    });

    expect(result.items[0].asOf).toBe("2026-11-18");
    expect(store.meta(CODE)?.lastDate).toBe("2026-11-18");
  });

  it("库里没有数据时退回逐只取数并入库", async () => {
    const store = createMemoryBarStore();
    let calls = 0;
    const result = await buildIndicators([CODE], {
      store,
      snapshot: snapshotOf(),
      now: NOW,
      fetchDaily: async () => {
        calls += 1;
        return bars(140, 10, TODAY);
      },
    });

    expect(calls).toBe(1);
    expect(result.fetched).toBe(1);
    expect(store.meta(CODE)?.lastDate).toBe(TODAY);
    // 后复权价 10 / 原始价 10 = 1，明天可以直接增量
    expect(store.meta(CODE)?.ratio).toBe(1);
  });

  it("停机漏了交易日：重启后整段重取，历史接上", async () => {
    const store = createMemoryBarStore();
    store.upsert(CODE, bars(140, 10, "2026-11-17"), {
      code: CODE,
      ratio: 1,
      lastDate: "2026-11-17",
      rawClose: 10,
      updatedAt: NOW.toISOString(),
    });

    let calls = 0;
    const result = await buildIndicators([CODE], {
      store,
      snapshot: snapshotOf(),
      now: NOW,
      verifySample: 0,
      fetchDaily: async () => {
        calls += 1;
        return bars(140, 10, TODAY);
      },
    });

    // 11-18 那天没补上 → 不能直接追加，必须整段重取
    expect(calls).toBe(1);
    expect(result.fetched).toBe(1);
    expect(store.meta(CODE)?.lastDate).toBe(TODAY);
  });

  it("抽样校对：补的那根与官方差太多时按官方覆盖", async () => {
    const store = createMemoryBarStore();
    store.upsert(CODE, bars(140, 10), {
      code: CODE,
      ratio: 1,
      lastDate: "2026-11-18",
      rawClose: 10,
      updatedAt: NOW.toISOString(),
    });

    let calls = 0;
    const result = await buildIndicators([CODE], {
      store,
      snapshot: snapshotOf(snapshotRow({ price: 10.4, preClose: 10 })),
      now: NOW,
      verifySample: 1,
      // 只会被「抽样校对」调用一次，且给出与增量结果不同的收盘（11 vs 10.4）
      fetchDaily: async () => {
        calls += 1;
        return bars(140, 11, TODAY);
      },
    });

    expect(calls).toBe(1);
    expect(result.mismatched).toBe(1);
    expect(result.items[0].close).toBe(11);
    expect(store.load(CODE, 1)[0].close).toBe(11);
  });
});

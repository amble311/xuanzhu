import { describe, expect, it } from "vitest";
import {
  adjustmentChanged,
  buildIndicators,
  dropUnclosedDaily,
  toAdjustedBar,
  weekdayGap,
} from "../src/a/indicators";
import { createMemoryBarStore } from "../src/a/bar-store";
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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clampToWorkTime,
  normalizeScheduleTimes,
  pushSchedule,
  readScheduleQueue,
  removeSchedules,
  takeDueSchedule,
} from "../src/a/schedule";
import {
  addRule,
  commitRuleHit,
  describeRule,
  evaluateFormula,
  evaluateRules,
  readRules,
  removeRules,
  ruleNeedsBars15m,
  validateFormula,
  type MonitorRule,
} from "../src/a/rules";
import { isPaused, readPause, setPaused } from "../src/a/pause";
import { takeMarketEvent } from "../src/a/events";
import { appendRuleAudit, readRuleAudits } from "../src/a/rule-audit";
import { markPositionRisksDelivered, readPositionRisks, writePositionRisks } from "../src/a/risk-alerts";
import { describeSelection, shouldRunAfterCloseSelection } from "../src/a/monitor";
import { formatLocalTime } from "../src/utils/time";
import { checkAccountRisk, clearRiskTrigger, readRiskState } from "../src/a/risk";
import { appendAInspectEvent, currentAInspectOffset, readAInspectEvents } from "../src/a/inspect-stream";
import { cancelOrder, createOrder, listOrders, matchOrders } from "../src/a/orders";
import { aInfoLines } from "../src/a/info";
import { emptyPaperAccount } from "../src/a/paper";

let home: string;
const original = process.env.XZH_A_HOME;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-a-daemon-"));
  process.env.XZH_A_HOME = home;
});

afterAll(() => {
  if (original === undefined) delete process.env.XZH_A_HOME;
  else process.env.XZH_A_HOME = original;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("排期队列", () => {
  it("越界时间夹进交易时段（09:30–11:30 / 13:00–15:00，可跨日）", () => {
    const saturday = clampToWorkTime(new Date("2026-11-07T10:00:00"), new Date("2026-11-06T10:00:00"));
    expect(saturday.at.getDay()).toBe(1); // 周一
    expect(saturday.at.getHours()).toBe(9);
    expect(saturday.at.getMinutes()).toBe(30);

    // 收盘后 → 下一个工作日开盘（跨日）
    const late = clampToWorkTime(new Date("2026-11-10T16:00:00"), new Date("2026-11-10T10:00:00"));
    expect(late.at.getDate()).toBe(11);
    expect(late.at.getHours()).toBe(9);
    expect(late.at.getMinutes()).toBe(30);

    // 早于 09:30（含集合竞价）→ 当日开盘
    const preOpen = clampToWorkTime(new Date("2026-11-09T09:05:00"), new Date("2026-11-09T08:00:00"));
    expect(preOpen.at.getHours()).toBe(9);
    expect(preOpen.at.getMinutes()).toBe(30);
    expect(preOpen.clamped).toBe(true);

    // 午休 → 当日 13:00（不推到第二天）
    const lunch = clampToWorkTime(new Date("2026-11-09T12:20:00"), new Date("2026-11-09T10:00:00"));
    expect(lunch.at.getDate()).toBe(9);
    expect(lunch.at.getHours()).toBe(13);
    expect(lunch.at.getMinutes()).toBe(0);

    // 下午收盘后（15:05）→ 下一个工作日 09:30
    const afterClose = clampToWorkTime(
      new Date("2026-11-09T15:05:00"),
      new Date("2026-11-09T14:00:00"),
    );
    expect(afterClose.at.getDate()).toBe(10);
    expect(afterClose.at.getHours()).toBe(9);
    expect(afterClose.at.getMinutes()).toBe(30);
  });

  it("历史遗留的越界排期在启动时被顺延进交易时段", () => {
    const file = path.join(home, "monitor", "run", "schedules.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = new Date("2026-11-10T12:20:00+08:00");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "legacy",
            at: at.toISOString(),
            reason: "午休排期",
            slot: "next",
            origin: "inspect",
            createdAt: at.toISOString(),
          },
        ],
      }),
      "utf8",
    );
    expect(normalizeScheduleTimes(new Date("2026-11-10T10:00:00+08:00"))).toBe(1);
    expect(readScheduleQueue()[0].at).toBe(
      new Date("2026-11-10T13:00:00+08:00").toISOString(),
    );
    expect(readScheduleQueue()[0].clamped).toBe(true);
  });

  it("next 唯一、extra 同分钟去重、到期即出队", () => {
    removeAll();
    const target = new Date();
    // 取「下一个工作日」：明天若是周末， clampToWorkTime 会把它推到周一 09:30，
    // 用周末日期当 target 会让 +11 分钟根本还没到排期时间（周五跑必挂）
    do {
      target.setDate(target.getDate() + 1);
    } while (target.getDay() === 0 || target.getDay() === 6);
    target.setHours(10, 0, 0, 0);
    const at = target.toISOString();
    pushSchedule({ at, reason: "第一轮" });
    pushSchedule({ at, reason: "第二轮" });
    expect(readScheduleQueue().filter((entry) => entry.slot === "next")).toHaveLength(1);
    expect(readScheduleQueue()[0].reason).toBe("第二轮");
    pushSchedule({ at, reason: "额外", slot: "extra" });
    pushSchedule({ at, reason: "额外重复", slot: "extra" });
    expect(readScheduleQueue()).toHaveLength(2);
    const due = takeDueSchedule(new Date(target.getTime() + 11 * 60_000));
    expect(due).not.toBeNull();
    expect(readScheduleQueue()).toHaveLength(1);
  });
});

describe("监控规则", () => {
  it("价格规则命中/冷却/一次性删除", () => {
    removeRules({});
    const added = addRule({ code: "600519", kind: "price_above", value: 10, note: "突破", once: true });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const quotes = new Map([["600519", { code: "600519", price: 10.5, changePct: 1 } as never]]);
    const hit = evaluateRules(readRules(), quotes, new Map());
    expect(hit?.reason).toContain("600519");
    if (!hit) return;
    commitRuleHit(hit.rule);
    expect(readRules()).toHaveLength(0);
  });

  it("script 规则使用受限表达式", () => {
    removeRules({});
    const added = addRule({
      code: "600519",
      kind: "script",
      note: "均线多头且上涨",
      expression: "price > ma20 && pct > 2",
    });
    expect(added.ok).toBe(true);
    const quotes = new Map([["600519", { code: "600519", price: 11, changePct: 3 } as never]]);
    const indicators = new Map([["600519", { ma20: 10 } as never]]);
    expect(evaluateRules(readRules(), quotes, indicators)?.reason).toContain("脚本");
  });

  it("ma20_break 用指标判断", () => {
    removeRules({});
    addRule({ code: "300750", kind: "ma20_break", note: "破位" });
    const quotes = new Map([["300750", { code: "300750", price: 9, changePct: -2 } as never]]);
    const indicators = new Map([["300750", { ma20: 10 } as never]]);
    expect(evaluateRules(readRules(), quotes, indicators)?.reason).toContain("MA20");
  });

  it("15m 结构规则：跌破 15m MA20 / 前 10 根低点 / 突破前 10 根高点", () => {
    // 21 根 15m K 线：收盘 10、前 10 根低点 10.2、高点 10.5
    const bars = Array.from({ length: 21 }, (_, index) => ({
      time: `2026-11-19 10:${String(index).padStart(2, "0")}`,
      open: 10,
      high: 10.5,
      low: 10.2,
      close: 10,
      volume: 1000,
    }));
    const quote = (price: number) =>
      new Map([["600519", { code: "600519", price, changePct: -2 } as never]]);
    const bars15m = new Map([["600519", bars]]);

    removeRules({});
    addRule({ code: "600519", kind: "ma20_break_15m", note: "15m 破位" });
    expect(evaluateRules(readRules(), quote(9), new Map(), new Date(), bars15m)?.reason).toContain(
      "跌破 15m MA20",
    );
    // 站上 15m MA20 不命中「跌破」
    expect(evaluateRules(readRules(), quote(10.5), new Map(), new Date(), bars15m)).toBeNull();

    removeRules({});
    addRule({ code: "600519", kind: "low10_break_15m", note: "破前低" });
    expect(evaluateRules(readRules(), quote(10.1), new Map(), new Date(), bars15m)?.reason).toContain(
      "前 10 根 15m 低点",
    );

    removeRules({});
    addRule({ code: "600519", kind: "high10_above_15m", note: "突破" });
    expect(evaluateRules(readRules(), quote(10.6), new Map(), new Date(), bars15m)?.reason).toContain(
      "前 10 根 15m 高点",
    );
  });

  it("15m 规则缺 K 线时不命中（不做「取不到就当满足」的兜底）", () => {
    removeRules({});
    addRule({ code: "600519", kind: "ma20_break_15m", note: "15m 破位" });
    const quotes = new Map([["600519", { code: "600519", price: 9, changePct: -2 } as never]]);
    expect(evaluateRules(readRules(), quotes, new Map())).toBeNull();
  });

  it("chain 里含 15m 步骤时也要取 15m K 线", () => {
    expect(
      ruleNeedsBars15m({
        kind: "chain",
        steps: [{ kind: "pct_above", value: 2 }, { kind: "ma20_break_15m" }],
      }),
    ).toBe(true);
    expect(
      ruleNeedsBars15m({ kind: "chain", steps: [{ kind: "pct_above", value: 2 }, { kind: "ma20_break" }] }),
    ).toBe(false);
  });

  it("链式规则：先涨幅达标，再跌破 MA20 才唤醒", () => {
    removeRules({});
    addRule({
      code: "600519",
      kind: "chain",
      note: "冲高回落",
      steps: [
        { kind: "pct_above", value: 2 },
        { kind: "ma20_break" },
      ],
    });
    const first = evaluateRules(
      readRules(),
      new Map([["600519", { code: "600519", price: 11, changePct: 3 } as never]]),
      new Map([["600519", { ma20: 10 } as never]]),
    );
    expect(first).toBeNull();
    expect(readRules()[0].step).toBe(1);
    const second = evaluateRules(
      readRules(),
      new Map([["600519", { code: "600519", price: 9, changePct: -2 } as never]]),
      new Map([["600519", { ma20: 10 } as never]]),
    );
    expect(second?.reason).toContain("链式触发");
  });

  it("formula 规则只允许白名单变量", () => {
    removeRules({});
    const added = addRule({
      code: "600519",
      kind: "formula",
      note: "站上均线且上涨",
      expression: "price > ma20 && pct > 2",
    });
    expect(added.ok).toBe(true);
    const quotes = new Map([["600519", { code: "600519", price: 11, changePct: 3 } as never]]);
    const indicators = new Map([["600519", { ma20: 10 } as never]]);
    expect(evaluateRules(readRules(), quotes, indicators)?.reason).toContain("公式");
    removeRules({});
    expect(
      addRule({ code: "600519", kind: "formula", note: "x", expression: "process.exit(1)" }).ok,
    ).toBe(false);
  });

  it("ret20_above 用 20 日涨幅判断", () => {
    removeRules({});
    addRule({ code: "600519", kind: "ret20_above", value: 10, note: "动量" });
    const quotes = new Map([["600519", { code: "600519", price: 11, changePct: 1 } as never]]);
    const indicators = new Map([["600519", { ret20: 12 } as never]]);
    expect(evaluateRules(readRules(), quotes, indicators)?.reason).toContain("20 日涨幅");
  });
});

describe("暂停标记", () => {
  it("写入后可读，恢复后为 false", () => {
    setPaused(true, "test");
    expect(isPaused()).toBe(true);
    expect(readPause().by).toBe("test");
    setPaused(false, "test");
    expect(isPaused()).toBe(false);
  });
});

function removeAll(): void {
  const file = path.join(home, "monitor", "run", "schedules.json");
  fs.rmSync(file, { force: true });
}

describe("市场事件", () => {
  it("每天每个时点只触发一次，晚到只取最近一个", () => {
    const file = path.join(home, "monitor", "run", "events.json");
    fs.rmSync(file, { force: true });
    const open = takeMarketEvent(new Date("2026-11-10T09:30:00+08:00"));
    expect(open?.id).toBe("open");
    expect(takeMarketEvent(new Date("2026-11-10T09:31:00+08:00"))).toBeNull();
    const close = takeMarketEvent(new Date("2026-11-10T15:26:00+08:00"));
    expect(close?.id).toBe("close");
  });

  it("空仓不触发定时事件，但事件不被消费（开仓后仍能触发）", () => {
    const file = path.join(home, "monitor", "run", "events.json");
    fs.rmSync(file, { force: true });
    const at = new Date("2026-11-10T09:30:00+08:00");
    // 空仓 + 无挂单：不叫醒（对齐 btc checkEvents(hasExposure)）
    expect(takeMarketEvent(at, { hasExposure: false })).toBeNull();
    // 没有写 handled：随后有仓位时同一个事件仍会触发
    expect(takeMarketEvent(at, { hasExposure: true })?.id).toBe("open");
  });
});

describe("硬风控作用域", () => {
  it("单票亏损只锁该股票，不触发账户级；解除后恢复", () => {
    const account = {
      cash: 500000,
      positions: [
        {
          code: "600519",
          name: "贵州茅台",
          qty: 100,
          available: 100,
          avgCost: 10,
          lastPrice: 9,
          marketValue: 900,
          pnl: -100,
          pnlPct: -10,
        },
      ],
      trades: [],
    } as never;
    const quotes = new Map([["600519", { code: "600519", price: 9, changePct: -2 } as never]]);
    const result = checkAccountRisk(account, quotes, new Date("2026-11-10T10:00:00+08:00"));
    expect(result.triggered).toBe(false);
    expect(result.locks.map((lock) => lock.code)).toEqual(["600519"]);
    expect(readRiskState()?.triggered).toBe(false);
    expect(readRiskState()?.locks).toHaveLength(1);

    clearRiskTrigger("600519");
    expect(readRiskState()?.locks).toHaveLength(0);
  });
});

describe("巡检过程流", () => {
  it("按字节偏移增量读取", () => {
    const start = currentAInspectOffset();
    appendAInspectEvent("text", "结论一");
    appendAInspectEvent("error", "错误一");
    const first = readAInspectEvents(start);
    expect(first.events.map((event) => event.text)).toEqual(["结论一", "错误一"]);
    const second = readAInspectEvents(first.offset);
    expect(second.events).toHaveLength(0);
    appendAInspectEvent("text", "结论二");
    expect(readAInspectEvents(second.offset).events[0].text).toBe("结论二");
  });
});

describe("挂单状态机", () => {
  it("价格穿越成交、到期过期、可撤销", () => {
    const file = path.join(home, "monitor", "run", "pending-orders.json");
    fs.rmSync(file, { force: true });
    const buy = createOrder({ code: "600519", name: "贵州茅台", side: "buy", qty: 100, limitPrice: 10 });
    expect(buy.ok).toBe(true);
    if (!buy.ok) return;
    // 测试在收盘后运行：把有效期改成未来，避免立即过期
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { orders: Array<{ id: string; expiresAt: string }> };
    for (const order of raw.orders) {
      if (order.id === buy.order.id) order.expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    }
    fs.writeFileSync(file, JSON.stringify(raw));
    // 撮合闸门由调用方按连续竞价算好传入；这里显式放行，避免用例受运行时刻影响
    const fill = matchOrders(
      new Map([["600519", { code: "600519", price: 9 } as never]]),
      new Date(),
      { sessionOpen: true },
    );
    expect(fill.fills.map((order) => order.id)).toContain(buy.order.id);
    expect(listOrders().find((order) => order.id === buy.order.id)?.status).toBe("filled");

    const sell = createOrder({ code: "300750", name: "宁德时代", side: "sell", qty: 100, limitPrice: 20, ttlMinutes: 1 });
    expect(sell.ok).toBe(true);
    if (!sell.ok) return;
    const expired = matchOrders(new Map(), new Date(Date.now() + 2 * 60_000), {
      sessionOpen: true,
    });
    expect(expired.expired.map((order) => order.id)).toContain(sell.order.id);

    const cancel = createOrder({ code: "000001", name: "平安银行", side: "buy", qty: 100, limitPrice: 10 });
    if (cancel.ok) {
      expect(cancelOrder(cancel.order.id).ok).toBe(true);
      expect(listOrders().find((order) => order.id === cancel.order.id)?.status).toBe("cancelled");
    }
  });

  it("集合竞价 / 午休 / 节假日不撮合，只保留挂单", () => {
    const file = path.join(home, "monitor", "run", "pending-orders.json");
    fs.rmSync(file, { force: true });
    const order = createOrder({
      code: "600519",
      name: "贵州茅台",
      side: "buy",
      qty: 100,
      limitPrice: 12,
    });
    expect(order.ok).toBe(true);
    if (!order.ok) return;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      orders: Array<{ id: string; expiresAt: string }>;
    };
    for (const item of raw.orders) {
      if (item.id === order.order.id) item.expiresAt = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
    }
    fs.writeFileSync(file, JSON.stringify(raw));

    // 价格已经穿越，但不在连续竞价时段（09:20 集合竞价 / 12:00 午休）
    const quotes = new Map([["600519", { code: "600519", price: 10 } as never]]);
    const auction = matchOrders(quotes, new Date("2026-11-09T09:20:00+08:00"), { sessionOpen: false });
    expect(auction.sessionOpen).toBe(false);
    expect(auction.fills).toHaveLength(0);
    const lunch = matchOrders(quotes, new Date("2026-11-09T12:00:00+08:00"), { sessionOpen: false });
    expect(lunch.fills).toHaveLength(0);
    expect(listOrders().find((item) => item.id === order.order.id)?.status).toBe("open");

    // 进入连续竞价才成交
    const open = matchOrders(quotes, new Date("2026-11-09T10:00:00+08:00"), { sessionOpen: true });
    expect(open.sessionOpen).toBe(true);
    expect(open.fills.map((item) => item.id)).toContain(order.order.id);
    expect(listOrders().find((item) => item.id === order.order.id)?.status).toBe("filled");
  });
});

describe("收盘后固定选股", () => {
  it("工作日 16:00 后每天一次，周末与已选过不跑", () => {
    const wed = new Date("2026-11-11T16:00:00+08:00");
    expect(shouldRunAfterCloseSelection(wed)).toBe(true);
    expect(shouldRunAfterCloseSelection(new Date("2026-11-11T15:59:00+08:00"))).toBe(false);
    expect(shouldRunAfterCloseSelection(new Date("2026-11-14T16:00:00+08:00"))).toBe(false);
    expect(shouldRunAfterCloseSelection(wed, "2026-11-11")).toBe(false);
    expect(
      shouldRunAfterCloseSelection(wed, undefined, "2026-11-11T15:50:00+08:00"),
    ).toBe(false);
  });

  it("选股推送带名称/分数/理由与换入换出，而不是只给一串代码", () => {
    const item = (code: string, name: string, score: number, reason: string) => ({
      code,
      name,
      score,
      reason,
      source: "select" as const,
      addedAt: "2026-11-16T08:00:00.000Z",
    });
    const before = [item("300006", "莱美药业", 55, "趋势 -1")];
    const text = describeSelection(
      [
        item("601857", "中国石油", 86, "趋势 月/周/日 全 +1 · 15m 80 分 now"),
        item("600901", "国泰君安", 74, "趋势 月 +1 · 15m 66 分 wait"),
      ],
      before,
    );
    expect(text).toContain("收盘选股 2 只");
    expect(text).toContain("1. 中国石油 601857 · 86 分");
    expect(text).toContain("新进：中国石油 601857、国泰君安 600901");
    expect(text).toContain("移出：莱美药业 300006");

    // 持仓也走同一套打分（收盘选股时重算）：有分数就照实写，并标「持仓保留」
    const rescoredHeld = describeSelection(
      [
        {
          code: "601857",
          name: "中国石油",
          score: 72,
          reason: "趋势 月+1/周+1/日+1 · 15m 72 分 wait",
          source: "held",
          addedAt: "2026-11-17T08:00:00.000Z",
        },
      ],
      [],
    );
    expect(rescoredHeld).toContain("1. 中国石油 601857 · 72 分 · 趋势 月+1/周+1/日+1 · 15m 72 分 wait");
    expect(rescoredHeld).toContain("15m 72 分 wait · 持仓保留");

    // 持仓是「强制保留」带进来的（score 0）：不能显示「0 分」，也不能被分项明细的括号刷屏
    const held = describeSelection(
      [item("601857", "中国石油", 0, "已持仓，强制保留"), item("002807", "江阴银行", 100, "趋势 M1 W1 D1 · 15m 100（结构30/位置20/动量20）")],
      [],
    );
    expect(held).toContain("1. 中国石油 601857 · 已持仓，强制保留");
    expect(held).not.toMatch(/· 0 分/);
    expect(held).toContain("2. 江阴银行 002807 · 100 分 · 趋势 M1 W1 D1 · 15m 100");
    expect(held).not.toContain("结构30");
  });
});

describe("本地时间展示", () => {
  it("ISO UTC 转成本机时区，而不是直接截字符串", () => {
    const date = new Date(2026, 0, 2, 3, 4, 0);
    expect(formatLocalTime(date.toISOString(), "time")).toBe("03:04");
    expect(formatLocalTime(date.toISOString(), "monthday")).toBe("01-02 03:04");
    expect(formatLocalTime("bad", "time")).toBe("—");
  });
});

describe("规则写入审计", () => {
  it("记录写入/拒绝，可按时间读取", () => {
    appendRuleAudit({ actor: "inspect", action: "add", ok: true, code: "600519", kind: "script", detail: "price > ma20" });
    appendRuleAudit({ actor: "manual", action: "reject", ok: false, code: "999999", error: "不在持仓/自选股范围" });
    const audits = readRuleAudits(2);
    expect(audits).toHaveLength(2);
    expect(audits[0].action).toBe("add");
    expect(audits[1].error).toContain("范围");
  });
});

describe("A 股 /info 巡检区块", () => {
  it("优先显示下一轮时间、倒计时与原因，而不是只有 pid", () => {
    removeSchedules();
    const stateFile = path.join(home, "monitor", "run", "monitor.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: "test",
        nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        watchlist: 0,
        holdings: 0,
        rules: 0,
        queueSize: 1,
      }),
    );
    pushSchedule({ minutes: 60, reason: "确认 MA20 是否收复" });

    const lines = aInfoLines({
      updatedAt: Date.now(),
      indices: [],
      account: emptyPaperAccount(),
      watch: [],
      lastActions: [],
      riskLocks: [],
    });
    const text = lines.join("\n");
    expect(text).toContain("分钟后");
    expect(text).toContain("确认 MA20 是否收复");
    expect(text).toContain("进程运行中");
  });
});

describe("A 股 /info 成交", () => {
  it("只展示今天的成交，旧成交交给 /tr", () => {
    const account = emptyPaperAccount();
    account.trades = [
      {
        id: "old",
        code: "600519",
        name: "贵州茅台",
        side: "buy",
        qty: 100,
        price: 10,
        amount: 1_000,
        fees: 5,
        time: new Date(Date.now() - 36 * 3600_000).toISOString(),
      },
      {
        id: "new",
        code: "601857",
        name: "中国石油",
        side: "buy",
        qty: 100,
        price: 12,
        amount: 1_200,
        fees: 5,
        time: new Date().toISOString(),
      },
    ];
    const lines = aInfoLines({
      updatedAt: Date.now(),
      indices: [],
      account,
      watch: [],
      lastActions: [],
      riskLocks: [],
    });
    const text = lines.join("\n");
    expect(text).toContain("今日成交（完整记录用 /tr）");
    expect(text).toContain("买 601857");
    // 旧成交不应出现在「今日成交」里（600519 可能出现在别处的监控规则中）
    expect(text).not.toContain("买 600519");
  });
});

describe("持仓风控告警", () => {
  it("只落盘不交易；已送达的同一批不重复唤醒，内容变化重新置为未送达", () => {
    writePositionRisks([
      { code: "600519", name: "贵州茅台", reason: "止损 -8%", sellable: true, qty: 100, at: "t" },
    ]);
    let state = readPositionRisks();
    expect(state.alerts).toHaveLength(1);
    expect(state.delivered).toBe(false);
    markPositionRisksDelivered();
    expect(readPositionRisks().delivered).toBe(true);
    writePositionRisks([
      { code: "600519", name: "贵州茅台", reason: "止损 -8%", sellable: true, qty: 100, at: "t" },
    ]);
    expect(readPositionRisks().delivered).toBe(true);
    writePositionRisks([
      { code: "300750", name: "宁德时代", reason: "移动止盈", sellable: true, qty: 100, at: "t" },
    ]);
    expect(readPositionRisks().delivered).toBe(false);
  });
});

describe("清仓检测（持仓基线）", () => {
  it("消失的代码算清仓；首次运行不误报；基线可落盘读回", async () => {
    const { closedSince, readBaseline, sameCodes, writeBaseline } = await import(
      "../src/utils/position-baseline"
    );
    // 首次：没有基线 → 什么都不算（否则每次重启都会误跑一轮复盘）
    expect(closedSince(null, ["600519", "601857"])).toEqual([]);

    const dir = path.join(home, "a");
    writeBaseline(dir, ["600519", "601857"], new Date("2026-11-18T01:00:00Z"));
    const baseline = readBaseline(dir);
    expect(baseline?.codes).toEqual(["600519", "601857"]);
    expect(sameCodes(baseline!.codes, ["601857", "600519"])).toBe(true);

    // 601857 卖了（持仓归零）→ 只有它算清仓；600519 还在，不算
    expect(closedSince(baseline, ["600519"])).toEqual(["601857"]);
    // 换仓：老代码消失、新代码出现 → 只报消失的那个
    expect(closedSince(baseline, ["000001"])).toEqual(["600519", "601857"]);
  });

  it("清仓复盘的叫醒说明点名策略工具，并要求记录", async () => {
    const { liquidationNote } = await import("../src/utils/position-baseline");
    const note = liquidationNote(["601857"], "a_policy");
    expect(note).toContain("清仓复盘：601857");
    expect(note).toContain("`a_policy`");
    expect(note).toContain("【清仓复盘】");
  });
});

describe("A 股缓存（SQLite + 裁剪）", () => {
  it("读写在库里往返；stat 有大小；delete 后读不到", async () => {
    const cache = await import("../src/exchange/ashare/cache");
    cache.resetCacheConnection();
    const rows = [
      { code: "600519", close: 1500 },
      { code: "601857", close: 9 },
    ];
    cache.writeCache("test-cache.json", rows);
    const read = cache.readCache<typeof rows>("test-cache.json", 60_000);
    expect(read?.value).toEqual(rows);
    expect(read?.complete).toBe(true);

    const stat = cache.statCache("test-cache.json");
    expect(stat.exists).toBe(true);
    expect(stat.bytes).toBeGreaterThan(0);

    cache.deleteCache("test-cache.json");
    expect(cache.readCache("test-cache.json", 60_000)).toBeNull();
  });

  it("按代码裁剪：只留自选池，并标记 complete=false（全市场筛选会重算）", async () => {
    const cache = await import("../src/exchange/ashare/cache");
    cache.resetCacheConnection();
    const rows = [
      { code: "600519", close: 1500 },
      { code: "601857", close: 9 },
      { code: "000001", close: 11 },
    ];
    cache.writeCache("prune.json", rows);
    const removed = cache.pruneCacheCodes("prune.json", ["601857", "000001"]);
    expect(removed).toBe(1);
    const after = cache.readCache<typeof rows>("prune.json", 60_000);
    expect(after?.value.map((row) => row.code)).toEqual(["601857", "000001"]);
    expect(after?.complete).toBe(false);
  });

  it("旧版 cache/*.json 会在首次打开时迁移进库并删除文件", async () => {
    const cache = await import("../src/exchange/ashare/cache");
    cache.resetCacheConnection();
    const dir = cache.ashareCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const legacy = path.join(dir, "legacy.json");
    fs.writeFileSync(
      legacy,
      JSON.stringify({ updatedAt: new Date().toISOString(), value: { days: ["2026-11-18"] } }),
      "utf8",
    );
    // 重新打开连接触发迁移
    cache.resetCacheConnection();
    expect(cache.readCache<{ days: string[] }>("legacy.json", 60_000)?.value.days).toEqual([
      "2026-11-18",
    ]);
    expect(fs.existsSync(legacy)).toBe(false);
  });
});

describe("巡检前置数据核对", () => {
  it("数据齐备时给出结论；缺失/过期时要求先补数据再下单", async () => {
    const { formatPreflight } = await import("../src/a/inspect");
    const good = formatPreflight(
      [
        {
          code: "600519",
          name: "贵州茅台",
          held: true,
          price: 1500,
          changePct: 1.2,
          quoteTime: "2026-11-18 14:03:11",
          barTime: "2026-11-18 14:00",
          deepScore: 72,
          indicatorAsOf: "2026-11-17",
          problems: [],
        },
      ],
      { indexLine: "上证指数 4021.33（+0.31%）· 时间 2026-11-18 14:03:11", notes: ["当前没有挂单"] },
    );
    expect(good).toContain("巡检前数据核对");
    expect(good).toContain("600519 贵州茅台（持仓） 现价 1500.00（+1.20%）");
    expect(good).toContain("15m 72 分");
    expect(good).toContain("数据检查结论：池内数据齐备");

    const bad = formatPreflight([
      {
        code: "601857",
        name: "中国石油",
        held: false,
        problems: ["行情取不到", "15m K 线取不到", "日线指标缺失"],
      },
    ]);
    expect(bad).toContain("数据有问题，先补数据再决策");
    expect(bad).toContain("601857 中国石油：行情取不到；15m K 线取不到；日线指标缺失");
    expect(bad).toContain("不要下单");
  });
});

describe("监控规则表达力（结构 / 组合 / 链式）", () => {
  it("公式能直接用 rsi / adx / macd / ma50（以前只能写价格）", () => {
    expect(validateFormula("rsi < 40")).toBe(true);
    expect(validateFormula("foo < 40")).toBe(false);
    expect(evaluateFormula("price < ma20 && rsi < 40", { price: 10, ma20: 11, rsi: 35 })).toBe(
      true,
    );
    expect(evaluateFormula("macd > 0 && adx > 20", { macd: 0.5, adx: 25 })).toBe(true);
    expect(evaluateFormula("ma50 > ma20", { ma50: 12, ma20: 11 })).toBe(true);
    // 缺值不误判
    expect(evaluateFormula("rsi < 40", {})).toBeNull();
  });

  it("公式规则能命中；链式规则显示每一步在等什么", () => {
    const now = new Date("2026-11-18T10:00:00+08:00");
    const rule: MonitorRule = {
      id: "r1",
      code: "600901",
      kind: "formula",
      expression: "price < ma20 && rsi < 40",
      note: "跌破 MA20 且 RSI 转弱",
      once: false,
      cooldownMin: 30,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    const quote = { code: "600901", name: "江苏金租", price: 7.4, changePct: -2 } as never;
    const indicators = new Map([["600901", { code: "600901", asOf: "2026-11-17", close: 7.5, ma20: 7.6, rsi14: 35 }]]) as never;
    const hit = evaluateRules([rule], new Map([["600901", quote]]), indicators, now);
    expect(hit?.rule.id).toBe("r1");
    expect(hit?.reason).toContain("RSI 转弱");

    const chain: MonitorRule = {
      id: "r2",
      code: "601939",
      kind: "chain",
      steps: [
        { kind: "price_above", value: 12.45 },
        { kind: "price_below", value: 12.2 },
      ],
      step: 0,
      note: "先站上再回踩",
      once: false,
      cooldownMin: 30,
      createdAt: now.toISOString(),
    };
    expect(describeRule(chain)).toBe("601939 链式 0/2：价格 ≥ 12.45 → 价格 ≤ 12.2");
  });
});

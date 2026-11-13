import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clampToWorkTime, pushSchedule, readScheduleQueue, takeDueSchedule } from "../src/a/schedule";
import { addRule, commitRuleHit, evaluateRules, readRules, removeRules } from "../src/a/rules";
import { isPaused, readPause, setPaused } from "../src/a/pause";
import { takeMarketEvent } from "../src/a/events";
import { appendRuleAudit, readRuleAudits } from "../src/a/rule-audit";
import { markPositionRisksDelivered, readPositionRisks, writePositionRisks } from "../src/a/risk-alerts";
import { shouldRunAfterCloseSelection } from "../src/a/monitor";
import { formatLocalTime } from "../src/utils/time";
import { checkAccountRisk, clearRiskTrigger, readRiskState } from "../src/a/risk";
import { appendAInspectEvent, currentAInspectOffset, readAInspectEvents } from "../src/a/inspect-stream";
import { cancelOrder, createOrder, listOrders, matchOrders } from "../src/a/orders";

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
  it("越界时间夹到工作日 09:00–15:30", () => {
    const saturday = clampToWorkTime(new Date("2026-11-07T10:00:00"), new Date("2026-11-06T10:00:00"));
    expect(saturday.at.getDay()).toBe(1); // 周一
    expect(saturday.at.getHours()).toBe(9);
    const late = clampToWorkTime(new Date("2026-11-10T16:00:00"), new Date("2026-11-10T10:00:00"));
    expect(late.at.getDate()).toBe(11);
    expect(late.at.getHours()).toBe(9);
  });

  it("next 唯一、extra 同分钟去重、到期即出队", () => {
    removeAll();
    const target = new Date();
    // 取「下一个工作日」：明天若是周末， clampToWorkTime 会把它推到周一 09:00，
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
    const auction = matchOrders(quotes, new Date("2026-11-09T09:20:00+08:00"));
    expect(auction.sessionOpen).toBe(false);
    expect(auction.fills).toHaveLength(0);
    const lunch = matchOrders(quotes, new Date("2026-11-09T12:00:00+08:00"));
    expect(lunch.fills).toHaveLength(0);
    expect(listOrders().find((item) => item.id === order.order.id)?.status).toBe("open");

    // 进入连续竞价才成交
    const open = matchOrders(quotes, new Date("2026-11-09T10:00:00+08:00"));
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

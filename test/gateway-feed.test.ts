import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendInspectEvent } from "../src/btc/inspect-stream";
import {
  formatBtcBatch,
  pickBtcImportant,
  readFeedOffsets,
  runFeedTick,
} from "../src/gateway/feed";

/**
 * gateway → 微信的巡检内容转发。
 *
 * 关键不变量：① 只推结论 / 错误，思考与工具过程不推；② 首次接入从文件末尾开始
 * （不回放历史）；③ 发送失败不推进偏移（不丢内容）。
 */

describe("btc 事件筛选", () => {
  it("只保留结论 / 提示 / 错误，思考与工具过程不推", () => {
    const kept = pickBtcImportant([
      { ts: "t", round: "r", kind: "reasoning", text: "思考过程" },
      { ts: "t", round: "r", kind: "tool", text: "调工具" },
      { ts: "t", round: "r", kind: "text", text: "结论：观望" },
      { ts: "t", round: "r", kind: "error", text: "行情失败" },
      { ts: "t", round: "r", kind: "notice", text: "已暂停" },
    ]);
    expect(kept.map((event) => event.kind)).toEqual(["text", "error", "notice"]);
  });

  it("批量格式化：超过 4 条折叠为条数说明", () => {
    const events = Array.from({ length: 7 }, (_, index) => ({
      ts: "t",
      round: "r",
      kind: "text" as const,
      text: `结论${index}`,
    }));
    const message = formatBtcBatch("BTC 实盘巡检", events)!;
    expect(message).toContain("[BTC 实盘巡检]");
    expect(message).toContain("结论6");
    expect(message).toContain("…（本轮还有 3 条）");
  });

  it("单条推送压进一个微信气泡（≤900 字）", () => {
    const events = Array.from({ length: 4 }, () => ({
      ts: "t",
      round: "r",
      kind: "text" as const,
      text: "长".repeat(1000),
    }));
    const message = formatBtcBatch("BTC 实盘巡检", events)!;
    expect(message.length).toBeLessThanOrEqual(900);
  });
});

describe("转发循环", () => {
  let root: string;
  let btcHome: string;
  let aHome: string;
  let offsetsFile: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-feed-"));
    btcHome = path.join(root, "btc");
    aHome = path.join(root, "a");
    fs.mkdirSync(btcHome, { recursive: true });
    fs.mkdirSync(aHome, { recursive: true });
    for (const key of ["XZH_BTC_HOME", "XZH_A_HOME"]) {
      saved[key] = process.env[key];
      process.env[key] = key === "XZH_BTC_HOME" ? btcHome : aHome;
    }
    offsetsFile = path.join(root, "feed-offsets.json");
  });

  afterAll(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(offsetsFile, { force: true });
  });

  const appendBtc = (kind: "reasoning" | "text" | "error", text: string): void => {
    appendInspectEvent({ round: "r1", kind, text }, btcHome);
  };

  it("首次接入只初始化偏移，不回放历史", async () => {
    appendBtc("text", "历史结论");
    const sent: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent.push(text), true) });
    expect(sent).toEqual([]);
    expect(readFeedOffsets(offsetsFile).btc).toBeGreaterThan(0);
  });

  it("新增结论 / 错误会推给微信，思考不推；发完推进偏移", async () => {
    appendBtc("text", "历史结论");
    await runFeedTick({ offsetsFile, send: async () => true });

    appendBtc("reasoning", "思考过程");
    appendBtc("text", "结论：RSI 超买，减仓");
    appendBtc("error", "下单被拒：余额不足");
    const sent: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent.push(text), true) });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("[BTC 实盘巡检]");
    expect(sent[0]).toContain("结论：RSI 超买，减仓");
    expect(sent[0]).toContain("下单被拒：余额不足");
    expect(sent[0]).not.toContain("思考过程");

    const sent2: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent2.push(text), true) });
    expect(sent2).toEqual([]);
  });

  it("发送失败时不推进偏移，下轮重试", async () => {
    appendBtc("text", "结论 A");
    await runFeedTick({ offsetsFile, send: async () => true });

    appendBtc("text", "结论 B");
    const before = readFeedOffsets(offsetsFile).btc;
    const sent: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent.push(text), false) });
    expect(sent).toHaveLength(1);
    expect(readFeedOffsets(offsetsFile).btc).toBe(before);

    const sent2: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent2.push(text), true) });
    expect(sent2).toHaveLength(1);
    expect(sent2[0]).toContain("结论 B");
  });

  it("A 股动作账本：选股 / 买卖推给微信，失败动作也推", async () => {
    const actionsFile = path.join(aHome, "monitor", "actions.jsonl");
    fs.mkdirSync(path.dirname(actionsFile), { recursive: true });
    const entry = (entry: Record<string, unknown>): void => {
      fs.appendFileSync(actionsFile, `${JSON.stringify(entry)}\n`, "utf8");
    };
    // 首次：初始化偏移到当前末尾
    entry({ kind: "select", codes: ["600519", "300750"] });
    await runFeedTick({ offsetsFile, send: async () => true });
    const sent0: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent0.push(text), true) });
    expect(sent0).toEqual([]);

    entry({ kind: "select", codes: ["600519", "300750", "000001"] });
    entry({ kind: "buy", code: "600519", ok: true, message: "买入 贵州茅台 100 股 @ 10.00" });
    entry({ kind: "sell", code: "600519", ok: false, message: "可卖不足：T+1 可卖 0 股" });
    const sent: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent.push(text), true) });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("[A 股巡检]");
    expect(sent[0]).toContain("选股 3 只：600519、300750、000001");
    expect(sent[0]).toContain("买入 贵州茅台 100 股 @ 10.00");
    expect(sent[0]).toContain("卖出失败：可卖不足：T+1 可卖 0 股");
  });
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendInspectEvent } from "../src/btc/inspect-stream";
import {
  composeRoundText,
  formatRoundPush,
  groupInspectRounds,
  isRoundFinished,
  pickBtcImportant,
  readFeedOffsets,
  runFeedTick,
  type RoundBlock,
} from "../src/gateway/feed";

/**
 * gateway → 微信的巡检内容转发。
 *
 * 关键不变量：① 只推结论 / 错误，思考与工具过程不推；② 首次接入从文件末尾开始
 * （不回放历史）；③ 发送失败不推进偏移（不丢内容）；
 * ④ **按轮聚合**：一轮只推一次，且等 round-end 之后才推。
 */

describe("btc 事件筛选与按轮聚合", () => {
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

  it("同一轮的流式增量拼成一段正文，不同轮分开", () => {
    const blocks = groupInspectRounds([
      { event: { ts: "t1", round: "r1", kind: "text", text: "结论：观望" }, end: 10 },
      { event: { ts: "t2", round: "r1", kind: "text", text: "，不新开仓。" }, end: 20 },
      { event: { ts: "t3", round: "r1", kind: "round-end", text: "结论：观望，不新开仓。" }, end: 30 },
      { event: { ts: "t4", round: "r2", kind: "text", text: "第二轮" }, end: 40 },
    ]);
    expect(blocks.map((block) => block.round)).toEqual(["r1", "r2"]);
    expect(blocks[0].end).toBe(30);
    expect(composeRoundText(blocks[0].events)).toBe("结论：观望，不新开仓。");
  });

  it("未结束的轮次不推；一轮只推一条，序号按轮次而不是按批", () => {
    const running: RoundBlock = {
      round: "2026-11-14T12:03:44.397Z",
      events: [{ ts: new Date().toISOString(), round: "2026-11-14T12:03:44.397Z", kind: "text", text: "本轮巡检完成" }],
      end: 100,
    };
    expect(isRoundFinished(running, undefined)).toBe(false);

    const finished: RoundBlock = {
      round: "2026-11-14T12:03:44.397Z",
      events: [
        ...running.events,
        { ts: "t", round: "2026-11-14T12:03:44.397Z", kind: "text", text: "，结论：观望。" },
        { ts: "t", round: "2026-11-14T12:03:44.397Z", kind: "round-end", text: "结论：观望。" },
      ],
      end: 200,
    };
    expect(isRoundFinished(finished, undefined)).toBe(true);

    const messages = formatRoundPush("BTC 模拟盘巡检", finished, Date.parse("2026-11-14T12:10:00Z"));
    expect(messages).toHaveLength(1);
    // 标题带轮次开始时间，不再出现「1/2、2/2」这种按批编号
    expect(messages[0]).toMatch(/^\[BTC 模拟盘巡检 \d{2}:\d{2}\]\n/);
    expect(messages[0]).toContain("本轮巡检完成，结论：观望。");
    expect(messages[0]).not.toContain("1/2");
  });

  it("正文超长才分片，且分片序号属于同一轮", () => {
    const round = "2026-11-14T12:03:44.397Z";
    const long = Array.from({ length: 3 }, () => ({
      ts: "t",
      round,
      kind: "text" as const,
      text: "结论".repeat(300),
    }));
    const messages = formatRoundPush("BTC 实盘巡检", { round, events: long, end: 9 });
    expect(messages.length).toBeGreaterThan(1);
    expect(messages[0]).toContain("· 1/");
    expect(messages[0]).toMatch(/\[BTC 实盘巡检 \d{2}:\d{2} · 1\/\d\]/);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(900);
    }
  });

  it("单轮正文按 900 字切分时优先在标点处断开", () => {
    const body = `${"甲".repeat(700)}。${"乙".repeat(400)}。${"丙".repeat(400)}`;
    const chunks = formatRoundPush(
      "BTC 实盘巡检",
      { round: "r", events: [{ ts: "t", round: "r", kind: "text", text: body }], end: 1 },
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].endsWith("。")).toBe(true);
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

  const appendBtc = (
    kind: "reasoning" | "text" | "error" | "round-end",
    text: string,
    round = "r1",
  ): void => {
    appendInspectEvent({ round, kind, text }, btcHome);
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

  it("同一轮未结束不推，结束后整轮只推一次", async () => {
    await runFeedTick({ offsetsFile, send: async () => true });
    const before = readFeedOffsets(offsetsFile).btc;

    // 模型正在分段输出：读到一半就推会变成好几条「巡检」，而且各自重新编号
    appendBtc("text", "本轮巡检完成，结论：");
    const pending: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (pending.push(text), true) });
    expect(pending).toEqual([]);
    expect(readFeedOffsets(offsetsFile).btc).toBe(before);

    appendBtc("text", "观望，不新开仓。");
    await runFeedTick({ offsetsFile, send: async () => true });
    expect(readFeedOffsets(offsetsFile).btc).toBe(before);

    appendBtc("round-end", "观望，不新开仓。");
    const sent: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent.push(text), true) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("本轮巡检完成，结论：观望，不新开仓。");
    expect(sent[0]).not.toContain("1/2");

    const again: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (again.push(text), true) });
    expect(again).toEqual([]);
  });

  it("下一轮开始也视为上一轮结束（后端没写 round-end 时）", async () => {
    await runFeedTick({ offsetsFile, send: async () => true });

    appendBtc("text", "第一轮结论", "r1");
    appendBtc("text", "第二轮结论", "r2");
    const sent: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent.push(text), true) });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("第一轮结论");
    expect(sent[0]).not.toContain("第二轮结论");

    appendBtc("round-end", "第二轮结论", "r2");
    const sent2: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent2.push(text), true) });
    expect(sent2).toHaveLength(1);
    expect(sent2[0]).toContain("第二轮结论");
  });

  it("发送失败时不推进偏移，下轮重试", async () => {
    appendBtc("text", "结论 A");
    appendBtc("round-end", "结论 A");
    await runFeedTick({ offsetsFile, send: async () => true });

    appendBtc("text", "结论 B", "r2");
    appendBtc("round-end", "结论 B", "r2");
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

  it("一轮拆成多条气泡时，重试只补发没送达的那条", async () => {
    await runFeedTick({ offsetsFile, send: async () => true });

    // 正文约 1200 字 → 2 条气泡
    appendBtc("text", `${"甲".repeat(400)}。${"乙".repeat(400)}。${"丙".repeat(400)}`);
    appendBtc("round-end", "长结论");

    const sent: string[] = [];
    let count = 0;
    await runFeedTick({
      offsetsFile,
      // 第 1 条成功、第 2 条失败
      send: async (text) => (sent.push(text), count++, count === 1),
    });
    expect(sent).toHaveLength(2);
    expect(readFeedOffsets(offsetsFile)["btc-batch"]).toBe(1);

    const sent2: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent2.push(text), true) });
    // 只补发第 2 条：第 1 条不会再发一遍
    expect(sent2).toHaveLength(1);
    expect(sent2[0]).toContain("丙");
    expect(sent2[0]).not.toContain("甲");
    expect(readFeedOffsets(offsetsFile)["btc-batch"]).toBe(0);

    const sent3: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent3.push(text), true) });
    expect(sent3).toEqual([]);
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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendInspectEvent } from "../src/btc/inspect-stream";
import { appendAInspectEvent } from "../src/a/inspect-stream";
import {
  composeAStreamText,
  composeRoundText,
  formatRoundPush,
  formatStreamPush,
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

  it("一轮只发一条气泡：超长时省略中间，但保留结尾结论", () => {
    const round = "2026-11-14T12:03:44.397Z";
    // 2026-11-24 起 iLink 主动推送额度极小：一轮 = 一次 sendmessage，
    // 不再有 `· 1/2`、`· 2/2` 这种分片
    const long = [
      { ts: "t", round, kind: "text" as const, text: `开头：${"甲".repeat(1_500)}` },
      { ts: "t", round, kind: "text" as const, text: `结尾：${"乙".repeat(1_000)}结论：观望` },
    ];
    // 传固定的 now：轮次时间标签跨天会补 MM-DD，用例不能随运行日期变化
    const messages = formatRoundPush(
      "BTC 实盘巡检",
      { round, events: long, end: 9 },
      Date.parse("2026-11-14T12:10:00Z"),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^\[BTC 实盘巡检 \d{2}:\d{2}\]\n/);
    expect(messages[0]).not.toContain("1/2");
    expect(messages[0].length).toBeLessThanOrEqual(2_000);
    expect(messages[0]).toContain("开头：");
    // 结论在末尾，必须保留；中间省略要说明出处
    expect(messages[0]).toContain("结论：观望");
    expect(messages[0]).toContain("中间省略");
    expect(messages[0]).toContain("巡检日志");
  });

  it("2000 字以内的单轮正文逐字保留（不再分条）", () => {
    const body = `${"甲".repeat(700)}。${"乙".repeat(400)}。${"丙".repeat(400)}`;
    const chunks = formatRoundPush(
      "BTC 实盘巡检",
      { round: "r", events: [{ ts: "t", round: "r", kind: "text", text: body }], end: 1 },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain(body);
    expect(chunks[0]).not.toContain("中间省略");
  });
});

/**
 * A 股结论曾经在推送前被两刀砍掉：源头 `SUMMARY_LIMIT=600`，转发时再
 * `slice(0, 300)`。用户看到的是半张表 + 一行孤零零的 `6`（`601939` 的前半个字）。
 * 这里锁住「只切不砍」：内容要么完整送达，要么明确分条。
 */
describe("A 股推送只切不砍", () => {
  const conclusion = [
    "**结论（2026-11-19 收盘总结）：**",
    "",
    "| 代码 | 名称 | 方向 | 15m 分 | 动作 | 依据 |",
    "|---|---|---|---|---|---|",
    "| 600901 | 江苏金租 | long | 28 | 持有（已减半） | 15m 结构 0；止损 7.5 未触发 |",
    "| 600886 | 国投电力 | long | 80 | 持有 | 三周期全多，止损 15.4 未触发 |",
    "| 601939 | 建设银行 | long | 100 | 持有 | 15m 满分，止损 12.1 未触发 |",
    "| 603565 | 中谷物流 | long | 73 | 观望 | 持仓已满 3 只 |",
    "",
    "**账户**：总资产 1,003,211.92，可用 504,061.92。",
  ].join("\n");

  it("结论正文逐字保留（错误事件另起一行）", () => {
    const body = composeAStreamText([
      { ts: "t", kind: "text", text: conclusion },
      { ts: "t", kind: "error", text: "行情超时" },
    ]);
    expect(body).toContain("601939");
    expect(body).toContain("账户");
    expect(body).toContain("· 巡检异常：行情超时");
  });

  it("2000 字以内逐字保留，超长时保留开头与结尾并注明省略", () => {
    const short = `${conclusion}\n${"补充说明。".repeat(100)}`;
    expect(short.length).toBeLessThan(2_000);
    const one = formatStreamPush("A 股巡检结论", short);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatch(/^\[A 股巡检结论\]\n/);
    expect(one[0].replace(/^\[[^\]]*\]\n/, "").replace(/\s/g, "")).toBe(
      short.replace(/\s/g, ""),
    );

    const long = `${conclusion}\n${"补充说明。".repeat(400)}`;
    const clipped = formatStreamPush("A 股巡检结论", long);
    expect(clipped).toHaveLength(1);
    expect(clipped[0].length).toBeLessThanOrEqual(2_000);
    expect(clipped[0]).toContain("中间省略");
    expect(clipped[0]).toContain("巡检日志");
    // 开头与结尾都必须在：结论表格不会只剩半行
    expect(clipped[0]).toContain("结论（2026-11-19 收盘总结）");
    expect(clipped[0]).toContain("补充说明");
  });

  it("空正文不发空气泡", () => {
    expect(formatStreamPush("A 股巡检结论", "  \n ")).toEqual([]);
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

  it("推送成功要留日志（「微信没收到」才有得查）", async () => {
    // 首次 tick 只初始化偏移
    await runFeedTick({ offsetsFile, send: async () => true });
    appendBtc("text", "结论：观望");
    appendBtc("round-end", "结论：观望");

    const logs: string[] = [];
    await runFeedTick({
      offsetsFile,
      send: async () => true,
      log: (message) => logs.push(message),
    });
    expect(logs.some((line) => line.includes("巡检转发") && line.includes("1 轮"))).toBe(true);
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

  it("一轮只发一条气泡；失败时不推进偏移，下轮整轮重发一次", async () => {
    await runFeedTick({ offsetsFile, send: async () => true });

    // 正文约 1200 字：以前是 2 条气泡，现在压成 1 条
    appendBtc("text", `${"甲".repeat(400)}。${"乙".repeat(400)}。${"丙".repeat(400)}`);
    appendBtc("round-end", "长结论");

    const before = readFeedOffsets(offsetsFile).btc;
    const sent: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent.push(text), false) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("甲");
    expect(readFeedOffsets(offsetsFile).btc).toBe(before);

    const sent2: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent2.push(text), true) });
    expect(sent2).toHaveLength(1);
    expect(sent2[0]).toContain("丙");
    expect(readFeedOffsets(offsetsFile).btc).toBeGreaterThan(before);

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

    // 新版选股会写详情（名称 / 分数 / 换入换出）：直接用它，不再只推一串代码
    entry({
      kind: "select",
      codes: ["601857", "601939"],
      message: [
        "收盘选股 2 只（持仓保留）",
        "1. 中国石油 601857 · 86 分 · 趋势 月/周/日 全 +1",
        "2. 建设银行 601939 · 81 分 · 趋势 月/周 +1",
        "新进：中国石油 601857",
        "移出：莱美药业 300006",
      ].join("\n"),
    });
    const sent2: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent2.push(text), true) });
    expect(sent2).toHaveLength(1);
    expect(sent2[0]).toContain("1. 中国石油 601857 · 86 分");
    expect(sent2[0]).toContain("移出：莱美药业 300006");
  });

  it("A 股中文动作的偏移按字节推进，不能停在行中间", async () => {
    const actionsFile = path.join(aHome, "monitor", "actions.jsonl");
    fs.mkdirSync(path.dirname(actionsFile), { recursive: true });
    const entry = (entry: Record<string, unknown>): void => {
      fs.appendFileSync(actionsFile, `${JSON.stringify(entry)}\n`, "utf8");
    };

    entry({ kind: "buy", message: "买入 贵州茅台 100 股 @ 10.00（费用 5.00）" });
    await runFeedTick({ offsetsFile, send: async () => true }); // 初始化偏移

    entry({ kind: "sell", message: "卖出 贵州茅台 100 股 @ 11.00（费用 5.50）" });
    const sent: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent.push(text), true) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("卖出 贵州茅台");

    // 回归：以前 offset = start + 字符数，中文行会少推进约 2/3 的字节，
    // 下一轮从行中间开始 → 动作漏推或重复。
    expect(readFeedOffsets(offsetsFile).a).toBe(
      fs.statSync(actionsFile).size,
    );
    const again: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (again.push(text), true) });
    expect(again).toEqual([]);
  });

  it("A 股巡检结论不再被砍成 300 字（表格最后几行必须送达）", async () => {
    // 首次调用初始化 a-stream 偏移（从当前末尾开始，不回放）
    await runFeedTick({ offsetsFile, send: async () => true });

    const rows = [
      "**结论（2026-11-19 收盘总结）：**",
      "| 代码 | 名称 | 方向 | 15m 分 | 动作 | 依据 |",
      "|---|---|---|---|---|---|",
      `| 600901 | 江苏金租 | long | 28 | 持有（已减半） | 今日已卖出 12500 股 @ 7.78，剩余 12500 股；15m 结构 0（跌破 MA20 与前 10 根低点），止损 7.5 未触发，明日开盘复核结构是否修复 |`,
      `| 600886 | 国投电力 | long | 80 | 持有 | 三周期全多，15m 结构 30/量能 15/形态 15，止损 15.4 未触发 |`,
      `| 601939 | 建设银行 | long | 100 | 持有 | 三周期全多，15m 满分（结构 30/动量 20/量能 15/形态 15），已收复上午高点附近，止损 12.1 未触发 |`,
      `| 603565 | 中谷物流 | long | 73 | 观望 | 持仓已满 3 只，无法开新仓 |`,
      "",
      "**账户**：总资产 1,003,211.92（+0.32%），可用 504,061.92，无挂单。",
      "**监控规则更新**：保留 600901 ≤ 7.5、600886 ≤ 15.4（止损）",
    ];
    const body = rows.join("\n");
    // 必须有内容落在旧的 300 字切点之外，否则这条用例证明不了什么
    expect(body.length).toBeGreaterThan(400);
    // 一轮 = start … end；现在要等 end 才整轮推一条
    appendAInspectEvent("start", "收盘总结");
    appendAInspectEvent("text", body);
    appendAInspectEvent("end", "工具 3 次");

    const sent: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent.push(text), true) });

    expect(sent).toHaveLength(1);
    const all = sent.join("\n");
    expect(all).toContain("[A 股巡检结论");
    // 最后两行以前正好落在那 300 字之外
    expect(all).toContain("601939");
    expect(all).toContain("监控规则更新");
    expect(sent.every((message) => message.length <= 2_000)).toBe(true);
  });

  it("A 股结论按轮聚合：未结束不推，结束后整轮只推一次", async () => {
    await runFeedTick({ offsetsFile, send: async () => true }); // 初始化 a-stream 偏移
    const before = readFeedOffsets(offsetsFile)["a-stream"];

    appendAInspectEvent("start", "盘中巡检");
    appendAInspectEvent("text", "第一段：601988 中国银行 持有");
    const pending: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (pending.push(text), true) });
    expect(pending).toEqual([]);
    expect(readFeedOffsets(offsetsFile)["a-stream"]).toBe(before);

    appendAInspectEvent("text", "第二段：结论 观望，排期 13:45");
    appendAInspectEvent("end", "工具 2 次");
    const sent: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (sent.push(text), true) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("第一段");
    expect(sent[0]).toContain("第二段");
    expect(sent[0]).toMatch(/^\[A 股巡检结论 \d{2}:\d{2}\]\n/);

    const again: string[] = [];
    await runFeedTick({ offsetsFile, send: async (text) => (again.push(text), true) });
    expect(again).toEqual([]);
  });

  it("同一过程流里实盘 / 模拟盘按各自角色标注（不跟网关 env 走）", async () => {
    await runFeedTick({ offsetsFile, send: async () => true }); // 初始化偏移
    const savedRole = process.env.XZH_BTC_ROLE;
    process.env.XZH_BTC_ROLE = "live"; // 网关进程是实盘，但模拟盘那一轮也要标对
    try {
      appendInspectEvent(
        { round: "r-paper", kind: "text", text: "模拟盘结论", role: "paper" },
        btcHome,
      );
      appendInspectEvent(
        { round: "r-paper", kind: "round-end", text: "模拟盘结论", role: "paper" },
        btcHome,
      );
      appendInspectEvent(
        { round: "r-live", kind: "text", text: "实盘结论", role: "live" },
        btcHome,
      );
      appendInspectEvent(
        { round: "r-live", kind: "round-end", text: "实盘结论", role: "live" },
        btcHome,
      );
      const sent: string[] = [];
      await runFeedTick({ offsetsFile, send: async (text) => (sent.push(text), true) });
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatch(/^\[BTC 模拟盘巡检\]/);
      expect(sent[0]).toContain("模拟盘结论");
      expect(sent[1]).toMatch(/^\[BTC 实盘巡检\]/);
      expect(sent[1]).toContain("实盘结论");
    } finally {
      if (savedRole === undefined) delete process.env.XZH_BTC_ROLE;
      else process.env.XZH_BTC_ROLE = savedRole;
    }
  });
});

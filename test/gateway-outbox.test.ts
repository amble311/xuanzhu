import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { WEIXIN_CAPABILITIES, type ChannelCapabilities } from "../src/gateway/channels";
import { readOutbox, readOutboxState, startOutbox } from "../src/gateway/outbox";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-outbox-"));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 测试里把块间隔压到 1ms，其余能力沿用真实微信 */
const caps: ChannelCapabilities = { ...WEIXIN_CAPABILITIES, chunkDelayMs: 1 };
const PEER = "wxid_test_peer";

/** iLink 的业务码失败：HTTP 200 但服务端拒收 */
const REFUSED = {
  ok: false,
  error: "iLink sendmessage 失败（ret=-2 errcode=0）：prepare failed",
};

/** 预置一条 v2 队列（模拟「重启后读到上次没发完的消息」） */
function seed(
  home: string,
  texts: string[],
  options: { kind?: "trade" | "inspect"; peer?: string } = {},
): void {
  const now = new Date().toISOString();
  const file = path.join(home, "run", "outbox.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      version: 2,
      items: texts.map((text, index) => ({
        id: `seed-${index}`,
        text,
        kind: options.kind ?? "trade",
        peer: options.peer ?? PEER,
        createdAt: now,
        attempts: 0,
        nextAt: now,
        sent: 0,
      })),
      peers: {},
      stats: { delivered: 0, dropped: 0 },
    })}\n`,
    "utf8",
  );
}

describe("微信出站漏斗", () => {
  it("先落盘，送达后删除", async () => {
    const home = fs.mkdtempSync(path.join(root, "ok-"));
    const sent: string[] = [];
    const queue = startOutbox({
      gatewayHome: home,
      capabilities: caps,
      send: async (_peer, text) => {
        sent.push(text);
        return true;
      },
      intervalMs: 10,
    });
    queue.enqueue({ text: "消息一", kind: "trade", peer: PEER });
    queue.enqueue({ text: "消息二", kind: "trade", peer: PEER });
    expect(readOutbox(home)).toHaveLength(2);

    await sleep(120);
    queue.stop();
    expect(sent).toEqual(["消息一", "消息二"]);
    expect(readOutbox(home)).toHaveLength(0);
  });

  it("网络类失败保留并短退避（5 秒级，不是 10 分钟）", async () => {
    const home = fs.mkdtempSync(path.join(root, "fail-"));
    const started = Date.now();
    const queue = startOutbox({
      gatewayHome: home,
      capabilities: caps,
      send: async () => ({ ok: false, error: "fetch failed" }),
      intervalMs: 10,
    });
    queue.enqueue({ text: "会失败的消息", kind: "trade", peer: PEER });
    await sleep(80);
    queue.stop();
    const items = readOutbox(home);
    expect(items).toHaveLength(1);
    expect(items[0].attempts).toBe(1);
    expect(Date.parse(items[0].nextAt) - started).toBeLessThan(60_000);
  });

  it("重启后能读到未发送的消息", () => {
    const home = fs.mkdtempSync(path.join(root, "restart-"));
    const first = startOutbox({
      gatewayHome: home,
      capabilities: caps,
      send: async () => false,
      intervalMs: 10_000,
    });
    first.enqueue({ text: "重启后继续", kind: "trade", peer: PEER });
    first.stop();
    expect(readOutbox(home).map((item) => item.text)).toEqual(["重启后继续"]);
  });

  it("iLink 拒收（ret=-2）走 10 分钟起步的探测退避", async () => {
    const home = fs.mkdtempSync(path.join(root, "throttle-"));
    seed(home, ["巡检结论"]);
    const before = Date.now();
    const queue = startOutbox({
      gatewayHome: home,
      capabilities: caps,
      send: async () => REFUSED,
      intervalMs: 10,
    });
    await sleep(80);
    queue.stop();
    const state = readOutboxState(home);
    expect(state.items).toHaveLength(1);
    expect(state.items[0].attempts).toBe(1);
    expect(state.peers[PEER].rejectStreak).toBe(1);
    expect(Date.parse(state.peers[PEER].nextProbeAt ?? "") - before).toBeGreaterThanOrEqual(
      9 * 60_000,
    );
  });

  it("被拒收后标记「通道失效」，入站消息 markInbound 立刻补发", async () => {
    const home = fs.mkdtempSync(path.join(root, "recover-"));
    seed(home, ["消息一", "消息二", "消息三"]);
    let attempts = 0;
    let blocked: string | null = null;
    let healthy = false;
    const queue = startOutbox({
      gatewayHome: home,
      capabilities: caps,
      send: async () => {
        attempts += 1;
        return healthy ? true : REFUSED;
      },
      log: () => undefined,
      onBlocked: (reason) => {
        blocked = reason;
      },
      intervalMs: 10,
    });

    await sleep(150);
    expect(queue.blocked).toBe(true);
    expect(blocked).toContain("ret=-2");
    const frozen = attempts;
    await sleep(100);
    // 退避期间不再撞服务端
    expect(attempts).toBe(frozen);
    expect(readOutbox(home)).toHaveLength(3);

    // 用户在微信里发来一条消息 → 窗口刷新 → 解除退避并补发
    healthy = true;
    queue.markInbound(PEER);
    await sleep(150);
    queue.stop();
    expect(queue.blocked).toBe(false);
    expect(blocked).toBeNull();
    expect(readOutbox(home)).toHaveLength(0);
  });

  it("窗口关闭时巡检结论转摘要，不占推送额度", async () => {
    const home = fs.mkdtempSync(path.join(root, "digest-"));
    const digested: Array<{ kind: string; text: string; reason: string }> = [];
    let sends = 0;
    const queue = startOutbox({
      gatewayHome: home,
      capabilities: caps,
      send: async () => {
        sends += 1;
        return true;
      },
      onDigest: (message) => digested.push(message),
      intervalMs: 10,
    });
    queue.enqueue({ text: "[A 股巡检结论]\n601988 中国银行 持有", kind: "inspect", peer: PEER });
    await sleep(80);
    queue.stop();
    expect(sends).toBe(0);
    expect(digested).toHaveLength(1);
    expect(digested[0].text).toContain("601988");
    expect(readOutbox(home)).toHaveLength(0);
  });

  it("窗口打开时巡检结论立即推送", async () => {
    const home = fs.mkdtempSync(path.join(root, "window-"));
    const sent: string[] = [];
    const queue = startOutbox({
      gatewayHome: home,
      capabilities: caps,
      send: async (_peer, text) => {
        sent.push(text);
        return true;
      },
      intervalMs: 10,
    });
    queue.markInbound(PEER);
    queue.enqueue({ text: "[A 股巡检结论]\n601398 工商银行 持有", kind: "inspect", peer: PEER });
    await sleep(80);
    queue.stop();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("601398");
  });

  it("同类消息（同标题）入队合并，标题只保留一次", async () => {
    const home = fs.mkdtempSync(path.join(root, "merge-"));
    const queue = startOutbox({
      gatewayHome: home,
      capabilities: caps,
      send: async () => false,
      intervalMs: 10_000,
    });
    queue.enqueue({ text: "[A 股巡检]\n601328 交通银行 持有", kind: "trade", peer: PEER });
    queue.enqueue({ text: "[A 股巡检]\n601398 工商银行 持有", kind: "trade", peer: PEER });
    queue.enqueue({ text: "[A 股巡检]\n收盘选股 4 只", kind: "inspect", peer: PEER });
    queue.stop();

    const items = readOutbox(home);
    expect(items).toHaveLength(2);
    expect(items[0].text).toContain("601328 交通银行");
    expect(items[0].text).toContain("601398 工商银行");
    expect(items[0].text.match(/\[A 股巡检\]/g)).toHaveLength(1);
    expect(items[1].text).toContain("收盘选股");
  });

  it("正文超长切块：失败后从下一块续发，不重发已送达的块", async () => {
    const home = fs.mkdtempSync(path.join(root, "chunk-"));
    const narrow: ChannelCapabilities = { ...caps, maxLen: 100 };
    const sent: string[] = [];
    let allow = 1; // 只允许第 1 块成功
    let fakeNow = Date.now();
    const queue = startOutbox({
      gatewayHome: home,
      capabilities: narrow,
      send: async (_peer, text) => {
        if (sent.length < allow) {
          sent.push(text);
          return true;
        }
        return { ok: false, error: "fetch failed" };
      },
      intervalMs: 10,
      now: () => fakeNow,
    });
    const body = "x".repeat(250);
    queue.enqueue({ text: body, kind: "trade", peer: PEER });
    await sleep(60);
    expect(sent).toHaveLength(1);
    expect(readOutbox(home)[0].sent).toBe(1);

    // 越过 5 秒网络退避
    fakeNow += 11_000;
    allow = 99;
    await sleep(120);
    queue.stop();
    // 只补发剩下的 2 块
    expect(sent).toHaveLength(3);
    expect(sent.join("")).toBe(body);
    expect(readOutbox(home)).toHaveLength(0);
  });

  it("回复走同一个漏斗：enqueueReply 在送达后返回 true", async () => {
    const home = fs.mkdtempSync(path.join(root, "reply-"));
    const queue = startOutbox({
      gatewayHome: home,
      capabilities: caps,
      send: async () => true,
      intervalMs: 10,
    });
    const ok = await queue.enqueueReply(PEER, "收到，正在处理");
    queue.stop();
    expect(ok).toBe(true);
    expect(readOutbox(home)).toHaveLength(0);
  });
});

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendInspectEvent,
  currentInspectOffset,
  inspectStreamPath,
  readInspectEvents,
} from "../src/btc/inspect-stream";

/**
 * 后台过程流：前端靠「文件偏移 + 增量读」拿到后台在想什么。
 * 这里验证增量语义（不重复、不丢半行、轮转后不外泄整份历史）。
 */
describe("巡检过程流", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-stream-"));
  const saved = process.env.XZH_BTC_HOME;

  beforeAll(() => {
    process.env.XZH_BTC_HOME = home;
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.XZH_BTC_HOME;
    else process.env.XZH_BTC_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("首次接入从末尾开始，不回放历史", () => {
    appendInspectEvent({ round: "r1", kind: "round-start", text: "旧的一轮" }, home);
    const start = currentInspectOffset(home);
    expect(start).toBeGreaterThan(0);

    // 从末尾读：没有新事件
    expect(readInspectEvents(start, home).events).toEqual([]);
  });

  it("只读取新增部分，且不重复", () => {
    const from = currentInspectOffset(home);
    appendInspectEvent({ round: "r2", kind: "reasoning", text: "周线多头" }, home);
    appendInspectEvent({ round: "r2", kind: "tool", text: "btc_signal" }, home);

    const first = readInspectEvents(from, home);
    expect(first.events.map((event) => event.text)).toEqual([
      "周线多头",
      "btc_signal",
    ]);

    // 用返回的偏移继续读：什么都不该再出现
    expect(readInspectEvents(first.offset, home).events).toEqual([]);

    appendInspectEvent({ round: "r2", kind: "round-end", text: "观望" }, home);
    const second = readInspectEvents(first.offset, home);
    expect(second.events.map((event) => event.text)).toEqual(["观望"]);
  });

  it("半行不消费，偏移停在上一个换行之后", () => {
    const from = currentInspectOffset(home);
    const file = inspectStreamPath(home);
    // 模拟后端写到一半
    fs.appendFileSync(
      file,
      `{"ts":"2026-11-03T00:00:00Z","round":"r3","kind":"text","text":"完整的"}\n{"ts":"2026-11-03T00`,
      "utf8",
    );

    const result = readInspectEvents(from, home);
    expect(result.events.map((event) => event.text)).toEqual(["完整的"]);

    // 补齐后半行，下次能读到
    fs.appendFileSync(
      file,
      `","round":"r3","kind":"text","text":"补齐的"}\n`,
      "utf8",
    );
    const next = readInspectEvents(result.offset, home);
    expect(next.events.map((event) => event.text)).toEqual(["补齐的"]);
  });

  it("坏行跳过，不影响同批其他事件", () => {
    const from = currentInspectOffset(home);
    const file = inspectStreamPath(home);
    fs.appendFileSync(file, `这不是 JSON\n{"ts":"2026-11-03T00:00:00Z","round":"r4","kind":"notice","text":"好的"}\n`, "utf8");

    const result = readInspectEvents(from, home);
    expect(result.events.map((event) => event.text)).toEqual(["好的"]);
  });

  it("偏移超出文件大小（轮转/清空后）时退回末尾附近，不整份重读", () => {
    const file = inspectStreamPath(home);
    fs.writeFileSync(file, "", "utf8");
    appendInspectEvent({ round: "r5", kind: "text", text: "新文件" }, home);

    const result = readInspectEvents(999_999, home);
    expect(result.events.map((event) => event.text)).toEqual(["新文件"]);
    expect(result.offset).toBe(fs.statSync(file).size);
  });
});

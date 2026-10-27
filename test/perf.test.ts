import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, type AgentEvents } from "../src/core/agent";
import { buildSystemPrompt } from "../src/core/prompt";
import { consumeStreamingLine, formatBusyDetail } from "../src/tui/app";
import { MarkdownRenderer } from "../src/tui/markdown";
import { DEFAULT_CONFIG, type ModelEntry, type XuanZhuConfig } from "../src/config/store";
import type { DeviceBridge } from "../src/device";
import type { ChatOptions, LLMProvider, StreamChunk } from "../src/llm/types";

/**
 * 面向「本地模型响应慢」的两项优化：
 * 1. 状态栏显示本轮耗时 / 已接收字数（避免看起来卡死）；
 * 2. 未连接设备桥时不下发 `device_*` 工具（省提示词）。
 */

const model: ModelEntry = {
  id: "fake/fake",
  provider: "fake",
  model: "fake",
  contextWindow: 100000,
};

const configOf = (): XuanZhuConfig => ({
  ...DEFAULT_CONFIG,
  provider: "fake",
  model: "fake",
  models: [model],
});

const events = (): AgentEvents => ({
  onText: () => undefined,
  onToolStart: () => undefined,
  onToolEnd: () => undefined,
  onStatus: () => undefined,
  confirm: async () => true,
});

const tmpCwd = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "xzh-perf-"));

describe("formatBusyDetail", () => {
  it("刚开始时只显示秒数", () => {
    expect(
      formatBusyDetail({ elapsedMs: 300, reasoningChars: 0, textChars: 0 }),
    ).toBe("0s");
  });

  it("显示耗时、思考字数与输出字数", () => {
    expect(
      formatBusyDetail({
        elapsedMs: 12_400,
        reasoningChars: 320,
        textChars: 80,
      }),
    ).toBe("12s · 思考 320 字 · 输出 80 字");
  });

  it("目标模式带上轮次", () => {
    expect(
      formatBusyDetail({
        elapsedMs: 1_000,
        reasoningChars: 0,
        textChars: 0,
        round: 3,
      }),
    ).toBe("第 3 轮 · 1s");
  });

  it("负数/异常时间归零", () => {
    expect(
      formatBusyDetail({ elapsedMs: -50, reasoningChars: 0, textChars: 0 }),
    ).toBe("0s");
  });
});

describe("设备工具按需下发", () => {
  it("未连接设备桥时不带 device_*，连接后才带上", async () => {
    const seen: ChatOptions[] = [];
    const llm: LLMProvider = {
      id: "fake",
      model: "fake",
      async *chat(options: ChatOptions): AsyncGenerator<StreamChunk> {
        seen.push(options);
        yield { type: "text", text: "ok" };
        yield { type: "done", finishReason: "stop" };
      },
    };

    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model);

    await agent.run("第一轮");
    const names = seen[0].tools.map((tool) => tool.name);
    expect(names).not.toContain("device_list");
    expect(names).not.toContain("device_screenshot");
    expect(names).toContain("read_file");
    // 非目标模式不下发 goal_complete
    expect(names).not.toContain("goal_complete");

    // 连接设备桥后恢复（这里只需要一个非空对象，requestTools 只判断是否存在）
    agent.setDeviceBridge({} as DeviceBridge);
    await agent.run("第二轮");
    const namesWithDevice = seen[1].tools.map((tool) => tool.name);
    expect(namesWithDevice).toContain("device_list");
    expect(namesWithDevice).toContain("device_screenshot");

    // 设定目标后才下发 goal_complete
    agent.setGoal("完成 X");
    await agent.run("第三轮");
    expect(seen[2].tools.map((tool) => tool.name)).toContain("goal_complete");
  });
});

describe("通知打断流式输出", () => {
  it("落定最后一行后，结束时不会重复同一段正文", () => {
    const renderer = new MarkdownRenderer();
    // 没有换行：内容留在缓冲里，peek() 用于流式预览
    expect(renderer.push("最后一段（未换行）")).toEqual([]);
    const preview = renderer.peek();
    expect(preview).toContain("最后一段");

    // 通知（如「已自动记录当日摘要」）到达时必须消费缓冲
    const settled = consumeStreamingLine(renderer, Boolean(preview));
    expect(settled.join("\n")).toContain("最后一段");
    // 结束时再 flush 不能再吐出同一段
    expect(renderer.flush()).toEqual([]);
  });
});

describe("系统提示词按需包含设备说明", () => {
  it("未连接设备时没有 device_* 段，连接后才出现", () => {
    const without = buildSystemPrompt("/tmp/demo", undefined, null, null);
    expect(without).not.toContain("device_list");
    expect(without).toContain("## 工具使用规范");

    const withDevice = buildSystemPrompt(
      "/tmp/demo",
      undefined,
      null,
      null,
      undefined,
      true,
    );
    expect(withDevice).toContain("device_list");
    expect(withDevice).toContain("device_read_screen");
    // 连接设备后提示词只多出这一段，基础部分仍在
    expect(withDevice.length).toBeGreaterThan(without.length);
  });
});

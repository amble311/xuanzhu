import { describe, expect, it } from "vitest";
import {
  decideSideGate,
  gateFromSignal,
  resetSideGateCache,
} from "../src/btc/side-gate";

/**
 * 三周期方向闸门。
 *
 * 这是**真钱**下单前的最后一道代码校验：用户要求「三周期都 ≥0 只做多、
 * 都 ≤0 只做空」，光写在提示词里挡不住模型「综合判断」后开反向单。
 * 失败策略必须是拒绝 —— 拿不到信号时默认放行，等于数据故障就放开限制。
 */
describe("三周期方向闸门", () => {
  it("解析 btc_signal 的 side_filter 与打分", () => {
    const long = gateFromSignal({
      side_filter: "long",
      side_reason: "三周期均 ≥0 且至少一个向上：只做多",
      score: { weekly: 1, daily: 0, h4: 1, sum: 2 },
      as_of: "2026-11-05 08:00:00",
    });
    expect(long.side).toBe("long");
    expect(long.available).toBe(true);
    expect(long.score).toEqual({ weekly: 1, daily: 0, h4: 1, sum: 2 });
    expect(long.reason).toContain("只做多");
  });

  it("字段缺失或非法时判为 unknown（不能默认放行）", () => {
    for (const data of [undefined, null, {}, { side_filter: "LONG" }, { side_filter: 1 }]) {
      const gate = gateFromSignal(data);
      expect(gate.side).toBe("unknown");
      expect(gate.available).toBe(false);
    }
    expect(gateFromSignal({ side_filter: "none" }).available).toBe(true);
  });

  it("同向放行", () => {
    const gate = gateFromSignal({ side_filter: "short", score: { weekly: -1, daily: -1, h4: 0, sum: -2 } });
    const decision = decideSideGate(gate, "short");
    expect(decision.ok).toBe(true);
    expect(decision.message).toBe("");
  });

  it("反向拒绝，并在理由里写明当前只允许什么方向", () => {
    const gate = gateFromSignal({
      side_filter: "long",
      side_reason: "三周期均 ≥0 且至少一个向上：只做多",
      score: { weekly: 1, daily: 0, h4: 1, sum: 2 },
    });
    const decision = decideSideGate(gate, "short");
    expect(decision.ok).toBe(false);
    expect(decision.message).toContain("只允许做多");
    expect(decision.message).toContain("周线 +1");
    expect(decision.message).toContain("不能做空");
  });

  it("none（全横盘或方向冲突）一律拒绝", () => {
    const gate = gateFromSignal({
      side_filter: "none",
      side_reason: "三周期方向冲突（有正有负）：不做",
      score: { weekly: 1, daily: -1, h4: 0, sum: 0 },
    });
    expect(decideSideGate(gate, "long").ok).toBe(false);
    expect(decideSideGate(gate, "short").ok).toBe(false);
    expect(decideSideGate(gate, "long").message).toContain("方向闸门拒绝");
  });

  it("unknown 时拒绝并给出补数据的操作", () => {
    const gate = gateFromSignal({ side_filter: "unknown", side_reason: "4 小时线不可用" });
    const decision = decideSideGate(gate, "long");
    expect(decision.ok).toBe(false);
    expect(decision.message).toContain("无法判定");
    expect(decision.message).toContain("btc_sync");
  });

  it("清缓存不抛错（下单前后可强制刷新）", () => {
    expect(() => resetSideGateCache()).not.toThrow();
  });
});

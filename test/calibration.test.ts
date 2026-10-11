import { beforeEach, describe, expect, it } from "vitest";
import {
  calibrateBudget,
  calibratorFor,
  DEFAULT_TOKEN_FACTOR,
  resetCalibrators,
  TokenCalibrator,
} from "../src/llm/calibration";

describe("TokenCalibrator", () => {
  let calibrator: TokenCalibrator;

  beforeEach(() => {
    calibrator = new TokenCalibrator();
  });

  it("样本不足时不校正", () => {
    calibrator.observe(1000, 2000); // ratio = 2，但只有 1 个样本
    expect(calibrator.factor()).toBe(DEFAULT_TOKEN_FACTOR);
    expect(calibrator.observationCount).toBe(1);
  });

  it("低估（真实 > 估算）时给出收紧系数", () => {
    calibrator.observe(1000, 2000);
    calibrator.observe(1000, 2000);
    expect(calibrator.factor()).toBeCloseTo(2, 5);
  });

  it("高估（真实 < 估算）时不放宽，恒为 1", () => {
    calibrator.observe(1000, 400);
    calibrator.observe(1000, 400);
    expect(calibrator.factor()).toBe(DEFAULT_TOKEN_FACTOR);
  });

  it("EWMA 平滑：后续样本不会立刻把系数拉满", () => {
    calibrator.observe(1000, 2000); // 初值 2
    calibrator.observe(1000, 4000); // 新样本 4
    // 2 * 0.7 + 4 * 0.3 = 2.6
    expect(calibrator.factor()).toBeCloseTo(2.6, 5);
  });

  it("异常样本（缓存命中等导致的骤降/骤升）被丢弃", () => {
    calibrator.observe(1000, 100); // ratio = 0.1 边界外/内？0.1 为下界（含）
    calibrator.observe(1000, 20000); // ratio = 20，超上界 → 丢弃
    expect(calibrator.observationCount).toBe(1);
  });

  it("非法入参不产生样本", () => {
    calibrator.observe(0, 100);
    calibrator.observe(100, 0);
    calibrator.observe(Number.NaN, 100);
    expect(calibrator.observationCount).toBe(0);
  });

  it("reset 清空状态", () => {
    calibrator.observe(1000, 2000);
    calibrator.observe(1000, 2000);
    calibrator.reset();
    expect(calibrator.observationCount).toBe(0);
    expect(calibrator.factor()).toBe(DEFAULT_TOKEN_FACTOR);
  });
});

describe("calibrateBudget", () => {
  it("factor 为 1 时原样返回", () => {
    expect(calibrateBudget(1000, 1)).toBe(1000);
  });

  it("factor < 1（不该出现）也不放宽", () => {
    expect(calibrateBudget(1000, 0.5)).toBe(1000);
  });

  it("按 factor 收紧并向下取整", () => {
    expect(calibrateBudget(1000, 3)).toBe(333);
  });

  it("收紧后至少为 1", () => {
    expect(calibrateBudget(2, 4)).toBe(1);
  });
});

describe("calibratorFor", () => {
  beforeEach(() => resetCalibrators());

  it("同一 key 返回同一实例（进程内共享）", () => {
    const a = calibratorFor("deepseek/deepseek-chat");
    const b = calibratorFor("deepseek/deepseek-chat");
    expect(a).toBe(b);
  });

  it("不同 key 相互独立", () => {
    calibratorFor("a").observe(1000, 2000);
    calibratorFor("a").observe(1000, 2000);
    expect(calibratorFor("b").factor()).toBe(DEFAULT_TOKEN_FACTOR);
  });
});

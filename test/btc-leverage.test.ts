import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEVERAGE,
  MAX_AUTO_LEVERAGE,
  maxNotionalFor,
  requiredLeverageFor,
  resolveLeverage,
  suggestLeverage,
} from "../src/btc/leverage";

/**
 * 倍率规则：
 * - 默认 9x（用户设定），缺省不能沿用交易所旧值；
 * - 具体倍率由模型按「可用余额 + 本次信心」自主给；
 * - 建议区间只是提示，不做强制夹取（合法性校验在下单层）。
 */
describe("倍率", () => {
  it("显式给的值优先（合法性由下单层校验）", () => {
    expect(resolveLeverage(5)).toBe(5);
    expect(resolveLeverage(12.4)).toBe(12.4);
    // 非法值不在这里夹取：下单层要给出「1–125」的可读错误
    expect(resolveLeverage(200)).toBe(200);
  });

  it("缺省回落 9x，而不是读交易所旧值", () => {
    expect(DEFAULT_LEVERAGE).toBe(9);
    expect(resolveLeverage(undefined, undefined)).toBe(9);
    expect(resolveLeverage(undefined, "")).toBe(9);
    expect(resolveLeverage(undefined, "abc")).toBe(9);
  });

  it("BTC_LEVERAGE 可统一覆盖默认值，非法值仍回落 9", () => {
    expect(resolveLeverage(undefined, "5")).toBe(5);
    expect(resolveLeverage(undefined, "0")).toBe(9);
    expect(resolveLeverage(undefined, "999")).toBe(9);
  });

  it("余额不足时算所需倍率，20x 是硬上限", () => {
    const fee = 0.0005;
    // budget 57、名义 1000、手续费 0.5 → 需要 ceil(1000/56.5)=18x，可自动提
    expect(requiredLeverageFor(1000, 57, fee)).toBe(18);
    expect(requiredLeverageFor(1000, 57, fee)).toBeLessThanOrEqual(MAX_AUTO_LEVERAGE);
    // budget 50 → 需要 21x，超过上限
    expect(requiredLeverageFor(1000, 50, fee)).toBe(21);
    expect(requiredLeverageFor(1000, 50, fee)).toBeGreaterThan(MAX_AUTO_LEVERAGE);
    // 预算连手续费都不够：返回 Infinity，调用方据此拒绝而不是算出 0/负数
    expect(requiredLeverageFor(1000, 0, fee)).toBe(Number.POSITIVE_INFINITY);
  });

  it("给定倍率与预算可反推最大名义（用于拒绝时给可操作数字）", () => {
    // 57 / (1/20 + 0.0005) ≈ 1128.7
    expect(maxNotionalFor(57, MAX_AUTO_LEVERAGE, 0.0005)).toBeCloseTo(1128.71, 1);
    expect(maxNotionalFor(0, 20, 0.0005)).toBe(0);
  });

  it("建议倍率随信心与机会评分变化", () => {
    expect(suggestLeverage(0.8, 80)).toMatchObject({ min: 9, max: 12 });
    expect(suggestLeverage(0.65, 66)).toMatchObject({ min: 6, max: 9 });
    expect(suggestLeverage(0.4, 61)).toMatchObject({ min: 3, max: 6 });
    // 缺数据时按中性处理，不能因为 undefined 就建议高倍率
    expect(suggestLeverage(undefined, undefined)).toMatchObject({ min: 6, max: 9 });
  });
});

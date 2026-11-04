import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkHardRisk,
  clearHardRisk,
  DEFAULT_HARD_RISK,
  markRiskDelivered,
  readRiskSettings,
  readRiskState,
  riskSummary,
  triggerHardRisk,
  writeRiskSettings,
} from "../src/btc/risk";

describe("硬性风控", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-risk-"));

  beforeAll(() => {
    process.env.XZH_BTC_HOME = home;
  });

  afterAll(() => {
    delete process.env.XZH_BTC_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("默认阈值：持仓亏损 50% 触发", () => {
    const settings = readRiskSettings(home);
    expect(settings.maxPositionLossPct).toBe(50);
    expect(settings.maxDailyLossPct).toBe(10);
    expect(settings.maxConsecutiveLosses).toBe(3);
    expect(settings.haltTradingOnTrigger).toBe(true);
  });

  it("文件被写坏时按默认值兜底，而不是「不设限」", () => {
    fs.writeFileSync(
      path.join(home, "risk.json"),
      JSON.stringify({ version: 1, maxPositionLossPct: 0, maxDailyLossPct: -5 }),
    );
    const settings = readRiskSettings(home);
    expect(settings.maxPositionLossPct).toBe(DEFAULT_HARD_RISK.maxPositionLossPct);
    expect(settings.maxDailyLossPct).toBe(DEFAULT_HARD_RISK.maxDailyLossPct);
  });

  it("阈值判定：亏 49% 不触发，亏 50% 触发", () => {
    const settings = { ...DEFAULT_HARD_RISK };
    const loss = (lossPct: number) => ({
      positionLoss: { symbol: "BTCUSDT", lossPct },
    });
    expect(checkHardRisk(settings, loss(49)).triggered).toBe(false);
    const hit = checkHardRisk(settings, loss(52.3));
    expect(hit.triggered).toBe(true);
    expect(hit.detail).toContain("BTCUSDT");
    expect(checkHardRisk(settings, { positionLoss: null }).triggered).toBe(false);
  });

  it("当日亏损与连亏同样会触发（原来只判持仓亏损，慢性放血永远触发不了）", () => {
    const settings = readRiskSettings(home);

    // 当日亏 12% ≥ 阈值 10%
    const daily = checkHardRisk(settings, {
      positionLoss: null,
      dailyLossPct: 12,
    });
    expect(daily.triggered).toBe(true);
    expect(daily.reason).toContain("当日亏损");

    // 连亏 3 次 = 默认阈值
    const streak = checkHardRisk(settings, {
      positionLoss: null,
      consecutiveLosses: 3,
    });
    expect(streak.triggered).toBe(true);
    expect(streak.reason).toContain("连续亏损");

    // 连亏 2 次不触发
    expect(
      checkHardRisk(settings, { positionLoss: null, consecutiveLosses: 2 }).triggered,
    ).toBe(false);

    // 多个条件同时命中时，取「当日亏损」这个影响面最大的作为理由
    const both = checkHardRisk(settings, {
      positionLoss: { symbol: "BTCUSDT", lossPct: 80 },
      dailyLossPct: 15,
      consecutiveLosses: 5,
    });
    expect(both.reason).toContain("当日亏损");
  });

  it("触发是幂等的，且 delivered 只在首次为 false", () => {
    const first = triggerHardRisk(home, "持仓亏损达到 50%", "BTCUSDT 浮亏 -52%");
    expect(first.triggered).toBe(true);
    expect(first.delivered).toBe(false);

    markRiskDelivered(home);
    expect(readRiskState(home).delivered).toBe(true);

    // 再次触发不应把「已告知」重置成未告知（否则每轮巡检都在重估）
    const again = triggerHardRisk(home, "持仓亏损达到 50%");
    expect(again.delivered).toBe(true);
    expect(again.at).toBe(first.at);
  });

  it("解除后状态清空，摘要回到「正常」", () => {
    const settings = { ...DEFAULT_HARD_RISK, maxPositionLossPct: 30 };
    expect(riskSummary(settings, readRiskState(home))).toContain("已触发");

    clearHardRisk(home);
    const state = readRiskState(home);
    expect(state.triggered).toBe(false);
    expect(riskSummary(settings, state)).toBe(
      "正常（持仓亏损 30% · 当日亏损 10% · 连亏 3 次）",
    );
  });

  it("写回设置后能读回", () => {
    writeRiskSettings(home, {
      ...DEFAULT_HARD_RISK,
      maxPositionLossPct: 25,
      haltTradingOnTrigger: false,
    });
    const settings = readRiskSettings(home);
    expect(settings.maxPositionLossPct).toBe(25);
    expect(settings.haltTradingOnTrigger).toBe(false);
  });
});

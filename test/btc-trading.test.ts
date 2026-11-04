import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quantizePrice, quantizeQty } from "../src/btc/market-meta";
import { openPosition } from "../src/btc/trading";
import { triggerHardRisk, clearHardRisk } from "../src/btc/risk";

/**
 * 下单链路里**不依赖网络**的部分：精度对齐与风控闸门。
 *
 * 真实下单无法在测试里跑（需要凭据与真实账户），所以这里只验证：
 * 数量/价格按步长对齐，以及「硬性风控触发时开仓必须被拒」。
 */
describe("下单前置校验", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-trade-"));
  const savedHome = process.env.XZH_BTC_HOME;

  beforeAll(() => {
    process.env.XZH_BTC_HOME = home;
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.XZH_BTC_HOME;
    else process.env.XZH_BTC_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("数量向下取整到步长，不会超出", () => {
    expect(quantizeQty(0.0123456, 0.001)).toBe("0.012");
    // 浮点误差不能把 0.003 算成 0.002
    expect(quantizeQty(0.003, 0.001)).toBe("0.003");
    expect(quantizeQty(1, 1)).toBe("1");
  });

  it("价格按 tickSize 四舍五入", () => {
    expect(quantizePrice(77317.23, 0.1)).toBe("77317.2");
    expect(quantizePrice(77317.29, 0.1)).toBe("77317.3");
    expect(quantizePrice(100, 1)).toBe("100");
  });

  it("没有凭据时明确报错，而不是发出空签名请求", async () => {
    clearHardRisk(home);
    await expect(
      openPosition({ side: "long", limitPrice: 90_000, notional: 100 }),
    ).rejects.toThrow(/凭据/);
  });

  it("硬性风控触发后，开仓在发出请求前就被拒绝", async () => {
    triggerHardRisk(home, "持仓亏损达到 50%", "BTCUSDT 浮亏 -52%");
    await expect(
      openPosition({ side: "long", limitPrice: 90_000, notional: 100 }),
    ).rejects.toThrow(/硬性风控已触发/);
    clearHardRisk(home);
  });

  it("缺限价时直接拒绝：开仓统一限价单", async () => {
    await expect(
      openPosition({ side: "long", notional: 100 }),
    ).rejects.toThrow(/限价/);
    await expect(
      openPosition({ side: "long", limitPrice: 90_000 }),
    ).rejects.toThrow(/notional|quantity/);
  });
});

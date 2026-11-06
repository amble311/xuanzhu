import { describe, expect, it } from "vitest";
import {
  canAutoApproveUnattended,
  UNATTENDED_ALLOWED_TOOLS,
} from "../src/btc/unattended";

/**
 * 无人值守白名单的边界：
 * - 交易动作要放行（否则巡检「看见了却动不了」）；
 * - 清账本 / 资金划转 / 改环境必须继续拒绝（不可逆，且不属于交易决策）。
 */
describe("无人值守白名单", () => {
  it("交易与巡检自身动作放行", () => {
    for (const tool of [
      "btc_order",
      "btc_close",
      "btc_cancel",
      "btc_renew",
      "btc_sync",
      "btc_schedule",
      "btc_unschedule",
      "btc_policy",
      "btc_trigger",
      "btc_paper_open",
      "btc_paper_close",
      "btc_paper_cancel",
    ]) {
      expect(canAutoApproveUnattended(tool)).toBe(true);
    }
  });

  it("清账本 / 划转 / 改环境仍然拒绝", () => {
    for (const tool of [
      "btc_paper_reset",
      "btc_transfer_profit",
      "write_file",
      "edit_file",
      "bash",
      "bash_kill",
      "device_run",
      "memory_write",
    ]) {
      expect(canAutoApproveUnattended(tool)).toBe(false);
    }
    // 白名单里不能夹带 reset / transfer —— 这两个是最容易被顺手加进去的
    expect(
      [...UNATTENDED_ALLOWED_TOOLS].some(
        (tool) => tool.includes("reset") || tool.includes("transfer"),
      ),
    ).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { XuanZhuConfig } from "../src/config/store";
import { ensureBtcNetwork, resetBtcNetworkCache } from "../src/btc/network";
import { applyProxyConfig } from "../src/network/proxy";

/**
 * 网络引导的**决策分支**（不真的发请求，探测函数全部注入）：
 * 配了代理就直接用；没配才先试直连；直连不通才找本机代理。
 */
describe("btc 网络引导", () => {
  afterEach(() => {
    resetBtcNetworkCache();
    // applyProxyConfig 会替换 globalThis.fetch，测完必须恢复
    applyProxyConfig({} as XuanZhuConfig);
  });

  const asConfig = (network?: XuanZhuConfig["network"]): XuanZhuConfig =>
    ({ network }) as XuanZhuConfig;

  it("用户显式配了代理：直接用，不浪费一次直连探测", async () => {
    const probe = vi.fn(async () => true);
    const detect = vi.fn(async () => null);

    const result = await ensureBtcNetwork({
      config: asConfig({ enabled: true, proxy: "socks5h://127.0.0.1:10808" }),
      probeDirect: probe,
      detectProxy: detect,
      force: true,
    });

    expect(result.mode).toBe("proxy");
    expect(result.proxy).toBe("socks5h://127.0.0.1:10808");
    expect(probe).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
  });

  it("没配代理但直连可用：走直连，不去碰本机代理", async () => {
    const detect = vi.fn(async () => null);
    const result = await ensureBtcNetwork({
      config: asConfig(),
      probeDirect: async () => true,
      detectProxy: detect,
      force: true,
    });

    expect(result.mode).toBe("direct");
    expect(detect).not.toHaveBeenCalled();
  });

  it("直连不通且找到本机代理：临时切过去并提示", async () => {
    const result = await ensureBtcNetwork({
      config: asConfig(),
      probeDirect: async () => false,
      detectProxy: async () => ({ url: "http://127.0.0.1:7890" }),
      force: true,
    });

    expect(result.mode).toBe("proxy");
    expect(result.proxy).toBe("http://127.0.0.1:7890");
    // 提示里必须写「仅本次」与长期方案，避免用户以为已经固化了
    expect(result.notes.join(" ")).toContain("仅本次");
    expect(result.notes.join(" ")).toContain("xzh vpn");
  });

  it("直连不通也找不到代理：明确报不可用，并指向 xzh vpn", async () => {
    const result = await ensureBtcNetwork({
      config: asConfig(),
      probeDirect: async () => false,
      detectProxy: async () => null,
      force: true,
    });

    expect(result.mode).toBe("none");
    expect(result.notes.join(" ")).toContain("xzh vpn");
  });

  it("进程内只探测一次（后端与工具调用共用结论）", async () => {
    const probe = vi.fn(async () => true);

    const first = await ensureBtcNetwork({
      config: asConfig(),
      probeDirect: probe,
      detectProxy: async () => null,
    });
    const second = await ensureBtcNetwork({
      config: asConfig(),
      probeDirect: probe,
      detectProxy: async () => null,
    });

    expect(first.mode).toBe("direct");
    expect(second.mode).toBe("direct");
    expect(second.cached).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

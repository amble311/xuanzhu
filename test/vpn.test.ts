import { describe, expect, it } from "vitest";
import { maskProxyUrl } from "../src/config/store";
import { buildSystemPrompt } from "../src/core/prompt";
import {
  normalizeProxyUrl,
  probeProxy,
  splitProxyCredentials,
} from "../src/network/proxy";

describe("xzh vpn 配置", () => {
  it("规范化 HTTP 代理地址", () => {
    expect(normalizeProxyUrl("http://127.0.0.1:10809")).toBe(
      "http://127.0.0.1:10809",
    );
    expect(normalizeProxyUrl(" https://proxy.local:8443/ ")).toBe(
      "https://proxy.local:8443",
    );
  });

  it("接受 SOCKS5 地址，拒绝其他协议", () => {
    expect(normalizeProxyUrl("socks5h://127.0.0.1:10808")).toBe(
      "socks5h://127.0.0.1:10808",
    );
    expect(() => normalizeProxyUrl("ftp://127.0.0.1:21")).toThrow(/只支持/);
  });

  it("代理认证从地址里拆出，config 不保存密码", () => {
    expect(
      splitProxyCredentials("http://user:p%40ss@127.0.0.1:10809"),
    ).toEqual({
      proxy: "http://127.0.0.1:10809",
      auth: "user:p@ss",
    });
    expect(splitProxyCredentials("socks5h://127.0.0.1:10808")).toEqual({
      proxy: "socks5h://127.0.0.1:10808",
      auth: undefined,
    });
  });

  it("展示时隐藏代理密码", () => {
    expect(maskProxyUrl("http://user:pass@127.0.0.1:10809")).toBe(
      "http://***:***@127.0.0.1:10809",
    );
  });

  it("非法地址立即失败，不发起连接", async () => {
    const result = await probeProxy("not-a-url");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("格式无效");
  });

  it("代理可用时系统提示词明确要求跳过 v2ray 技能", () => {
    const prompt = buildSystemPrompt(
      "/tmp/project",
      undefined,
      null,
      null,
      undefined,
      false,
      false,
      null,
      4_000,
      true,
    );
    expect(prompt).toContain("全局代理（已配置）");
    expect(prompt).toContain("不要 load_skill v2ray");
  });
});

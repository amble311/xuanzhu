import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  credentialPromptSkipped,
  credentialsPath,
  deleteCredential,
  getCredential,
  hasCredential,
  listCredentials,
  maskKey,
  saveCredential,
  setCredentialPromptSkipped,
} from "../src/btc/credentials";
import { listSecrets } from "../src/secrets/vault";

/**
 * 凭据层：索引在 `XZH_BTC_HOME`，密文在 `XZH_HOME/vault`（复用全局加密库）。
 * 两个目录都重定向到临时目录，避免污染本机真实配置。
 */
describe("交易所凭据", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-cred-"));
  const savedHome = process.env.XZH_HOME;
  const savedBtcHome = process.env.XZH_BTC_HOME;

  beforeAll(() => {
    process.env.XZH_HOME = path.join(root, "xzh");
    process.env.XZH_BTC_HOME = path.join(root, "btc");
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.XZH_HOME;
    else process.env.XZH_HOME = savedHome;
    if (savedBtcHome === undefined) delete process.env.XZH_BTC_HOME;
    else process.env.XZH_BTC_HOME = savedBtcHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("保存后能读回明文、列表里只有掩码", () => {
    const summary = saveCredential({
      platform: "binance",
      apiKey: "abcd1234efgh5678",
      apiSecret: "secret-abcdef-123456",
      label: "主账号",
    });

    expect(summary.platformLabel).toContain("币安");
    expect(summary.apiKeyMasked).toBe("abcd…5678");
    expect(hasCredential("binance")).toBe(true);

    const secret = getCredential("binance");
    expect(secret?.apiKey).toBe("abcd1234efgh5678");
    expect(secret?.apiSecret).toBe("secret-abcdef-123456");

    // 索引文件里不能出现明文
    const raw = fs.readFileSync(credentialsPath(), "utf8");
    expect(raw).not.toContain("abcd1234efgh5678");
    expect(raw).not.toContain("secret-abcdef-123456");
    expect(raw).toContain("主账号");
  });

  it("更新时清掉旧的密文条目，不留下能被解密的旧 key", () => {
    const before = listSecrets().length;
    saveCredential({
      platform: "binance",
      apiKey: "newkey-1111-2222",
      apiSecret: "newsecret-3333-4444",
      label: "备用",
    });

    expect(getCredential("binance")?.apiKey).toBe("newkey-1111-2222");
    const after = listSecrets();
    expect(after.length).toBe(before);
    // 旧值已经不在密文库中
    expect(after.some((item) => item.label.includes("主账号"))).toBe(false);
  });

  it("删除后索引与密文都不残留", () => {
    const countBefore = listSecrets().length;
    expect(deleteCredential("binance")).toBe(true);
    expect(hasCredential("binance")).toBe(false);
    expect(listCredentials()).toEqual([]);
    expect(getCredential("binance")).toBeNull();
    expect(listSecrets().length).toBe(countBefore - 2);
  });

  it("「跳过」标记会持久化，配置成功后自动清除", () => {
    setCredentialPromptSkipped(true);
    expect(credentialPromptSkipped()).toBe(true);

    saveCredential({
      platform: "binance",
      apiKey: "again-1234-5678",
      apiSecret: "again-secret-9999",
    });
    expect(credentialPromptSkipped()).toBe(false);
  });

  it("掩码不会泄露长度之外的信息", () => {
    expect(maskKey("short")).toBe("*****");
    expect(maskKey("1234567890")).toBe("1234…7890");
  });

  it("拒绝不完整或未支持的平台", () => {
    expect(() =>
      saveCredential({ platform: "binance", apiKey: "short", apiSecret: "x".repeat(10) }),
    ).toThrow(/API Key/);
    expect(() =>
      saveCredential({
        platform: "okx",
        apiKey: "12345678",
        apiSecret: "12345678",
      }),
    ).toThrow(/未支持/);
  });
});

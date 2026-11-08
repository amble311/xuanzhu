import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitChunks } from "../src/gateway/weixin/channel";
import {
  clearAccount,
  loadAccount,
  loadContextTokens,
  loadSyncBuf,
  saveAccount,
  saveContextTokens,
  saveSyncBuf,
  weixinAccountFile,
} from "../src/gateway/weixin/paths";

describe("微信频道", () => {
  let home: string;
  const origin = process.env.XZH_GATEWAY_HOME;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-wx-"));
    process.env.XZH_GATEWAY_HOME = home;
  });

  afterEach(() => {
    if (origin === undefined) delete process.env.XZH_GATEWAY_HOME;
    else process.env.XZH_GATEWAY_HOME = origin;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("账号落盘并带 0600 权限，logout 清干净", () => {
    saveAccount(
      {
        accountId: "a5ace6fd482e@im.bot",
        token: "secret-token",
        baseUrl: "https://ilinkai.weixin.qq.com",
        userId: "wxid_me",
        savedAt: new Date().toISOString(),
      },
      home,
    );
    const loaded = loadAccount(home);
    expect(loaded?.accountId).toBe("a5ace6fd482e@im.bot");
    // token 在文件里，权限必须是 0600（同机其他用户不能读）
    const mode = fs.statSync(weixinAccountFile(home)).mode & 0o777;
    expect(mode).toBe(0o600);

    saveSyncBuf("buf-1", home);
    expect(loadSyncBuf(home)).toBe("buf-1");
    saveContextTokens({ wxid_a: "ctx-1" }, home);
    expect(loadContextTokens(home)).toEqual({ wxid_a: "ctx-1" });

    clearAccount(home);
    expect(loadAccount(home)).toBeNull();
    expect(loadSyncBuf(home)).toBe("");
    expect(loadContextTokens(home)).toEqual({});
  });

  it("回复按行分块：短消息不切，超长切成多块且不丢内容", () => {
    expect(splitChunks("")).toEqual([]);
    expect(splitChunks("你好")).toEqual(["你好"]);

    const lines = Array.from({ length: 200 }, (_, i) => `第 ${i} 行，内容大概二十来个字符`);
    const chunks = splitChunks(lines.join("\n"));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1_500);
    // 拼回去要把每行都带上（切块不能吃内容）
    const joined = chunks.join("\n");
    for (const line of lines) expect(joined).toContain(line);
  });

  it("超长单行硬切（否则一条消息会被 iLink 拒）", () => {
    const chunks = splitChunks("x".repeat(4_000));
    expect(chunks.length).toBe(3);
    expect(chunks.every((chunk) => chunk.length <= 1_500)).toBe(true);
  });
});

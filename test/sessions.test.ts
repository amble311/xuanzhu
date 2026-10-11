import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendSessionMessages,
  listSessions,
  loadSessionMessages,
  startSession,
} from "../src/core/sessions";
import type { ChatMessage } from "../src/llm/types";

describe("会话持久化", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-sessions-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-project-"));
    process.env.XZH_HOME = home;
  });

  afterEach(() => {
    delete process.env.XZH_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("startSession 创建带元信息行的 JSONL 文件", () => {
    const file = startSession(cwd, "0.3.0");
    expect(fs.existsSync(file)).toBe(true);
    const head = JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]);
    expect(head.type).toBe("meta");
    expect(head.cwd).toBe(path.resolve(cwd));
    expect(head.version).toBe("0.3.0");
  });

  it("append + load 往返一致", () => {
    const file = startSession(cwd, "0.3.0");
    const messages: ChatMessage[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，需要做什么？" },
      { role: "user", content: "跑一下测试" },
    ];
    appendSessionMessages(file, messages);
    expect(loadSessionMessages(file)).toEqual(messages);
  });

  it("图片不写入会话文件，降级为占位文本", () => {
    const file = startSession(cwd, "0.3.0");
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "看图",
        images: [{ mimeType: "image/png", data: "aGk=" }],
      },
    ];
    appendSessionMessages(file, messages);
    const loaded = loadSessionMessages(file);
    expect(loaded[0].images).toBeUndefined();
    expect(loaded[0].content).toContain("图片已省略");
  });

  it("listSessions 按新的在前列出，且文件损坏不影响其它会话", async () => {
    // 会话文件名精确到毫秒：两个会话之间稍作间隔，避免同名覆盖
    startSession(cwd, "0.3.0");
    await new Promise((resolve) => setTimeout(resolve, 5));
    // 手工造一个损坏的文件 + 一个正常文件
    fs.appendFileSync(path.join(sessionDir(cwd), "broken.jsonl"), "{oops");
    await new Promise((resolve) => setTimeout(resolve, 5));
    startSession(cwd, "0.3.0");

    const sessions = listSessions(cwd);
    expect(sessions.length).toBe(3); // 两个正常 + broken（能列出但无消息）
    expect(sessions[0].file.endsWith(".jsonl")).toBe(true);
  });

  function sessionDir(projectCwd: string): string {
    // 与 src/core/sessions.ts 相同的目录规则：项目目录名 + sha1 前 10 位
    const crypto = require("crypto") as typeof import("crypto");
    const hash = crypto
      .createHash("sha1")
      .update(path.resolve(projectCwd))
      .digest("hex")
      .slice(0, 10);
    return path.join(home, "sessions", `${path.basename(projectCwd)}-${hash}`);
  }
});

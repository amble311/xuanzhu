import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { startSession, appendSessionMessages, loadSessionMessages } from "../src/core/sessions";
import {
  estimateMessageTokens,
  keepFromValidStart,
  squeezeStaleToolOutput,
  stripStaleImages,
  trimMessagesToBudget,
} from "../src/llm";
import type { ChatMessage, ImageAttachment } from "../src/llm/types";
import { bashTool } from "../src/tools/bash";
import { editFileTool, writeFileTool } from "../src/tools/filesystem";
import type { ToolContext } from "../src/tools/types";

/**
 * 2026-10-13 bug 审计所修问题的回归测试。
 * 每组用例对应审计报告里的一个编号，注释写明「修复前的行为」。
 *
 * 注：全局目录由 `vitest.config.ts` 重定向到临时目录，这里的会话/备份都写在隔离环境里。
 */

const toolCtx = (cwd: string): ToolContext => ({ cwd, autoApprove: true });
const tmpDir = (prefix: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const user = (content: string, images?: ImageAttachment[]): ChatMessage => ({
  role: "user",
  content,
  ...(images ? { images } : {}),
});
const assistantWithCall = (id: string): ChatMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name: "read_file", arguments: "{}" }],
});
const toolMsg = (content: string): ChatMessage => ({
  role: "tool",
  content,
  toolCallId: "c1",
  name: "read_file",
});
const png = (): ImageAttachment => ({ mimeType: "image/png", data: "AAAA" });

describe("B4：裁剪后不能以 assistant / tool 开头", () => {
  it("keepFromValidStart 丢掉开头的 assistant 与 tool，保留 user 与 system", () => {
    expect(keepFromValidStart([assistantWithCall("c1"), toolMsg("x")])).toEqual([]);
    expect(keepFromValidStart([user("hi"), assistantWithCall("c1")])).toHaveLength(2);
    // 「上一轮已中止」的说明是 system：它常常是窗口里唯一的消息，绝不能被裁掉
    const note: ChatMessage = { role: "system", content: "上一轮已中止" };
    expect(keepFromValidStart([note])).toHaveLength(1);
  });

  it("预算切点落在 assistant(tool_calls) 上时，退回最后一条 user", () => {
    const messages = [
      user("第一问"),
      assistantWithCall("c1"),
      toolMsg("第一次结果"),
      user("第二问"),
      assistantWithCall("c2"),
      toolMsg("第二次结果"),
    ];
    // 预算恰好只够最后两条（assistant + tool）
    const budget =
      estimateMessageTokens(messages[4]) + estimateMessageTokens(messages[5]);
    const kept = trimMessagesToBudget(messages, budget);
    // 修复前：返回 [assistant(tool_calls), tool] —— Anthropic / Gemini 丢掉开头的
    // assistant 后剩一条引用不存在 tool_use_id 的 tool_result → 400
    expect(kept[0].role).toBe("user");
    expect(kept[0].content).toContain("第二问");
  });
});

describe("C7：压缩旧工具输出不能越压越长", () => {
  it("中文内容落在「省略 0 字符」区间时保持原样", () => {
    // 700 个汉字 ≈ 700 token（超过 600 的阈值），且去除头部后剩余 ≤ tailBudget*3
    const cjk = "中".repeat(700);
    const messages = [toolMsg(cjk), ...Array.from({ length: 6 }, () => user("后续"))];
    const squeezed = squeezeStaleToolOutput(messages);
    // 修复前：会拼出「…（此处省略 0 字符的中间内容）…」，比原文还长
    expect(squeezed[0].content).toBe(cjk);
  });

  it("真正超长的 ASCII 输出仍然会被压缩", () => {
    const ascii = "x".repeat(30_000);
    const messages = [toolMsg(ascii), ...Array.from({ length: 6 }, () => user("后续"))];
    const squeezed = squeezeStaleToolOutput(messages);
    expect(squeezed[0].content.length).toBeLessThan(ascii.length);
    expect(squeezed[0].content).toContain("省略");
  });
});

describe("B6：历史里的旧图必须降级", () => {
  it("只有本轮（keepFrom 之后）的图保留原图", () => {
    const messages = [user("上一轮", [png()]), assistantWithCall("c1"), user("本轮", [png()])];
    const stripped = stripStaleImages(messages, 2);
    // 修复前：保留的是「整个数组里最后一张」，历史里的旧图会被无限期每轮重发
    expect(stripped[0].images).toBeUndefined();
    expect(stripped[0].content).toContain("图片已省略");
    expect(stripped[2].images).toHaveLength(1);
  });
});

describe("A1：写入 / 编辑的目标体检", () => {
  it.skipIf(process.platform === "win32")(
    "拒绝设备文件（否则 readFileSync / copyFileSync 会把进程挂死）",
    async () => {
      const cwd = tmpDir("xzh-guard-");
      const written = await writeFileTool.execute(
        { path: "/dev/null", content: "x" },
        toolCtx(cwd),
      );
      expect(written.ok).toBe(false);
      expect(written.content).toContain("不是普通文件");

      const edited = await editFileTool.execute(
        { path: "/dev/null", search: "a", replace: "b" },
        toolCtx(cwd),
      );
      expect(edited.ok).toBe(false);
      expect(edited.content).toContain("不是普通文件");

      fs.rmSync(cwd, { recursive: true, force: true });
    },
  );

  it("普通文件仍可正常写入与编辑", async () => {
    const cwd = tmpDir("xzh-guard-");
    const target = path.join(cwd, "a.txt");
    expect((await writeFileTool.execute({ path: target, content: "hello" }, toolCtx(cwd))).ok).toBe(
      true,
    );
    expect(
      (
        await editFileTool.execute(
          { path: target, search: "hello", replace: "world" },
          toolCtx(cwd),
        )
      ).ok,
    ).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("world");
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("D18：bash 输出截断必须有提示", () => {
  it("超限时把截断说明放在正文最前面", async () => {
    const cwd = tmpDir("xzh-bash-");
    const result = await bashTool.execute(
      { command: `node -e "process.stdout.write('x'.repeat(31000))"`, timeout: 30_000 },
      toolCtx(cwd),
    );
    // 修复前：超限部分被静默丢弃，也没有任何提示 → 模型会误判「执行成功、没有报错」
    expect(result.content.startsWith("[输出被截断]")).toBe(true);
    fs.rmSync(cwd, { recursive: true, force: true });
  }, 30_000);

  it("未超限时没有该提示", async () => {
    const cwd = tmpDir("xzh-bash-");
    const result = await bashTool.execute({ command: "echo hi", timeout: 30_000 }, toolCtx(cwd));
    expect(result.content).toContain("hi");
    expect(result.content).not.toContain("[输出被截断]");
    fs.rmSync(cwd, { recursive: true, force: true });
  }, 30_000);
});

describe("D20：同毫秒开启两个会话不能互相覆盖", () => {
  it("撞名时顺延编号，前一个文件的记录保持完整", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const cwd = tmpDir("xzh-session-");
      const first = startSession(cwd, "test");
      appendSessionMessages(first, [user("第一条记录")]);
      const second = startSession(cwd, "test"); // 同一毫秒
      expect(second).not.toBe(first);
      // 修复前两次同名，第二次的 writeFileSync 是截断写 → 第一条记录被整段抹掉
      expect(loadSessionMessages(first).some((m) => m.content === "第一条记录")).toBe(true);
      fs.rmSync(cwd, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

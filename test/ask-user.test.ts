import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type ModelEntry, type XuanZhuConfig } from "../src/config/store";
import type { LLMProvider } from "../src/llm/types";
import { TuiApp } from "../src/tui/app";
import { askUserTool } from "../src/tools/ask";
import type { AskUserAnswer, AskUserRequest } from "../src/tools/types";

/**
 * `ask_user`：把「需要用户决定」从自由文本里的一句问话，变成一次结构化提问。
 *
 * 测试重点在**边界**而不是快乐路径：
 * - 没有界面时必须明确报错，而不是静默返回空答案；
 * - 用户跳过时要告诉模型别再重复问；
 * - 非法选项（1 个 / 太多）要在调用界面之前就拦掉。
 */

const base = { cwd: process.cwd(), autoApprove: true };

const recorder = () => {
  const requests: AskUserRequest[] = [];
  return {
    requests,
    askUser: async (request: AskUserRequest) => {
      requests.push(request);
      return { answer: "选项 B" };
    },
  };
};

describe("ask_user 工具", () => {
  it("没有注入提问出口时明确报错", async () => {
    const result = await askUserTool.execute(
      { question: "用哪个目录？" },
      { ...base },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("不支持向用户提问");
  });

  it("把问题与选项原样交给界面，并返回用户的答案", async () => {
    const rec = recorder();
    const result = await askUserTool.execute(
      {
        question: "覆盖还是新建？",
        options: ["覆盖", "选项 B"],
        detail: "目标文件已存在",
      },
      { ...base, askUser: rec.askUser },
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("用户回答：选项 B");
    expect(rec.requests[0]).toEqual({
      question: "覆盖还是新建？",
      options: ["覆盖", "选项 B"],
      detail: "目标文件已存在",
    });
  });

  it("用户跳过时返回失败并提示不要重复提问", async () => {
    const result = await askUserTool.execute(
      { question: "用哪个 token？" },
      {
        ...base,
        askUser: async () => ({ cancelled: true }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("不要重复提问");
  });

  it("只有一个候选时直接拒绝（应当自己执行）", async () => {
    const rec = recorder();
    const result = await askUserTool.execute(
      { question: "继续？", options: ["继续"] },
      { ...base, askUser: rec.askUser },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("至少要有 2 个选项");
    expect(rec.requests).toHaveLength(0);
  });

  it("选项过多时截断到 4 个", async () => {
    const rec = recorder();
    await askUserTool.execute(
      {
        question: "选一个",
        options: ["a", "b", "c", "d", "e", "f"],
      },
      { ...base, askUser: rec.askUser },
    );
    expect(rec.requests[0].options).toHaveLength(4);
  });

  it("空问题被拒绝", async () => {
    const result = await askUserTool.execute(
      { question: "   " },
      { ...base, askUser: recorder().askUser },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("question 不能为空");
  });
});

/**
 * 界面浮层：这里直接驱动 TuiApp 的按键处理，验证三种回答路径
 * （数字直选 / 回车提交文本 / Esc 跳过）都能让 await 的 Promise 落地 ——
 * 否则模型那边会一直挂着，表现为「界面没反应」。
 */
describe("ask_user 的界面浮层", () => {
  const model: ModelEntry = {
    id: "fake/fake",
    provider: "fake",
    model: "fake",
    contextWindow: 100000,
  };
  const config = (): XuanZhuConfig => ({
    ...DEFAULT_CONFIG,
    provider: "fake",
    model: "fake",
    models: [model],
  });
  const llm: LLMProvider = {
    id: "fake",
    model: "fake",
    async *chat() {
      yield { type: "done", finishReason: "stop" };
    },
  };

  const makeApp = () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-ask-"));
    const app = new TuiApp({
      provider: llm,
      config: config(),
      cwd,
      providerLabel: "fake",
      model: "fake",
      autoApprove: true,
    });
    return app as unknown as {
      requestAsk(request: AskUserRequest): Promise<AskUserAnswer>;
      handleKey(key: string): void;
      lines: string[];
      exited: boolean;
    };
  };

  it("有选项时数字键直选", async () => {
    const app = makeApp();
    const answer = app.requestAsk({
      question: "覆盖还是新建？",
      options: ["覆盖", "新建"],
    });
    app.handleKey("2");
    expect(await answer).toEqual({ answer: "新建" });
    app.exited = true;
  });

  it("无选项时输入文本并回车提交", async () => {
    const app = makeApp();
    const answer = app.requestAsk({ question: "套餐 ID 是多少？" });
    for (const key of ["a", "b", "1"]) app.handleKey(key);
    app.handleKey("\x7f"); // 退格删掉 1
    app.handleKey("\r");
    expect(await answer).toEqual({ answer: "ab" });
    // 问答都要留在输出区，否则回看时不知道模型为什么那样做
    const plain = app.lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("套餐 ID 是多少？");
    expect(plain).toContain("→ ab");
    app.exited = true;
  });

  it("Esc 跳过时返回 cancelled", async () => {
    const app = makeApp();
    const answer = app.requestAsk({ question: "用哪个目录？" });
    app.handleKey("\x1b");
    expect(await answer).toEqual({ cancelled: true });
    app.exited = true;
  });
});

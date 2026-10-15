import { describe, expect, it } from "vitest";
import { modelId, type ModelEntry } from "../src/config/store";
import { resolveModelChoice, selectWindow } from "../src/tui/app";

/**
 * 会话内 `/model` 的界面部分里**能脱离终端测**的两块：
 * 参数解析（`resolveModelChoice`）与单选列表的可视窗口（`selectWindow`）。
 *
 * TUI 本体没有可跑的测试环境（它常驻 raw 模式、自己管屏幕），所以把这两段
 * 最容易写错的逻辑做成纯函数再测 —— 剩下的就是渲染，靠实际跑起来看。
 */

const entry = (provider: string, model: string): ModelEntry => ({
  id: modelId(provider, model),
  provider,
  model,
});

const a = entry("ollama", "llama3");
const b = entry("ollama", "qwen2.5-coder");
const c = entry("deepseek", "deepseek-chat");

describe("/model 的参数解析", () => {
  it("纯数字按序号（从 1 开始）", () => {
    const entries = [a, b, c];
    expect(resolveModelChoice(entries, "1")?.id).toBe(a.id);
    expect(resolveModelChoice(entries, "3")?.id).toBe(c.id);
    // 前后空格来自「/model   2」这种多空格的输入
    expect(resolveModelChoice(entries, " 2 ")?.id).toBe(b.id);
  });

  it("按 id 或模型名匹配，大小写不敏感", () => {
    const entries = [a, b];
    expect(resolveModelChoice(entries, b.id)?.id).toBe(b.id);
    expect(resolveModelChoice(entries, "qwen2.5-coder")?.id).toBe(b.id);
    expect(resolveModelChoice(entries, "OLLAMA/QWEN2.5-CODER")?.id).toBe(b.id);
  });

  it("越界序号与不存在的名字都落空（不能「随便给一个」）", () => {
    const entries = [a, b];
    expect(resolveModelChoice(entries, "0")).toBeUndefined();
    expect(resolveModelChoice(entries, "9")).toBeUndefined();
    expect(resolveModelChoice(entries, "gpt-4o")).toBeUndefined();
    expect(resolveModelChoice([], "1")).toBeUndefined();
  });

  it("以数字开头的模型名不会被当成序号", () => {
    const numeric = entry("glm", "4o-mini");
    // 只有**纯数字**才算序号，否则 parseInt("4o-mini") 会把它误判成第 4 个
    expect(resolveModelChoice([numeric], "4o-mini")?.id).toBe(numeric.id);
    expect(resolveModelChoice([numeric], "4")).toBeUndefined();
  });
});

describe("单选列表的可视窗口", () => {
  it("选项不超过上限时全部显示", () => {
    expect(selectWindow(3, 0, 10)).toEqual({ start: 0, end: 3 });
    expect(selectWindow(0, 0, 10)).toEqual({ start: 0, end: 0 });
  });

  it("高亮项始终落在窗口内", () => {
    for (const index of [0, 1, 5, 24]) {
      const { start, end } = selectWindow(25, index, 10);
      expect(index).toBeGreaterThanOrEqual(start);
      expect(index).toBeLessThan(end);
    }
  });

  it("顶部/底部对齐：首项不空窗、末项不超出", () => {
    expect(selectWindow(25, 0, 10)).toEqual({ start: 0, end: 10 });
    expect(selectWindow(25, 24, 10)).toEqual({ start: 15, end: 25 });
  });
});

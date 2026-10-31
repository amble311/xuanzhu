import { describe, expect, it } from "vitest";
import { composeHeaderBlocks } from "../src/tui/header-layout";
import { formatLineDiff } from "../src/utils/diff";

/** TUI 顶部顺序：品牌 → 目录 → 目标 → 快捷键 → 任务；模型不在顶部。 */
describe("TUI 顶部布局", () => {
  it("任务列表排在快捷键之后", () => {
    const lines = composeHeaderBlocks({
      brand: "玄猪 XuanZhu",
      directory: "目录：/tmp/project",
      shortcuts: ["输入 /help", "Ctrl+D 结束", "Shift+Tab 切终端"],
      todos: ["任务 1/3", "▸ 正在做"],
    });
    expect(lines).toEqual([
      "玄猪 XuanZhu",
      "目录：/tmp/project",
      "输入 /help",
      "Ctrl+D 结束",
      "Shift+Tab 切终端",
      "任务 1/3",
      "▸ 正在做",
    ]);
    expect(lines.some((line) => line.includes("模型"))).toBe(false);
  });

  it("目标行在快捷键之前", () => {
    const lines = composeHeaderBlocks({
      brand: "brand",
      directory: "dir",
      goal: "目标：重构",
      shortcuts: ["hint"],
      todos: ["todo"],
    });
    expect(lines).toEqual(["brand", "dir", "目标：重构", "hint", "todo"]);
  });
});

describe("行级 diff", () => {
  it("只展示变化行与少量上下文", () => {
    const diff = formatLineDiff(
      "a\nb\nc\nd\ne",
      "a\nb\nC\nd\ne",
    );
    expect(diff).toContain("-c");
    expect(diff).toContain("+C");
  });

  it("相同内容返回空字符串", () => {
    expect(formatLineDiff("same", "same")).toBe("");
  });
});

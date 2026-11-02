import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  defaultPartText,
  OVERRIDABLE_PARTS,
  promptDefaultsHash,
  resolvePromptOverrides,
} from "../src/core/prompt";

/**
 * 系统提示词分片：
 * - 默认组装结果与分段前语义一致（各段标题都在）；
 * - 覆盖只影响那一段，其余继续用内置文本；
 * - 空串表示删掉该段；
 * - 未知 key 被忽略（配置文件可能被手改过）；
 * - 自治等级段落由代码生成，不能覆盖，且排在最后（保住前缀缓存）。
 */

const base = (options?: Parameters<typeof buildSystemPrompt>[10]) =>
  buildSystemPrompt("/tmp/demo", undefined, null, null, undefined, false, false, null, 4000, false, options);

describe("提示词分片", () => {
  it("默认组装包含全部固定段落", () => {
    const prompt = base();
    expect(prompt).toContain("你是「玄猪」");
    expect(prompt).toContain("## 核心原则");
    expect(prompt).toContain("## 工具使用规范");
    expect(prompt).toContain("## 技能（Skills）");
    expect(prompt).toContain("## 内容可信边界（必须遵守）");
    expect(prompt).toContain("## 输出风格");
    expect(prompt).toContain("## 项目记忆");
    expect(prompt).toContain("## 全局记忆（跨项目）");
  });

  it("覆盖某段只替换那一段，其余保持内置", () => {
    const prompt = base({
      overrides: { core: "## 核心原则\n只做一件事：先读后改。" },
    });
    expect(prompt).toContain("只做一件事：先读后改。");
    // 内置核心原则的独有句子应消失，其他段落不受影响
    expect(prompt).not.toContain("善用子代理隔离上下文");
    expect(prompt).toContain("## 工具使用规范");
    expect(prompt).toContain("## 输出风格");
  });

  it("空串表示删掉该段", () => {
    const prompt = base({ overrides: { output: "" } });
    expect(prompt).not.toContain("## 输出风格");
    expect(prompt).toContain("## 核心原则");
  });

  it("未知 key 被忽略而不是让组装失败", () => {
    const { overrides, unknown } = resolvePromptOverrides({
      core: "x",
      "not-a-part": "y",
    });
    expect(unknown).toEqual(["not-a-part"]);
    expect(overrides.core).toBe("x");
    const prompt = base({ overrides: { "not-a-part": "y" } });
    expect(prompt).toContain("## 核心原则");
  });

  it("每个可覆盖段落都有非空内置文本（device 按已连接计算）", () => {
    for (const part of OVERRIDABLE_PARTS) {
      expect(defaultPartText(part.key).length).toBeGreaterThan(0);
    }
  });

  it("内置指纹稳定，且不同段落文本会影响它", () => {
    const first = promptDefaultsHash();
    expect(promptDefaultsHash()).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it("自治等级段落由代码生成、排在最后，且不可覆盖", () => {
    const prompt = base({
      autonomy: "observe",
      overrides: { core: "## 核心原则\n精简版。" },
    });
    expect(prompt).toContain("## 自治等级：observe");
    // 覆盖 core 不会影响这段
    expect(prompt).toContain("写文件、执行命令、操作手机都会被代码拦截");
    // 最后一段就是它（前缀稳定才能命中 prompt cache）
    expect(prompt.trimEnd().endsWith("让用户用 `/autonomy auto` 切换。")).toBe(true);
  });

  it("auto 档不产生额外段落", () => {
    const prompt = base({ autonomy: "auto" });
    expect(prompt).not.toContain("## 自治等级");
  });
});

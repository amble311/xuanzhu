import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  activeModelEntry,
  effectiveModels,
  modelId,
  nextModelAfter,
  rememberModel,
  removeModel,
  upsertModel,
  type ModelEntry,
  type XuanZhuConfig,
} from "../src/config/store";
import { getConfigDir } from "../src/utils/paths";

/**
 * 多模型策略：**默认用上次用过的那个**，它调用失败时**按列表顺序回退到下一个**，
 * 直到所有模型都试过（`tried` 覆盖全表）才放弃。列表顺序即优先级，没有权重。
 */

const entry = (provider: string, model: string): ModelEntry => ({
  id: modelId(provider, model),
  provider,
  model,
});

/** 造一份配置：models 为列表顺序，active 为「上次用过的」 */
const configOf = (models: ModelEntry[], active?: ModelEntry): XuanZhuConfig => ({
  ...DEFAULT_CONFIG,
  provider: active ? active.provider : "",
  model: active ? active.model : "",
  models: models.map((m) => ({ ...m })),
});

const a = entry("deepseek", "deepseek-chat");
const b = entry("glm", "glm-4-plus");
const c = entry("ollama", "llama3");

describe("测试环境", () => {
  it("全局目录已隔离到临时目录（否则测试会覆盖用户真实的 ~/.xzh/config.json）", () => {
    // Agent 回退时会 saveConfig() 写盘；没有 vitest.config.ts 的 XZH_HOME 重定向，
    // 合成的测试配置就会落到真实路径上（历史上出过两次事故）。
    expect(process.env.XZH_HOME).toBeTruthy();
    expect(getConfigDir()).toBe(process.env.XZH_HOME);
  });
});

describe("默认使用上次用过的模型", () => {
  it("取 config.provider / config.model 指向的那个", () => {
    expect(activeModelEntry(configOf([a, b, c], b))?.id).toBe(b.id);
  });

  it("上次那个已不在列表里（被删）→ 退回列表第一项", () => {
    const stale = entry("openai", "gpt-4o");
    expect(activeModelEntry(configOf([a, b], stale))?.id).toBe(a.id);
  });

  it("一个模型都没有 → null", () => {
    expect(activeModelEntry(configOf([]))).toBeNull();
  });

  it("rememberModel 记住切换后的模型（含 providers[*].model）", () => {
    const cfg = configOf([a, b], a);
    rememberModel(cfg, b);
    expect(cfg.provider).toBe(b.provider);
    expect(cfg.model).toBe(b.model);
    expect(cfg.providers[b.provider]?.model).toBe(b.model);
    // 记住之后，下次启动（activeModelEntry）直接用 b
    expect(activeModelEntry(cfg)?.id).toBe(b.id);
  });
});

describe("失败后按列表顺序回退", () => {
  it("向后找下一个，走到末尾会绕回表头", () => {
    const cfg = configOf([a, b, c], a);
    expect(nextModelAfter(cfg, a.id)?.id).toBe(b.id);
    expect(nextModelAfter(cfg, b.id)?.id).toBe(c.id);
    expect(nextModelAfter(cfg, c.id)?.id).toBe(a.id); // 环形
  });

  it("跳过本次请求已试过的；全部试过 → null", () => {
    const cfg = configOf([a, b, c], a);
    expect(nextModelAfter(cfg, b.id, [a.id, b.id])?.id).toBe(c.id);
    expect(nextModelAfter(cfg, c.id, [a.id, b.id, c.id])).toBeNull();
  });

  it("单模型：没有下一个（不会切到自己）", () => {
    expect(nextModelAfter(configOf([a], a), a.id)).toBeNull();
    expect(nextModelAfter(configOf([a], a), a.id, [a.id])).toBeNull();
  });

  it("找不到当前模型时从表头开始找", () => {
    const cfg = configOf([a, b], a);
    expect(nextModelAfter(cfg, "ghost/none")?.id).toBe(a.id);
  });
});

describe("列表顺序即优先级（不再有权重排序）", () => {
  it("effectiveModels 保持配置顺序", () => {
    const cfg = configOf([c, a, b]);
    expect(effectiveModels(cfg).map((m) => m.id)).toEqual([c.id, a.id, b.id]);
    expect(activeModelEntry(cfg)?.id).toBe(c.id);
  });

  it("新增模型追加到末尾（成为最后一道回退）", () => {
    const cfg = configOf([c, a]);
    expect(upsertModel(cfg, { provider: "qwen", model: "qwen-max" }).id).toBe(
      "qwen/qwen-max",
    );
    expect(cfg.models.map((m) => m.id)).toEqual([
      c.id,
      a.id,
      "qwen/qwen-max",
    ]);
  });
});

describe("删除模型时维护「当前使用」的指针", () => {
  it("删掉的正是当前使用的 → 指针切到剩下的第一项", () => {
    const cfg = configOf([a, b, c], a);
    removeModel(cfg, a.id);
    expect(cfg.models.map((m) => m.id)).toEqual([b.id, c.id]);
    expect(cfg.provider).toBe(b.provider);
    expect(cfg.model).toBe(b.model);
    expect(activeModelEntry(cfg)?.id).toBe(b.id);
  });

  it("删掉最后一个 → 指针清空，且不会「复活」", () => {
    const cfg = configOf([a], a);
    removeModel(cfg, a.id);
    expect(cfg.models).toHaveLength(0);
    expect(cfg.provider).toBe("");
    expect(cfg.model).toBe("");
    expect(activeModelEntry(cfg)).toBeNull();
  });

  it("删掉非当前的模型不动指针", () => {
    const cfg = configOf([a, b], a);
    removeModel(cfg, b.id);
    expect(cfg.model).toBe(a.model);
    expect(activeModelEntry(cfg)?.id).toBe(a.id);
  });
});

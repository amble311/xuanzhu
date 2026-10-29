import { describe, expect, it } from "vitest";
import {
  activeModelEntry,
  DEFAULT_CONFIG,
  findModelIndex,
  modelDisplayName,
  setModelAlias,
  setModelBaseUrl,
  setModelModelId,
  upsertModel,
  type XuanZhuConfig,
} from "../src/config/store";
import { resolveModelChoice } from "../src/tui/app";

/**
 * 自定义模型别名、baseUrl 与模型 ID 修改。
 */

const emptyConfig = (): XuanZhuConfig => ({
  ...DEFAULT_CONFIG,
  provider: "",
  model: "",
  models: [],
});

describe("模型别名", () => {
  it("alias 用于展示，真实 model 仍可切换/解析", () => {
    const cfg = emptyConfig();
    const entry = upsertModel(cfg, {
      provider: "custom",
      model: "qwen3.6-35b",
      alias: "本地 Qwen",
      baseUrl: "http://127.0.0.1:8181/v1",
    });
    cfg.provider = entry.provider;
    cfg.model = entry.model;

    expect(entry.id).toBe("custom/qwen3.6-35b");
    expect(modelDisplayName(entry)).toBe("本地 Qwen");
    expect(activeModelEntry(cfg)?.id).toBe(entry.id);

    // 别名也可以参与 /model 的解析
    expect(resolveModelChoice([entry], "本地 Qwen")?.id).toBe(entry.id);
    expect(findModelIndex(cfg.models, "本地 Qwen")).toBe(0);

    // 清空 alias 后回退显示真实模型 ID
    expect(setModelAlias(cfg, entry.id, "")?.alias).toBeUndefined();
    expect(modelDisplayName(entry)).toBe("qwen3.6-35b");
  });

  it("可单独修改 baseUrl 与模型 ID，并同步当前模型", () => {
    const cfg = emptyConfig();
    const entry = upsertModel(cfg, {
      provider: "custom",
      model: "old-model",
      alias: "A",
      baseUrl: "http://old/v1",
    });
    cfg.provider = entry.provider;
    cfg.model = entry.model;

    setModelBaseUrl(cfg, entry.id, "http://new/v1");
    expect(entry.baseUrl).toBe("http://new/v1");

    const changed = setModelModelId(cfg, entry.id, "new-model");
    expect(changed.error).toBeUndefined();
    expect(changed.entry?.id).toBe("custom/new-model");
    expect(changed.entry?.model).toBe("new-model");
    // 当前使用指针跟着模型 ID 一起更新
    expect(cfg.model).toBe("new-model");
    expect(activeModelEntry(cfg)?.id).toBe("custom/new-model");
    // alias 不随模型 ID 变化
    expect(changed.entry?.alias).toBe("A");
  });

  it("模型 ID 冲突时拒绝修改", () => {
    const cfg = emptyConfig();
    const a = upsertModel(cfg, { provider: "custom", model: "a" });
    upsertModel(cfg, { provider: "custom", model: "b" });

    const result = setModelModelId(cfg, a.id, "b");
    expect(result.error).toContain("已存在");
    expect(a.model).toBe("a");
    expect(a.id).toBe("custom/a");
  });
});

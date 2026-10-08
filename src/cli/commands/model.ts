import {
  DEFAULT_MODEL_WEIGHT,
  effectiveModels,
  loadConfig,
  materializeModels,
  modelId,
  pickModel,
  removeModel,
  resetModelWeights,
  saveConfig,
  setModelWeight,
  upsertModel,
  type ModelEntry,
  type XuanZhuConfig,
} from "../../config/store";
import {
  DEFAULT_CONTEXT_WINDOW,
  findProvider,
  formatContextWindow,
  inferContextWindow,
  PROVIDERS,
  resolveApiKey,
} from "../../llm";
import { ansi } from "../../utils/ansi";
import { getConfigPath } from "../../utils/paths";
import { promptConfirm, promptInput, promptSelect } from "../prompt";

/**
 * `xzh model`                    交互式管理多个模型（新增 / 删除 / 调整权重 / 查看全部）
 * `xzh model list`               列出**已配置**的模型与权重
 * `xzh model all`                列出**所有内置可用**的模型（按服务商分组）
 * `xzh model add <provider> <model> [权重]`
 * `xzh model remove <id|序号>`   删除模型
 * `xzh model weight <id|序号> <权重>`
 *
 * 兼容旧用法：`xzh model <provider> [model]` 等价于 `add`。
 */
export async function modelCommand(args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case undefined:
      return interactiveMenu();
    case "list":
    case "ls":
      return listModels();
    case "all":
    case "available":
    case "providers":
      return listAvailableModels();
    case "add":
      return addModel(args.slice(1));
    case "remove":
    case "rm":
    case "delete":
      return removeModelCommand(args.slice(1));
    case "weight":
    case "w":
      return setWeightCommand(args.slice(1));
    case "context":
    case "ctx":
      return setContextCommand(args.slice(1));
    case "reset":
      return resetWeights();
    case "help":
    case "-h":
    case "--help":
      return printModelHelp();
    default:
      // 旧用法：xzh model <provider> [model]
      return addModel(args);
  }
}

// ------------------------------------------------------------------ 子命令

/** 新增模型（provider / model 缺省时交互选择） */
async function addModel(args: string[]): Promise<void> {
  const config = loadConfig();
  // 先物化模型列表：下面会改写 config.provider / config.model，
  // 若不先固定，兼容回退会把「新模型名」当成已有列表，导致旧模型被覆盖丢失。
  const existingModels = materializeModels(config);

  const providerId = args[0] ?? (await chooseProvider());
  // 在服务商列表里选了「返回」：静默回到菜单，不报错
  if (!providerId) {
    process.stdout.write(`${ansi.gray}已取消。${ansi.reset}\n`);
    return;
  }
  const meta = findProvider(providerId);
  if (!meta) {
    process.stdout.write(
      `${ansi.red}未知的 provider：${providerId}${ansi.reset}\n` +
        `${ansi.gray}可用：${PROVIDERS.map((p) => p.id).join(", ")}${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const model = args[1] ?? (await chooseModel(meta.id, meta.models, config));
  // 在模型列表里选了「返回」
  if (!model) {
    process.stdout.write(`${ansi.gray}已取消。${ansi.reset}\n`);
    return;
  }
  const weightText = args[2];
  let weight: number | undefined;
  if (weightText !== undefined) {
    // 严格解析：`parseInt("5abc")` 会得到 5，静默接受明显错误的输入
    const parsed = /^\d+$/.test(weightText.trim())
      ? Number.parseInt(weightText.trim(), 10)
      : Number.NaN;
    if (Number.isNaN(parsed) || parsed < 0) {
      process.stdout.write(
        `${ansi.red}权重必须是 ≥ 0 的整数：${weightText}${ansi.reset}\n`,
      );
      process.exitCode = 1;
      return;
    }
    weight = parsed;
  }

  const baseUrl = await chooseBaseUrl(meta.id, meta.requiresBaseUrl === true, config);
  const apiKey = await chooseApiKey(meta.id, meta.envKey, config);
  const contextWindow = await chooseContextWindow(model, args[3]);

  // provider 级设置（API Key / baseUrl / 最近使用的 model）
  config.providers = {
    ...config.providers,
    [meta.id]: {
      ...(config.providers[meta.id] ?? {}),
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    },
  };
  config.provider = meta.id;
  config.model = model;

  const existed = existingModels.some(
    (entry) => entry.id === modelId(meta.id, model),
  );
  const entry = upsertModel(config, {
    provider: meta.id,
    model,
    weight,
    contextWindow,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  });

  saveConfig(config);

  process.stdout.write(
    `\n${ansi.green}✓ ${existed ? "已更新" : "已新增"}模型${ansi.reset} ${ansi.bold}${entry.id}${ansi.reset}\n` +
      `  ${ansi.gray}provider：${ansi.reset}${meta.label}\n` +
      `  ${ansi.gray}model   ：${ansi.reset}${entry.model}\n` +
      `  ${ansi.gray}权重    ：${ansi.reset}${entry.weight}\n` +
      `  ${ansi.gray}上下文  ：${ansi.reset}${formatContextWindow(entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW)} token\n` +
      (baseUrl ? `  ${ansi.gray}baseUrl ：${ansi.reset}${baseUrl}\n` : "") +
      `  ${ansi.gray}配置文件：${ansi.reset}${getConfigPath()}\n`,
  );
  printActiveHint(config);
}

/** 删除模型 */
async function removeModelCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const models = effectiveModels(config);
  if (models.length === 0) {
    process.stdout.write(`${ansi.yellow}尚未配置任何模型。${ansi.reset}\n`);
    return;
  }

  const key = args[0] || (await chooseFromList(models, "选择要删除的模型："));
  if (!key) {
    process.stdout.write(`${ansi.gray}已取消。${ansi.reset}\n`);
    return;
  }
  const id = resolveModelKey(config, key);
  const removed = id ? removeModel(config, id) : null;
  if (!removed) {
    process.stdout.write(
      `${ansi.red}未找到模型：${key}${ansi.reset}\n` +
        `${ansi.gray}提示：可使用 ${ansi.reset}xzh model list${ansi.gray} 查看 id 与序号。${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  syncActiveFields(config);
  saveConfig(config);

  process.stdout.write(
    `\n${ansi.green}✓ 已删除模型${ansi.reset} ${removed.id}\n`,
  );
  printActiveHint(config);
}

/** 调整模型权重 */
async function setWeightCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  let models = effectiveModels(config);
  if (models.length === 0) {
    process.stdout.write(`${ansi.yellow}尚未配置任何模型。${ansi.reset}\n`);
    return;
  }

  const key = args[0] || (await chooseFromList(models, "选择要调整权重的模型："));
  if (!key) {
    process.stdout.write(`${ansi.gray}已取消。${ansi.reset}\n`);
    return;
  }
  const id = resolveModelKey(config, key);
  const target = id ? models.find((entry) => entry.id === id) : undefined;
  if (!target) {
    process.stdout.write(
      `${ansi.red}未找到模型：${key}${ansi.reset}\n` +
        `${ansi.gray}提示：可使用 ${ansi.reset}xzh model list${ansi.gray} 查看 id 与序号。${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const input =
    args[1] ??
    (await promptInput(
      `请输入 ${target.id} 的新权重（0 表示暂不使用）`,
      String(target.weight),
    ));
  // 与 addModel 保持同样的严格解析：`parseInt("5abc")` 会静默得到 5，
  // 而 addModel 用的是 /^\d+$/ 校验，两处标准必须一致
  const trimmedWeight = input.trim();
  const weight = /^\d+$/.test(trimmedWeight) ? Number(trimmedWeight) : Number.NaN;
  if (Number.isNaN(weight)) {
    process.stdout.write(
      `${ansi.red}权重必须是 ≥ 0 的整数：${input}${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const updated = setModelWeight(config, target.id, weight);
  if (!updated) {
    process.stdout.write(`${ansi.red}设置失败：${target.id}${ansi.reset}\n`);
    process.exitCode = 1;
    return;
  }

  syncActiveFields(config);
  saveConfig(config);

  process.stdout.write(
    `\n${ansi.green}✓ 已更新权重${ansi.reset} ${updated.id} → ${updated.weight}\n`,
  );
  printActiveHint(config);
}

/** 调整模型的上下文窗口 */
async function setContextCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const models = effectiveModels(config);
  if (models.length === 0) {
    process.stdout.write(`${ansi.yellow}尚未配置任何模型。${ansi.reset}\n`);
    return;
  }

  const key =
    args[0] || (await chooseFromList(models, "选择要设置上下文窗口的模型："));
  if (!key) {
    process.stdout.write(`${ansi.gray}已取消。${ansi.reset}\n`);
    return;
  }
  const id = resolveModelKey(config, key);
  const target = id ? models.find((entry) => entry.id === id) : undefined;
  if (!target) {
    process.stdout.write(
      `${ansi.red}未找到模型：${key}${ansi.reset}\n` +
        `${ansi.gray}提示：可使用 ${ansi.reset}xzh model list${ansi.gray} 查看 id 与序号。${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const current = target.contextWindow ?? inferContextWindow(target.model);
  const input =
    args[1] ??
    (await promptInput(
      `请输入 ${target.id} 的上下文窗口（token，如 128000）`,
      String(current),
    ));
  const parsed = parseContextWindow(input);
  if (parsed === undefined) {
    process.stdout.write(`${ansi.red}无法识别的窗口大小：${input}${ansi.reset}\n`);
    process.exitCode = 1;
    return;
  }

  // 注意：target 来自 effectiveModels()，那是**浅拷贝**（有意为之，防止调用方误改配置）。
  // 要真正写回必须拿到 config.models 里的原始条目 —— 用 materializeModels()。
  const stored = materializeModels(config).find((entry) => entry.id === target.id);
  if (stored) stored.contextWindow = parsed;
  saveConfig(config);
  process.stdout.write(
    `\n${ansi.green}✓ 已更新上下文窗口${ansi.reset} ${target.id} → ${formatContextWindow(parsed)} token\n`,
  );
}

/** 把全部模型权重恢复为默认值 */
async function resetWeights(): Promise<void> {
  const config = loadConfig();
  const models = effectiveModels(config);
  if (models.length === 0) {
    process.stdout.write(`${ansi.yellow}尚未配置任何模型。${ansi.reset}\n`);
    return;
  }

  // 这条操作会改动**所有**模型的权重，先确认一次。
  // 顺带也提供了「返回」的机会 —— 菜单里其余动作都能中途取消，它不该是例外。
  const confirmed = await promptConfirm(
    `将把 ${models.length} 个模型的权重全部重置为 ${DEFAULT_MODEL_WEIGHT}，继续？`,
  );
  if (!confirmed) {
    process.stdout.write(`${ansi.gray}已取消。${ansi.reset}\n`);
    return;
  }

  resetModelWeights(config);
  syncActiveFields(config);
  saveConfig(config);
  process.stdout.write(
    `${ansi.green}✓ 已把 ${models.length} 个模型的权重重置为 ${DEFAULT_MODEL_WEIGHT}。${ansi.reset}\n`,
  );
}

/** 打印已配置的模型列表 */
function listModels(): void {
  const config = loadConfig();
  printModelTable(config);
}

/** 打印所有内置可用的模型（按服务商分组），并标注哪些已加入配置 */
function listAvailableModels(): void {
  const config = loadConfig();
  const configured = new Set(effectiveModels(config).map((entry) => entry.id));
  const total = PROVIDERS.reduce((sum, provider) => sum + provider.models.length, 0);

  process.stdout.write(
    `\n${ansi.bold}所有可用模型${ansi.reset}` +
      `${ansi.gray}（${PROVIDERS.length} 个服务商，共 ${total} 个内置模型）${ansi.reset}\n`,
  );

  for (const provider of PROVIDERS) {
    const hasKey =
      config.providers[provider.id] !== undefined
        ? `  ${ansi.gray}· 已填写 Key${ansi.reset}`
        : "";
    process.stdout.write(
      `\n  ${ansi.bold}${provider.label}${ansi.reset} ` +
        `${ansi.gray}(${provider.id})${ansi.reset}${hasKey}\n`,
    );

    if (provider.models.length === 0) {
      process.stdout.write(
        `    ${ansi.gray}无内置列表，需手动输入模型名` +
          `${provider.requiresBaseUrl ? "（自定义端点）" : ""}${ansi.reset}\n`,
      );
      continue;
    }

    for (const model of provider.models) {
      const id = modelId(provider.id, model);
      const isConfigured = configured.has(id);
      const marker = isConfigured ? `${ansi.brightGreen}❯${ansi.reset}` : " ";
      const tags: string[] = [];
      if (model === provider.defaultModel) tags.push("默认");
      if (isConfigured) tags.push("已配置");
      const suffix =
        tags.length > 0 ? `  ${ansi.gray}← ${tags.join(" · ")}${ansi.reset}` : "";
      process.stdout.write(`    ${marker} ${model}${suffix}\n`);
    }
  }

  // 已配置、但不在任何内置列表里的模型（典型是自定义端点），
  // 单独列出来，避免「明明配置过却在这里看不到」。
  const listedIds = new Set(
    PROVIDERS.flatMap((provider) =>
      provider.models.map((model) => modelId(provider.id, model)),
    ),
  );
  const extra = effectiveModels(config).filter(
    (entry) => !listedIds.has(entry.id),
  );
  if (extra.length > 0) {
    process.stdout.write(
      `\n  ${ansi.bold}已配置的自定义模型${ansi.reset}` +
        `${ansi.gray}（不在上面的内置列表中）${ansi.reset}\n`,
    );
    for (const entry of extra) {
      process.stdout.write(
        `    ${ansi.brightGreen}❯${ansi.reset} ${entry.id}  ` +
          `${ansi.gray}← 权重 ${entry.weight}${ansi.reset}\n`,
      );
    }
  }

  process.stdout.write(
    `\n${ansi.gray}❯ 表示已加入配置。添加模型：${ansi.reset}` +
      `${ansi.brightGreen}xzh model add <provider> <model>${ansi.reset}\n` +
      `${ansi.gray}查看已配置的模型与权重：${ansi.reset}xzh model list\n`,
  );
}

// ------------------------------------------------------------------ 交互菜单

async function interactiveMenu(): Promise<void> {
  for (;;) {
    const config = loadConfig();
    printModelTable(config);

    const action = await promptSelect(
      "请选择操作：",
      [
        { label: "新增模型", value: "add", hint: "add" },
        // 只列**已配置**的模型。内置模型清单（22 个）在命令行用 `xzh model all` 查看，
        // 放进交互菜单会把这里刷成一大片、盖住真正需要操作的条目。
        { label: "查看已配置的模型", value: "list", hint: "list" },
        { label: "删除模型", value: "remove", hint: "remove" },
        { label: "调整调用权重", value: "weight", hint: "weight" },
        { label: "调整上下文窗口", value: "context", hint: "context" },
        {
          label: `恢复全部权重为 ${DEFAULT_MODEL_WEIGHT}`,
          value: "reset",
          hint: "reset",
        },
        { label: "退出", value: "exit" },
      ],
      0,
    );

    switch (action) {
      case "add":
        await addModel([]);
        break;
      case "list":
        printModelTable(config);
        break;
      case "remove":
        await removeModelCommand([]);
        break;
      case "weight":
        await setWeightCommand([]);
        break;
      case "context":
        await setContextCommand([]);
        break;
      case "reset":
        await resetWeights();
        break;
      default:
        process.stdout.write(`\n${ansi.gray}已退出模型管理。${ansi.reset}\n`);
        return;
    }
  }
}

// ------------------------------------------------------------------ 展示

function printModelTable(config: XuanZhuConfig): void {
  const models = effectiveModels(config);
  const active = pickModel(config);

  process.stdout.write(
    `\n${ansi.bold}玄猪模型列表${ansi.reset} ${ansi.gray}(${getConfigPath()})${ansi.reset}\n`,
  );

  if (models.length === 0) {
    process.stdout.write(
      `  ${ansi.yellow}尚未配置任何模型。${ansi.reset}\n` +
        `  ${ansi.gray}运行 ${ansi.reset}xzh model add <provider> <model>${ansi.gray} 添加。${ansi.reset}\n`,
    );
    return;
  }

  const sorted = models.slice().sort((a, b) => b.weight - a.weight);
  sorted.forEach((entry, index) => {
    const isActive = active !== null && entry.id === active.id;
    const marker = isActive ? `${ansi.brightGreen}❯${ansi.reset}` : " ";
    const weightColor =
      entry.weight <= 0
        ? ansi.red
        : entry.weight < DEFAULT_MODEL_WEIGHT
          ? ansi.yellow
          : ansi.green;
    const suffix = isActive ? `  ${ansi.gray}← 当前使用${ansi.reset}` : "";
    const context = formatContextWindow(
      entry.contextWindow ?? inferContextWindow(entry.model),
    );
    process.stdout.write(
      `  ${marker} ${index + 1}. ${entry.id.padEnd(34)} ${ansi.gray}权重${ansi.reset} ${weightColor}${String(entry.weight).padStart(3)}${ansi.reset}` +
        ` ${ansi.gray}ctx ${context.padStart(5)}${ansi.reset}${suffix}\n`,
    );
  });

  process.stdout.write(
    `${ansi.gray}  权重越高越优先；调用失败 -1，全部为 0 时自动重置为 ${DEFAULT_MODEL_WEIGHT}。${ansi.reset}\n`,
  );
}

function printActiveHint(config: XuanZhuConfig): void {
  const active = pickModel(config);
  if (active) {
    process.stdout.write(
      `${ansi.gray}下次启动将使用权重最高的模型：${ansi.reset}${ansi.bold}${active.id}${ansi.reset} ${ansi.gray}(权重 ${active.weight})${ansi.reset}\n`,
    );
  } else if ((config.models ?? []).length === 0) {
    process.stdout.write(
      `${ansi.yellow}⚠ 尚未配置任何模型，运行 ${ansi.reset}` +
        `xzh model add <provider> <model>${ansi.yellow} 添加。${ansi.reset}\n`,
    );
  } else {
    process.stdout.write(
      `${ansi.yellow}⚠ 所有模型权重均为 0（已停用），运行 ${ansi.reset}` +
        `xzh model weight <id> <权重>${ansi.yellow} 启用其中一个。${ansi.reset}\n`,
    );
  }
  process.stdout.write(`\n运行 ${ansi.brightGreen}xzh${ansi.reset} 开始使用。\n`);
}

function printModelHelp(): void {
  process.stdout.write(
    `\n${ansi.bold}xzh model —— 多模型管理${ansi.reset}\n` +
      `  ${ansi.green}xzh model${ansi.reset}                              交互式菜单\n` +
      `  ${ansi.green}xzh model list${ansi.reset}                       列出已配置的模型与权重\n` +
      `  ${ansi.green}xzh model all${ansi.reset}                        列出所有内置可用模型\n` +
      `  ${ansi.green}xzh model add <provider> <model> [权重]${ansi.reset}  新增模型（默认权重 ${DEFAULT_MODEL_WEIGHT}）\n` +
      `  ${ansi.green}xzh model remove <id|序号>${ansi.reset}            删除模型\n` +
      `  ${ansi.green}xzh model weight <id|序号> <权重>${ansi.reset}      调整权重\n` +
      `  ${ansi.green}xzh model context <id|序号> <大小>${ansi.reset}    调整上下文窗口（token，如 128000）\n` +
      `  ${ansi.green}xzh model reset${ansi.reset}                      恢复全部权重为 ${DEFAULT_MODEL_WEIGHT}\n\n` +
      `${ansi.bold}权重机制${ansi.reset}\n` +
      `  启动时优先加载权重最高的模型；调用失败时该模型权重 -1，并自动切换到下一个可用模型；\n` +
      `  当所有模型权重都为 0 时，会在终端警告并把全部权重重置为 ${DEFAULT_MODEL_WEIGHT}。\n\n` +
      `${ansi.gray}可用 provider：${PROVIDERS.map((p) => p.id).join(", ")}${ansi.reset}\n`,
  );
}

// ------------------------------------------------------------------ 交互选择

/**
 * 把当前生效的模型同步回 config.provider / config.model（供单模型兼容路径使用）。
 *
 * ⚠️ 这里**不能**用 pickModel() / effectiveModels() 来判断「还有没有模型」：
 * 它们在 config.models 为空时会回退到 config.provider / config.model 这两个兼容字段，
 * 于是刚被删除的模型会被当成「仍然存在」原样写回 —— 表现为「删除后模型又回来了」。
 * 因此必须直接读 config.models。
 */
function syncActiveFields(config: XuanZhuConfig): void {
  const models = config.models ?? [];
  const active =
    models.length > 0
      ? models
          .slice()
          .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))[0]
      : null;
  config.provider = active ? active.provider : "";
  config.model = active ? active.model : "";
}

async function chooseProvider(): Promise<string | undefined> {
  // 末项「返回」返回空串、Esc/Ctrl+C 返回 undefined，两者都表示中止
  return promptSelect(
    "选择 AI 服务商：",
    [
      ...PROVIDERS.map((provider) => ({
        label: provider.label,
        value: provider.id,
        hint: provider.id,
      })),
      { label: "返回", value: "" },
    ],
    0,
  );
}

async function chooseModel(
  providerId: string,
  models: string[],
  config: XuanZhuConfig,
): Promise<string | undefined> {
  const current = config.providers[providerId]?.model;
  if (models.length > 0) {
    const options = [
      ...models.map((model) => ({ label: model, value: model })),
      { label: "手动输入模型名", value: "__custom__" },
      { label: "返回", value: "" },
    ];
    const defaultIndex = current ? Math.max(0, models.indexOf(current)) : 0;
    const selected = await promptSelect(
      `选择模型（${providerId}）：`,
      options,
      defaultIndex,
    );
    if (selected !== "__custom__") return selected; // 空串即「返回」，由调用方处理
  }
  const input = await promptInput("请输入模型名称", current);
  return input;
}

async function chooseBaseUrl(
  providerId: string,
  required: boolean,
  config: XuanZhuConfig,
): Promise<string> {
  const current = config.providers[providerId]?.baseUrl;
  if (!required) return current ?? "";
  const input = await promptInput("请输入 API 端点 baseUrl", current);
  return input;
}

/**
 * 解析用户输入的上下文窗口大小。
 * 支持纯数字（`128000`）与 k / M / 万 后缀（`128k`、`1M`、`6.4万`）。
 */
function parseContextWindow(input: string): number | undefined {
  const text = input.trim().toLowerCase().replace(/[_,\s]/g, "");
  if (!text) return undefined;
  const match = /^(\d+(?:\.\d+)?)(k|m|万)?$/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2];
  const multiplier =
    unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : unit === "万" ? 10_000 : 1;
  const tokens = Math.floor(value * multiplier);
  return tokens > 0 ? tokens : undefined;
}

/**
 * 询问模型的上下文窗口（token）。
 *
 * 没有任何接口能直接查询这个值（OpenAI 兼容端点的 /models 只返回 id 与 owner），
 * 因此留空时按模型名推断（见 llm/context.ts）。也可用第 4 个位置参数直接给出：
 *   xzh model add <provider> <model> [权重] [上下文窗口]
 */
async function chooseContextWindow(
  model: string,
  preset?: string,
): Promise<number> {
  const guessed = inferContextWindow(model);

  if (preset !== undefined && preset.trim() !== "") {
    const fromArgs = parseContextWindow(preset);
    if (fromArgs === undefined) {
      process.stdout.write(
        `${ansi.yellow}无法识别上下文窗口「${preset}」，已使用推断值 ${formatContextWindow(guessed)}。${ansi.reset}\n`,
      );
      return guessed;
    }
    return fromArgs;
  }

  process.stdout.write(
    `${ansi.gray}  上下文窗口：按模型名推断为 ${formatContextWindow(guessed)} token。${ansi.reset}\n`,
  );
  const input = await promptInput(
    "请输入上下文窗口大小（token，如 128000；回车使用推断值）",
    String(guessed),
  );
  const parsed = parseContextWindow(input);
  if (parsed === undefined) {
    process.stdout.write(
      `${ansi.yellow}  无法识别「${input}」，已使用推断值 ${formatContextWindow(guessed)}。${ansi.reset}\n`,
    );
    return guessed;
  }
  return parsed;
}

async function chooseApiKey(
  providerId: string,
  envKey: string,
  config: XuanZhuConfig,
): Promise<string> {
  const meta = findProvider(providerId);
  const existing = config.providers[providerId]?.apiKey;
  if (!meta?.requiresApiKey) {
    return existing ?? "";
  }
  if (resolveApiKey(meta, existing)) {
    process.stdout.write(
      `${ansi.gray}已检测到 API Key（${envKey} 或配置中），直接回车保留。${ansi.reset}\n`,
    );
  }
  // mask: true —— 已保存的 Key 只以 sk-1234…abcd 形式展示，新输入的字符不回显。
  // 之前直接把真实 Key 作为默认值打印在提示符里，共享屏幕/录制时即泄露。
  const input = await promptInput("请输入 API Key", existing ?? "", {
    mask: true,
  });
  return input;
}

/**
 * 把用户输入（id / 模型名 / 序号）解析为模型 id。
 * 序号的顺序与 `xzh model list` 的展示保持一致（按权重降序）。
 */
function resolveModelKey(config: XuanZhuConfig, key: string): string | null {
  const models = effectiveModels(config);
  const byId = models.find((entry) => entry.id === key);
  if (byId) return byId.id;
  const byModel = models.find((entry) => entry.model === key);
  if (byModel) return byModel.id;
  if (/^\d+$/.test(key.trim())) {
    const sorted = models.slice().sort((a, b) => b.weight - a.weight);
    const index = Number.parseInt(key, 10);
    if (index >= 1 && index <= sorted.length) return sorted[index - 1].id;
  }
  return null;
}

/**
 * 让用户从已配置的模型里挑一个。
 *
 * 列表末尾始终附一个「返回」，选中即返回空字符串 —— 调用方据此中止操作。
 * 没有它的话，用户一旦进入某个子操作（删除 / 调权重 / 调上下文）就只能硬着头皮选一个，
 * 想放弃只能 Ctrl+C 退出整个进程。
 */
async function chooseFromList(
  models: ModelEntry[],
  label: string,
): Promise<string | undefined> {
  const sorted = models.slice().sort((a, b) => b.weight - a.weight);
  const chosen = await promptSelect(
    label,
    [
      ...sorted.map((entry) => ({
        label:
          `${entry.id}  权重 ${entry.weight}  ctx ${formatContextWindow(
            entry.contextWindow ?? inferContextWindow(entry.model),
          )}`,
        value: entry.id,
      })),
      { label: "返回", value: "" },
    ],
    0,
  );
  return chosen;
}

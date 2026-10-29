import {
  activeModelEntry,
  effectiveModels,
  loadConfig,
  materializeModels,
  modelDisplayName,
  modelId,
  removeModel,
  saveConfig,
  setModelAlias,
  setModelBaseUrl,
  setModelModelId,
  upsertModel,
  type ModelEntry,
  type XuanZhuConfig,
} from "../../config/store";
import {
  DEFAULT_CONTEXT_WINDOW,
  findProvider,
  formatContextWindow,
  inferContextWindow,
  inferVisionSupport,
  modelSupportsVision,
  PROVIDERS,
  resolveApiKey,
} from "../../llm";
import { ansi } from "../../utils/ansi";
import { getConfigPath } from "../../utils/paths";
import { promptInput, promptSelect } from "../prompt";

/**
 * `xzh model`                    交互式管理多个模型（新增 / 删除 / 查看全部）
 * `xzh model list`               列出**已配置**的模型（按回退顺序）
 * `xzh model all`                列出**所有内置可用**的模型（按服务商分组）
 * `xzh model add <provider> <model> [上下文窗口] [on|off]`
 *                                 （末尾 on/off = 是否支持图片输入）
 * `xzh model remove <id|序号>`   删除模型
 * `xzh model context <id|序号> <token>`
 * `xzh model vision <id|序号> <on|off>`  标注是否支持图片输入
 *
 * 兼容旧用法：`xzh model <provider> [model]` 等价于 `add`。
 *
 * **列表顺序即优先级**：启动时用「上次用过的」那个模型，它调用失败时按列表顺序
 * 回退到下一个，直到全部试过。因此这里没有权重相关的子命令 —— 想让某个模型不参与，
 * 直接 `remove` 即可。
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
    case "context":
    case "ctx":
      return setContextCommand(args.slice(1));
    case "vision":
    case "image":
      return setVisionCommand(args.slice(1));
    case "alias":
    case "name":
      return setAliasCommand(args.slice(1));
    case "baseurl":
    case "url":
      return setBaseUrlCommand(args.slice(1));
    case "modelid":
    case "mid":
      return setModelIdCommand(args.slice(1));
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

  // 自定义端点的交互顺序：先取展示别名，再输入真正的模型 ID（API model 字段）。
  // 位置参数模式（args[1] 已给出模型 ID）不额外打扰用户，别名可稍后用 `xzh model alias` 设置。
  const modelArg = args[1];
  let alias: string | undefined;
  if (!modelArg && meta.id === "custom") {
    alias = await chooseAlias(meta.id);
  }
  const model = modelArg ?? (await chooseModel(meta.id, meta.models, config));
  // 在模型列表里选了「返回」
  if (!model) {
    process.stdout.write(`${ansi.gray}已取消。${ansi.reset}\n`);
    return;
  }
  if (!modelArg && meta.id !== "custom") {
    alias = await chooseAlias(meta.id);
  }
  const baseUrl = await chooseBaseUrl(meta.id, meta.requiresBaseUrl === true, config);
  const apiKey = await chooseApiKey(meta.id, meta.envKey, config);
  // ⚠ 位置参数自 v0.5 起整体前移一位：原来的 [权重] 已取消
  const contextWindow = await chooseContextWindow(model, args[2]);
  const vision = await chooseVision(meta.id, model, args[3]);

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
    ...(alias !== undefined ? { alias } : {}),
    contextWindow,
    vision,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  });

  saveConfig(config);

  process.stdout.write(
    `\n${ansi.green}✓ ${existed ? "已更新" : "已新增"}模型${ansi.reset} ${ansi.bold}${entry.id}${ansi.reset}\n` +
      `  ${ansi.gray}provider：${ansi.reset}${meta.label}\n` +
      (entry.alias
        ? `  ${ansi.gray}别名    ：${ansi.reset}${entry.alias}\n`
        : "") +
      `  ${ansi.gray}模型 ID ：${ansi.reset}${entry.model}\n` +
      `  ${ansi.gray}上下文  ：${ansi.reset}${formatContextWindow(entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW)} token\n` +
      `  ${ansi.gray}图片输入：${ansi.reset}${modelSupportsVision(entry) ? "支持（Ctrl+V 粘贴图片）" : "不支持"}\n` +
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

  // 「当前使用」的指针由 removeModel() 一并维护（删的正是它时切到剩下的第一项）
  saveConfig(config);

  process.stdout.write(
    `\n${ansi.green}✓ 已删除模型${ansi.reset} ${removed.id}\n`,
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

/**
 * 标注模型是否支持**图片输入**（视觉）。
 *
 * 未标注时按模型名自动推断；推断不出来的一律按「不支持」处理 —— 玄猪会在附加图片时
 * 直接拒绝并提示，而不是发出去换一个 400。私有部署或新模型名需要在这里显式打开。
 */
async function setVisionCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const models = effectiveModels(config);
  if (models.length === 0) {
    process.stdout.write(`${ansi.yellow}尚未配置任何模型。${ansi.reset}\n`);
    return;
  }

  const key =
    args[0] || (await chooseFromList(models, "选择要标注视觉能力的模型："));
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

  const inferred = inferVisionSupport(target.model);
  const raw = (
    args[1] ??
    (await promptInput(
      `请输入 ${target.id} 是否支持图片输入（on / off，回车按模型名推断）`,
      inferred ? "on" : "off",
    ))
  )
    .trim()
    .toLowerCase();

  const enabled = parseToggle(raw);
  if (enabled === undefined) {
    process.stdout.write(
      `${ansi.red}无法识别「${raw}」，请使用 on 或 off。${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // target 来自 effectiveModels() 的浅拷贝，写回必须拿 config.models 里的原始条目
  const stored = materializeModels(config).find((entry) => entry.id === target.id);
  if (!stored) {
    process.stdout.write(`${ansi.red}设置失败：${target.id}${ansi.reset}\n`);
    process.exitCode = 1;
    return;
  }

  stored.vision = enabled;
  saveConfig(config);

  process.stdout.write(
    `\n${ansi.green}✓ 已更新视觉能力${ansi.reset} ${target.id} → ${
      enabled ? "支持图片输入" : "不支持图片输入"
    }\n` +
      `${ansi.gray}  生效结果：${
        modelSupportsVision(stored) ? "可以粘贴图片" : "粘贴图片会被拒绝"
      }（Ctrl+V 或 /image）${ansi.reset}\n`,
  );
}

/** 修改展示别名 */
async function setAliasCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const models = effectiveModels(config);
  if (models.length === 0) {
    process.stdout.write(`${ansi.yellow}尚未配置任何模型。${ansi.reset}\n`);
    return;
  }
  const key = args[0] || (await chooseFromList(models, "选择要设置别名的模型："));
  if (!key) return;
  const id = resolveModelKey(config, key);
  const target = id ? models.find((entry) => entry.id === id) : undefined;
  if (!target) {
    process.stdout.write(`${ansi.red}未找到模型：${key}${ansi.reset}\n`);
    process.exitCode = 1;
    return;
  }
  const input =
    args[1] ??
    (await promptInput(
      `请输入 ${modelDisplayName(target)} 的展示别名（留空清除）`,
      target.alias ?? "",
    ));
  const entry = setModelAlias(config, target.id, input);
  if (!entry) {
    process.stdout.write(`${ansi.red}修改失败：模型已不存在。${ansi.reset}\n`);
    process.exitCode = 1;
    return;
  }
  saveConfig(config);
  process.stdout.write(
    `\n${ansi.green}✓ 已更新别名${ansi.reset} ${entry.id} → ${
      entry.alias ?? "（无，显示模型 ID）"
    }\n`,
  );
}

/** 修改模型条目的 API 地址（baseUrl） */
async function setBaseUrlCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const models = effectiveModels(config);
  if (models.length === 0) {
    process.stdout.write(`${ansi.yellow}尚未配置任何模型。${ansi.reset}\n`);
    return;
  }
  const key = args[0] || (await chooseFromList(models, "选择要修改地址的模型："));
  if (!key) return;
  const id = resolveModelKey(config, key);
  const target = id ? models.find((entry) => entry.id === id) : undefined;
  if (!target) {
    process.stdout.write(`${ansi.red}未找到模型：${key}${ansi.reset}\n`);
    process.exitCode = 1;
    return;
  }
  const current = target.baseUrl ?? config.providers[target.provider]?.baseUrl ?? "";
  const input =
    args[1] ??
    (await promptInput(`请输入 ${target.id} 的 API 地址 baseUrl`, current));
  const meta = findProvider(target.provider);
  if (!input.trim() && meta?.requiresBaseUrl) {
    process.stdout.write(
      `${ansi.red}该 provider 需要 baseUrl，不能留空。${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const entry = setModelBaseUrl(config, target.id, input);
  if (!entry) {
    process.stdout.write(`${ansi.red}修改失败：模型已不存在。${ansi.reset}\n`);
    process.exitCode = 1;
    return;
  }
  saveConfig(config);
  process.stdout.write(
    `\n${ansi.green}✓ 已更新地址${ansi.reset} ${entry.id} → ${
      entry.baseUrl ?? config.providers[entry.provider]?.baseUrl ?? "（未设置）"
    }\n`,
  );
}

/** 修改真正的模型 ID（API 的 model 字段） */
async function setModelIdCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const models = effectiveModels(config);
  if (models.length === 0) {
    process.stdout.write(`${ansi.yellow}尚未配置任何模型。${ansi.reset}\n`);
    return;
  }
  const key = args[0] || (await chooseFromList(models, "选择要修改模型 ID 的模型："));
  if (!key) return;
  const id = resolveModelKey(config, key);
  const target = id ? models.find((entry) => entry.id === id) : undefined;
  if (!target) {
    process.stdout.write(`${ansi.red}未找到模型：${key}${ansi.reset}\n`);
    process.exitCode = 1;
    return;
  }
  const input =
    args[1] ??
    (await promptInput(`请输入 ${target.id} 的模型 ID（API model 字段）`, target.model));
  const result = setModelModelId(config, target.id, input);
  if (result.error || !result.entry) {
    process.stdout.write(`${ansi.red}修改失败：${result.error ?? "未知错误"}${ansi.reset}\n`);
    process.exitCode = 1;
    return;
  }
  saveConfig(config);
  process.stdout.write(
    `\n${ansi.green}✓ 已更新模型 ID${ansi.reset} ${target.id} → ${result.entry.id}\n` +
      `  ${ansi.gray}模型 ID：${result.entry.model}${ansi.reset}\n`,
  );
  printActiveHint(config);
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
        `    ${ansi.brightGreen}❯${ansi.reset} ${modelDisplayName(entry)}` +
          `${entry.alias ? ` ${ansi.gray}(${entry.id})${ansi.reset}` : ""}\n`,
      );
    }
  }

  process.stdout.write(
    `\n${ansi.gray}❯ 表示已加入配置。添加模型：${ansi.reset}` +
      `${ansi.brightGreen}xzh model add <provider> <model>${ansi.reset}\n` +
      `${ansi.gray}查看已配置的模型：${ansi.reset}xzh model list\n`,
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
        { label: "调整上下文窗口", value: "context", hint: "context" },
        { label: "修改显示别名", value: "alias", hint: "alias" },
        { label: "修改 API 地址", value: "baseurl", hint: "baseurl" },
        { label: "修改模型 ID", value: "modelid", hint: "modelid" },
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
      case "context":
        await setContextCommand([]);
        break;
      case "alias":
        await setAliasCommand([]);
        break;
      case "baseurl":
        await setBaseUrlCommand([]);
        break;
      case "modelid":
        await setModelIdCommand([]);
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
  const active = activeModelEntry(config);

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

  // 按配置顺序展示，**不再排序**：这个顺序就是回退顺序，重排会让用户看不懂
  models.forEach((entry, index) => {
    const isActive = active !== null && entry.id === active.id;
    const marker = isActive ? `${ansi.brightGreen}❯${ansi.reset}` : " ";
    const suffix = isActive ? `  ${ansi.gray}← 当前使用${ansi.reset}` : "";
    const context = formatContextWindow(
      entry.contextWindow ?? inferContextWindow(entry.model),
    );
    const vision = modelSupportsVision(entry)
      ? ` ${ansi.cyan}视觉${ansi.reset}`
      : "";
    const display = modelDisplayName(entry);
    const idSuffix = entry.alias ? ` ${ansi.gray}(${entry.id})${ansi.reset}` : "";
    process.stdout.write(
      `  ${marker} ${index + 1}. ${display.padEnd(24)}${idSuffix}` +
        ` ${ansi.gray}ctx ${context.padStart(5)}${ansi.reset}${vision}${suffix}\n`,
    );
  });

  process.stdout.write(
    `${ansi.gray}  顺序即回退顺序：先用「当前使用」那个，它调用失败时按此顺序往后切换，直到全部试过。${ansi.reset}\n`,
  );
}

function printActiveHint(config: XuanZhuConfig): void {
  const active = activeModelEntry(config);
  if (active) {
    process.stdout.write(
      `${ansi.gray}下次启动将使用上次用过的模型：${ansi.reset}${ansi.bold}${modelDisplayName(active)}${ansi.reset}` +
        `${active.alias ? ` ${ansi.gray}(${active.id})${ansi.reset}` : ""}\n`,
    );
  } else if ((config.models ?? []).length === 0) {
    process.stdout.write(
      `${ansi.yellow}⚠ 尚未配置任何模型，运行 ${ansi.reset}` +
        `xzh model add <provider> <model>${ansi.yellow} 添加。${ansi.reset}\n`,
    );
  }
  process.stdout.write(`\n运行 ${ansi.brightGreen}xzh${ansi.reset} 开始使用。\n`);
}

function printModelHelp(): void {
  process.stdout.write(
    `\n${ansi.bold}xzh model —— 多模型管理${ansi.reset}\n` +
      `  ${ansi.green}xzh model${ansi.reset}                              交互式菜单\n` +
      `  ${ansi.green}xzh model list${ansi.reset}                       列出已配置的模型（按回退顺序）\n` +
      `  ${ansi.green}xzh model all${ansi.reset}                        列出所有内置可用模型\n` +
      `  ${ansi.green}xzh model add <provider> <model> [上下文窗口] [on|off]${ansi.reset}\n` +
      `                                                 新增模型（末尾 on/off = 是否支持图片输入）\n` +
      `  ${ansi.green}xzh model remove <id|序号>${ansi.reset}            删除模型（不再参与回退）\n` +
      `  ${ansi.green}xzh model context <id|序号> <大小>${ansi.reset}    调整上下文窗口（token，如 128000）\n` +
      `  ${ansi.green}xzh model vision <id|序号> <on|off>${ansi.reset}   标注是否支持图片输入（视觉）\n` +
      `  ${ansi.green}xzh model alias <id|序号> [别名]${ansi.reset}      修改展示别名（留空清除）\n` +
      `  ${ansi.green}xzh model baseurl <id|序号> <url>${ansi.reset}     修改该模型的 API 地址\n` +
      `  ${ansi.green}xzh model modelid <id|序号> <模型ID>${ansi.reset}  修改真正的模型 ID（API model 字段）\n\n` +
      `${ansi.bold}多模型与回退${ansi.reset}\n` +
      `  默认使用**上次用过的**模型（记住在配置里）；它调用失败时按列表顺序自动切换到下一个，\n` +
      `  直到所有模型都试过才报错。**列表顺序即优先级**，不再有权重设置 ——\n` +
      `  不想让某个模型参与，直接 ${ansi.green}xzh model remove${ansi.reset} 删掉即可。\n\n` +
      `${ansi.gray}可用 provider：${PROVIDERS.map((p) => p.id).join(", ")}${ansi.reset}\n`,
  );
}

// ------------------------------------------------------------------ 交互选择

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
  // 自定义端点没有内置模型列表，这里的输入就是 OpenAI 兼容协议里的 `model` 字段。
  // 之前提示只写「模型名称」，用户会以为缺少「模型 ID」——两者其实是同一个值。
  const input = await promptInput(
    providerId === "custom"
      ? "请输入模型 ID（API 的 model 字段，例如 qwen3.6-35b）"
      : "请输入模型名称 / ID",
    current,
  );
  return input;
}

/** 展示别名（可选）：为空表示不设置，列表/标题回退显示模型 ID。 */
async function chooseAlias(providerId: string): Promise<string | undefined> {
  const input = await promptInput(
    `请输入模型别名（用于显示，可留空；provider ${providerId}）`,
  );
  return input.trim() || undefined;
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
 * 因此留空时按模型名推断（见 llm/context.ts）。也可用第 3 个位置参数直接给出：
 *   xzh model add <provider> <model> [上下文窗口]
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

/** 解析 on/off 形式的布尔输入；无法识别时返回 undefined */
function parseToggle(input: string): boolean | undefined {
  const text = input.trim().toLowerCase();
  if (["on", "true", "yes", "y", "1"].includes(text)) return true;
  if (["off", "false", "no", "n", "0"].includes(text)) return false;
  return undefined;
}

/**
 * 询问模型是否支持图片输入（视觉）。
 *
 * 默认值取推断结果：**自定义端点（`custom`，任意 OpenAI 兼容端点）默认为「支持」** ——
 * 它的模型名由用户自填、无从推断，不默认放行就等于「自定义模型永远用不了图片」。
 * 真不支持时玄猪会在请求被拒后自动去掉图片重试一次（见 Agent），代价有限，
 * 因此这里给用户一次显式确认/关闭的机会即可。
 *
 * 也可用第 4 个位置参数直接给出：
 *   xzh model add <provider> <model> [上下文窗口] [on|off]
 */
async function chooseVision(
  providerId: string,
  model: string,
  preset?: string,
): Promise<boolean> {
  const guessed = modelSupportsVision({ provider: providerId, model });
  const fallback = guessed ? "支持" : "不支持";

  if (preset !== undefined && preset.trim() !== "") {
    const parsed = parseToggle(preset);
    if (parsed !== undefined) return parsed;
    process.stdout.write(
      `${ansi.yellow}无法识别图片输入设置「${preset}」，已使用${fallback}。${ansi.reset}\n`,
    );
    return guessed;
  }

  const why =
    providerId === "custom"
      ? "（自定义端点默认按支持处理）"
      : `（按模型名推断为${fallback}）`;
  process.stdout.write(
    `${ansi.gray}  图片输入：${why}。${ansi.reset}\n`,
  );
  const input = await promptInput(
    "该模型是否支持图片输入（Ctrl+V 粘贴图片）？输入 on / off",
    guessed ? "on" : "off",
  );
  const parsed = parseToggle(input);
  if (parsed !== undefined) return parsed;
  process.stdout.write(
    `${ansi.yellow}  无法识别「${input}」，已使用${fallback}。${ansi.reset}\n`,
  );
  return guessed;
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
 * 序号与 `xzh model list` 的展示保持一致（即配置里的回退顺序）。
 */
function resolveModelKey(config: XuanZhuConfig, key: string): string | null {
  const models = effectiveModels(config);
  const byId = models.find((entry) => entry.id === key);
  if (byId) return byId.id;
  const byModel = models.find((entry) => entry.model === key);
  if (byModel) return byModel.id;
  const byAlias = models.find((entry) => entry.alias === key);
  if (byAlias) return byAlias.id;
  if (/^\d+$/.test(key.trim())) {
    const index = Number.parseInt(key, 10);
    if (index >= 1 && index <= models.length) return models[index - 1].id;
  }
  return null;
}

/**
 * 让用户从已配置的模型里挑一个。
 *
 * 顺序与 `xzh model list` 一致（回退顺序，不重排）。
 * 列表末尾始终附一个「返回」，选中即返回空字符串 —— 调用方据此中止操作。
 * 没有它的话，用户一旦进入某个子操作（删除 / 调上下文）就只能硬着头皮选一个，
 * 想放弃只能 Ctrl+C 退出整个进程。
 */
async function chooseFromList(
  models: ModelEntry[],
  label: string,
): Promise<string | undefined> {
  const chosen = await promptSelect(
    label,
    [
      ...models.map((entry) => ({
        label:
          `${modelDisplayName(entry)}` +
          `${entry.alias ? ` (${entry.id})` : ""}  ctx ${formatContextWindow(
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

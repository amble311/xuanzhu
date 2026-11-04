import { promptConfirm, promptInput, promptSelect } from "../cli/prompt";
import { ansi } from "../utils/ansi";
import {
  CREDENTIAL_PLATFORMS,
  credentialPromptSkipped,
  deleteCredential,
  findCredentialPlatform,
  getCredential,
  hasCredential,
  listCredentials,
  maskKey,
  saveCredential,
  setCredentialPromptSkipped,
  type CredentialPlatform,
} from "./credentials";

/**
 * 交互式凭据管理（两级菜单）：
 *
 * ```
 * 凭据管理
 *   1. 币安（Binance）
 *   2. 火币（Huobi）（开发中）
 *   0. 跳过
 *      ↓ 选中平台
 * 凭据 · 币安
 *   1. 录入 / 更新凭据
 *   2. 删除凭据
 *   3. 查看凭据别名
 *   0. 返回
 * ```
 *
 * 平台列表来自注册表（`CREDENTIAL_PLATFORMS`），加平台不用改这里。
 * 只在 **TTY** 下调起：非交互环境（管道 / CI）里让用户「选一个」只会得到默认值，
 * 反而容易误以为配置成功 —— 由调用方负责判断。
 */

export type CredentialManagerResult = "configured" | "skipped" | "cancelled";

export interface CredentialManagerOptions {
  /** 触发原因（如「启动实盘」），会显示在标题上方 */
  reason?: string;
  /** 直接进入某个平台（`xzh btc apikey --binance` 之类） */
  platform?: string;
}

const SKIP_VALUE = "__skip__";
const BACK_VALUE = "__back__";
const LIST_VALUE = "__list__";

function platformHint(platform: CredentialPlatform): string | undefined {
  if (!hasCredential(platform.id)) {
    return platform.available ? "未配置" : undefined;
  }
  const summary = listCredentials().find((item) => item.platform === platform.id);
  if (!summary) return "已配置";
  return `已配置 · ${summary.label} · ${summary.apiKeyMasked}`;
}

/** 一级菜单里「查看已配置」右侧的摘要 */
function listHint(): string {
  const rows = listCredentials();
  if (rows.length === 0) return "尚无";
  return `已配置 ${rows.length} 个平台`;
}

function printConfigured(): void {
  const rows = listCredentials();
  if (rows.length === 0) {
    process.stdout.write(`${ansi.gray}  尚未配置任何平台的凭据。${ansi.reset}\n`);
    return;
  }
  for (const row of rows) {
    process.stdout.write(
      `  ${ansi.gray}${row.platformLabel}${ansi.reset} · ${ansi.bold}${row.label}${ansi.reset}` +
        ` ${ansi.gray}${row.apiKeyMasked} · 更新于 ${row.updatedAt.slice(0, 10)}${ansi.reset}\n`,
    );
  }
}

/** 录入 / 更新：返回是否保存成功 */
async function inputCredential(platform: CredentialPlatform): Promise<boolean> {
  const existing = getCredential(platform.id);
  const updating = Boolean(existing);

  process.stdout.write(
    `\n${ansi.gray}${
      updating
        ? "更新会覆盖现有凭据（旧密钥会从加密库中删除）"
        : "在币安「API 管理」创建 API Key 时，权限只勾选「允许读取」+「允许现货/合约交易」，不要开提现。"
    }${ansi.reset}\n`,
  );

  const apiKey = await promptInput("  API Key", undefined, { mask: true });
  if (!apiKey) {
    process.stdout.write(`${ansi.yellow}未输入 API Key，已取消。${ansi.reset}\n`);
    return false;
  }
  const apiSecret = await promptInput("  API Secret", undefined, { mask: true });
  if (!apiSecret) {
    process.stdout.write(`${ansi.yellow}未输入 API Secret，已取消。${ansi.reset}\n`);
    return false;
  }

  const defaultLabel = existing?.label ?? `${platform.shortLabel}主账号`;
  const label = await promptInput("  别名", defaultLabel);

  try {
    const summary = saveCredential({
      platform: platform.id,
      apiKey,
      apiSecret,
      label,
    });
    process.stdout.write(
      `\n${ansi.green}✓${ansi.reset} 已${updating ? "更新" : "保存"} ${summary.platformLabel}凭据` +
        `${ansi.gray}（${summary.label} · ${summary.apiKeyMasked}）${ansi.reset}\n` +
        `${ansi.gray}  密文存放于 ~/.xzh/vault，本目录只保留引用与别名；` +
        `可在 xzh btc apikey 中随时删除。${ansi.reset}\n`,
    );
    return true;
  } catch (err) {
    process.stdout.write(
      `${ansi.red}✗ 保存失败：${err instanceof Error ? err.message : String(err)}${ansi.reset}\n`,
    );
    return false;
  }
}

/** 单个平台的动作菜单；返回 true 表示刚配置过 */
async function platformMenu(platform: CredentialPlatform): Promise<boolean> {
  let configured = false;

  while (true) {
    const has = hasCredential(platform.id);
    process.stdout.write(
      `\n${ansi.bold}凭据 · ${platform.label}${ansi.reset}` +
        `${ansi.gray}${has ? "（已配置）" : "（未配置）"}${ansi.reset}\n`,
    );

    const actions = has
      ? [
          { label: "更新凭据", value: "update" },
          { label: "删除凭据", value: "delete" },
          { label: "查看凭据别名", value: "list" },
          { label: "返回", value: BACK_VALUE },
        ]
      : [
          { label: "录入凭据", value: "create" },
          { label: "查看凭据别名", value: "list" },
          { label: "返回", value: BACK_VALUE },
        ];

    const action = await promptSelect(`选择操作`, actions);
    if (!action || action === BACK_VALUE) return configured;

    if (action === "create" || action === "update") {
      if (await inputCredential(platform)) {
        // 保存成功即视为本次目的达成：直接回上层，不再让用户多点一次「返回」
        configured = true;
        return configured;
      }
      continue;
    }

    if (action === "delete") {
      const ok = await promptConfirm(
        `确认删除 ${platform.label} 的凭据？删除后需重新录入才能实盘下单`,
        false,
      );
      if (!ok) continue;
      const removed = deleteCredential(platform.id);
      process.stdout.write(
        removed
          ? `${ansi.green}✓${ansi.reset} 已删除（密文与别名一并清除）\n`
          : `${ansi.yellow}没有可删除的凭据。${ansi.reset}\n`,
      );
      continue;
    }

    if (action === "list") {
      printConfigured();
      continue;
    }
  }
}

export async function credentialManager(
  options: CredentialManagerOptions = {},
): Promise<CredentialManagerResult> {
  if (options.reason) {
    process.stdout.write(
      `\n${ansi.yellow}⚠${ansi.reset} ${options.reason}\n`,
    );
  }

  let configured = false;

  // 指定平台时直接进二级菜单（当前仅用于以后的快捷参数）
  if (options.platform) {
    const target = findCredentialPlatform(options.platform);
    if (!target) {
      process.stdout.write(
        `${ansi.red}未支持的平台：${options.platform}${ansi.reset}\n` +
          `${ansi.gray}可选：${CREDENTIAL_PLATFORMS.map((item) => item.id).join(" / ")}${ansi.reset}\n`,
      );
      return "cancelled";
    }
    if (!target.available) {
      process.stdout.write(
        `${ansi.yellow}${target.label} 暂未支持${ansi.reset}${ansi.gray}（${target.hint ?? "后续开发"}）${ansi.reset}\n`,
      );
      return "cancelled";
    }
    return (await platformMenu(target)) ? "configured" : "cancelled";
  }

  while (true) {
    process.stdout.write(`\n${ansi.bold}凭据管理${ansi.reset}\n${ansi.gray}  交易所 API 凭据，密文存放在 ~/.xzh/vault${ansi.reset}\n`);

    const choices = CREDENTIAL_PLATFORMS.map((platform) => ({
      label: platform.available
        ? platform.label
        : `${platform.label}${ansi.gray}（${platform.hint ?? "未支持"}）${ansi.reset}`,
      value: platform.id,
      hint: platformHint(platform),
    }));
    choices.push({
      label: "查看已配置的凭据",
      value: LIST_VALUE,
      hint: listHint(),
    });
    choices.push({
      label: "跳过（稍后再说）",
      value: SKIP_VALUE,
      hint: "之后用 xzh btc apikey 配置",
    });

    const picked = await promptSelect("选择交易所", choices);
    if (!picked) return configured ? "configured" : "cancelled";

    if (picked === LIST_VALUE) {
      // 一级菜单就能看到所有平台的别名，不必先点进某个平台
      process.stdout.write(`\n${ansi.bold}已配置的凭据${ansi.reset}\n`);
      printConfigured();
      continue;
    }

    if (picked === SKIP_VALUE) {
      // 记住这个选择：否则每次 xzh btc 都会再问一遍
      setCredentialPromptSkipped(true);
      process.stdout.write(
        `${ansi.gray}已跳过。之后可随时运行 ${ansi.reset}xzh btc apikey${ansi.gray} 配置。${ansi.reset}\n`,
      );
      return configured ? "configured" : "skipped";
    }

    const platform = findCredentialPlatform(picked);
    if (!platform) continue;
    if (!platform.available) {
      process.stdout.write(
        `${ansi.yellow}${platform.label} 暂未支持${ansi.reset}${ansi.gray}（${platform.hint ?? "后续开发"}）${ansi.reset}\n`,
      );
      continue;
    }

    if (await platformMenu(platform)) return "configured";
  }
}

/**
 * 启动实盘前的检测。
 *
 * 只看**已配置**，不问人：是否要弹菜单由调用方决定（要判断 TTY、是否跳过过）。
 */
export function credentialStatusLine(): string {
  const rows = listCredentials();
  if (rows.length === 0) return "未配置";
  return rows
    .map((row) => `${row.platformLabel} ${row.label}（${row.apiKeyMasked}）`)
    .join(" · ");
}

export { credentialPromptSkipped };

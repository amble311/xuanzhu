import * as fs from "fs";
import * as path from "path";
import { deleteSecret, loadSecret, storeSecret } from "../secrets/vault";
import { getBtcHome } from "../utils/paths";

/**
 * 交易所凭据。
 *
 * **两处存储，各司其职**：
 * - 明文（apiKey / apiSecret）交给全局加密库 `~/.xzh/vault/`（AES-256-GCM，0600），
 *   与项目里其它凭据同一套机制，不另造加密；
 * - 索引 `~/.xzh_btc/credentials.json` 只存「平台 → 引用 id + 别名 + 时间」，
 *   属于 btc 模式的数据目录。
 *
 * 为什么不像 vault 那样只存一份：vault 只按明文摘要去重，没有平台概念，
 * 而这里要做的是「哪个平台配了、别名是什么、更新/删除哪一个」。
 * 索引里**没有任何明文**，即使文件被读走也拿不到 key。
 *
 * 平台用**注册表**而不是写死 binance：以后加火币/OKX 只需要在
 * `CREDENTIAL_PLATFORMS` 里补一项 + 实现对应适配器，交互菜单自动跟着长。
 */

export interface CredentialPlatform {
  /** 与 `src/exchange` 的适配器 id 一致 */
  id: string;
  label: string;
  /** 短名（默认别名用，如「币安主账号」而不是「币安（Binance）主账号」） */
  shortLabel: string;
  /** 是否已支持 */
  available: boolean;
  hint?: string;
}

export const CREDENTIAL_PLATFORMS: CredentialPlatform[] = [
  { id: "binance", label: "币安（Binance）", shortLabel: "币安", available: true },
  { id: "huobi", label: "火币（Huobi）", shortLabel: "火币", available: false, hint: "开发中" },
];

export function findCredentialPlatform(
  id: string,
): CredentialPlatform | undefined {
  const wanted = id.trim().toLowerCase();
  return CREDENTIAL_PLATFORMS.find((item) => item.id === wanted);
}

interface StoredCredential {
  platform: string;
  /** 用户起的别名（如「主账号」「只读」） */
  label: string;
  apiKeyId: string;
  apiSecretId: string;
  createdAt: string;
  updatedAt: string;
}

interface CredentialFile {
  version: 1;
  /**
   * 用户选择过「暂不配置」。
   *
   * 不记住这个选择的话，每次 `xzh btc` 都会弹一次凭据菜单 ——
   * 只想看行情的人会被反复打扰；手动 `xzh btc apikey` 不受它影响。
   */
  skipPrompt?: boolean;
  platforms: Record<string, StoredCredential>;
}

export interface CredentialSummary {
  platform: string;
  platformLabel: string;
  label: string;
  /** 掩码后的 API Key（`abcd…wxyz`），仅用于展示 */
  apiKeyMasked: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialSecret {
  platform: string;
  label: string;
  apiKey: string;
  apiSecret: string;
}

export function credentialsPath(home = getBtcHome()): string {
  return path.join(home, "credentials.json");
}

function readFile(home: string): CredentialFile {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(credentialsPath(home), "utf8"),
    ) as CredentialFile;
    if (parsed && parsed.version === 1 && parsed.platforms) return parsed;
  } catch {
    // 不存在或损坏：按空索引处理（密文仍在 vault 里，不会丢）
  }
  return { version: 1, platforms: {} };
}

function writeFile(home: string, file: CredentialFile): void {
  const target = credentialsPath(home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // 某些文件系统不支持 chmod，忽略
  }
  fs.renameSync(tmp, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // 忽略
  }
}

/** `abcd…wxyz`；太短就全打码，别用掩码泄露长度之外的信息 */
export function maskKey(value: string): string {
  const clean = value.trim();
  if (clean.length <= 8) return "*".repeat(Math.max(clean.length, 4));
  return `${clean.slice(0, 4)}…${clean.slice(-4)}`;
}

function platformLabel(id: string): string {
  return findCredentialPlatform(id)?.label ?? id;
}

/** 短名，用于拼接默认别名 */
function platformShortLabel(id: string): string {
  return findCredentialPlatform(id)?.shortLabel ?? id;
}

/** 已配置的平台摘要（解密后即时打码，掩码不落盘） */
export function listCredentials(home = getBtcHome()): CredentialSummary[] {
  const file = readFile(home);
  return Object.values(file.platforms)
    .map((entry) => {
      const apiKey = loadSecret(entry.apiKeyId) ?? "";
      return {
        platform: entry.platform,
        platformLabel: platformLabel(entry.platform),
        label: entry.label,
        apiKeyMasked: apiKey ? maskKey(apiKey) : "（密文不可读）",
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      };
    })
    .sort((a, b) => a.platform.localeCompare(b.platform));
}

/** 取明文凭据（只给签名/下单用，**绝不要写进日志或返回给模型**） */
export function getCredential(
  platform: string,
  home = getBtcHome(),
): CredentialSecret | null {
  const entry = readFile(home).platforms[platform.trim().toLowerCase()];
  if (!entry) return null;
  const apiKey = loadSecret(entry.apiKeyId);
  const apiSecret = loadSecret(entry.apiSecretId);
  if (!apiKey || !apiSecret) return null;
  return {
    platform: entry.platform,
    label: entry.label,
    apiKey,
    apiSecret,
  };
}

export function hasCredential(
  platform: string,
  home = getBtcHome(),
): boolean {
  const entry = readFile(home).platforms[platform.trim().toLowerCase()];
  if (!entry) return false;
  // 索引在但密文丢失（vault 被删 / 换机器）：视为未配置，避免调用方拿到空串去签名
  return Boolean(loadSecret(entry.apiKeyId) && loadSecret(entry.apiSecretId));
}

export interface SaveCredentialInput {
  platform: string;
  apiKey: string;
  apiSecret: string;
  label?: string;
}

/**
 * 保存（新建或更新）凭据。
 *
 * 更新时会把旧的 vault 条目删掉：vault 按明文摘要去重，不清理的话旧 key
 * 会一直留在密文库中（用户以为「删了/换了」，实际还能被解密出来）。
 */
export function saveCredential(
  input: SaveCredentialInput,
  home = getBtcHome(),
): CredentialSummary {
  const platform = input.platform.trim().toLowerCase();
  const apiKey = input.apiKey.trim();
  const apiSecret = input.apiSecret.trim();
  if (!findCredentialPlatform(platform)) {
    throw new Error(`未支持的平台：${input.platform}`);
  }
  if (apiKey.length < 8) throw new Error("API Key 看起来不完整（少于 8 个字符）。");
  if (apiSecret.length < 8) {
    throw new Error("API Secret 看起来不完整（少于 8 个字符）。");
  }

  const file = readFile(home);
  const previous = file.platforms[platform];
  const now = new Date().toISOString();
  const label = (input.label?.trim() || `${platformShortLabel(platform)}主账号`).slice(
    0,
    60,
  );

  const apiKeyId = storeSecret(apiKey, `${label} · API Key`);
  const apiSecretId = storeSecret(apiSecret, `${label} · API Secret`);

  if (previous) {
    for (const id of [previous.apiKeyId, previous.apiSecretId]) {
      if (id !== apiKeyId && id !== apiSecretId) deleteSecret(id);
    }
  }

  file.platforms[platform] = {
    platform,
    label,
    apiKeyId,
    apiSecretId,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  // 用户主动配置过，就不再需要「跳过」标记了
  delete file.skipPrompt;
  writeFile(home, file);

  return {
    platform,
    platformLabel: platformLabel(platform),
    label,
    apiKeyMasked: maskKey(apiKey),
    createdAt: file.platforms[platform].createdAt,
    updatedAt: now,
  };
}

export function deleteCredential(
  platform: string,
  home = getBtcHome(),
): boolean {
  const file = readFile(home);
  const key = platform.trim().toLowerCase();
  const entry = file.platforms[key];
  if (!entry) return false;

  for (const id of [entry.apiKeyId, entry.apiSecretId]) {
    deleteSecret(id);
  }
  delete file.platforms[key];
  writeFile(home, file);
  return true;
}

/** 用户选择「暂不配置」：之后启动不再自动询问 */
export function setCredentialPromptSkipped(
  skipped: boolean,
  home = getBtcHome(),
): void {
  const file = readFile(home);
  if (skipped) file.skipPrompt = true;
  else delete file.skipPrompt;
  writeFile(home, file);
}

export function credentialPromptSkipped(home = getBtcHome()): boolean {
  return readFile(home).skipPrompt === true;
}

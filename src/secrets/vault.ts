import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getConfigDir } from "../utils/paths";

/**
 * 本地加密凭据库（~/.xzh/vault/）。
 *
 * 记忆（MEMORY.md）会注入每次请求的提示词，所以密码/Token 只能以**引用**形式出现；
 * 真正的值用 AES-256-GCM 加密后放在这里：
 *
 *   ~/.xzh/vault/key            32 字节随机密钥，0600
 *   ~/.xzh/vault/entries.json   密文条目，0600
 *
 * 这不是「对本地 root 的防护」（密钥和密文同机），而是保证：
 *   - 记忆文件、会话日志、错误报告、模型上下文里看不到明文；
 *   - 只有显式调用 loadSecret(id) 的内部代码才能解密。
 *
 * 条目只记录 label / 摘要哈希 / IV / GCM tag / 密文，不记录明文。
 */

export interface SecretEntryMeta {
  id: string;
  label: string;
  createdAt: string;
}

interface StoredEntry extends SecretEntryMeta {
  /** 明文 SHA-256，仅用于去重，不可逆 */
  digest: string;
  /** base64 */
  iv: string;
  /** base64 */
  tag: string;
  /** base64 */
  ciphertext: string;
}

interface VaultFile {
  version: 1;
  entries: Record<string, StoredEntry>;
}

const VAULT_DIR = "vault";
const KEY_FILE = "key";
const ENTRIES_FILE = "entries.json";

export function vaultDir(): string {
  return path.join(getConfigDir(), VAULT_DIR);
}

function keyFile(): string {
  return path.join(vaultDir(), KEY_FILE);
}

function entriesFile(): string {
  return path.join(vaultDir(), ENTRIES_FILE);
}

function ensureVaultDir(): void {
  fs.mkdirSync(vaultDir(), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(vaultDir(), 0o700);
  } catch {
    // 某些文件系统不支持 chmod，忽略
  }
}

function getOrCreateKey(): Buffer {
  ensureVaultDir();
  try {
    try {
      fs.chmodSync(keyFile(), 0o600);
    } catch {
      // 忽略
    }
    const raw = fs.readFileSync(keyFile(), "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length === 32) return key;
  } catch {
    // 不存在或损坏：下面重新生成
  }
  const key = crypto.randomBytes(32);
  const tmp = `${keyFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${key.toString("base64")}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // 忽略
  }
  fs.renameSync(tmp, keyFile());
  try {
    fs.chmodSync(keyFile(), 0o600);
  } catch {
    // 忽略
  }
  return key;
}

function readVault(): VaultFile {
  try {
    try {
      fs.chmodSync(entriesFile(), 0o600);
    } catch {
      // 忽略
    }
    const parsed = JSON.parse(fs.readFileSync(entriesFile(), "utf8")) as VaultFile;
    if (parsed && parsed.version === 1 && parsed.entries) return parsed;
  } catch {
    // 不存在或损坏：按空库处理
  }
  return { version: 1, entries: {} };
}

function writeVault(vault: VaultFile): void {
  ensureVaultDir();
  const tmp = `${entriesFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(vault, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // 忽略
  }
  fs.renameSync(tmp, entriesFile());
  try {
    fs.chmodSync(entriesFile(), 0o600);
  } catch {
    // 忽略
  }
}

function encrypt(value: string): { iv: string; tag: string; ciphertext: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    getOrCreateKey() as unknown as crypto.CipherKey,
    iv as unknown as crypto.BinaryLike,
  );
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ] as unknown as Uint8Array[]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(entry: StoredEntry): string {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getOrCreateKey() as unknown as crypto.CipherKey,
    Buffer.from(entry.iv, "base64") as unknown as crypto.BinaryLike,
  );
  decipher.setAuthTag(
    Buffer.from(entry.tag, "base64") as unknown as Uint8Array,
  );
  return Buffer.concat([
    decipher.update(
      Buffer.from(entry.ciphertext, "base64") as unknown as Uint8Array,
    ),
    decipher.final(),
  ] as unknown as Uint8Array[]).toString("utf8");
}

/** 记忆里的引用形式；解析器只需要认这个前缀 */
export function secretRef(id: string): string {
  return `[加密凭据 ${id}]`;
}

/** 保存一个凭据，返回引用 id；相同明文复用已有条目 */
export function storeSecret(value: string, label = "凭据"): string {
  const clean = value.trim();
  if (!clean) throw new Error("凭据内容为空。");

  const digest = crypto.createHash("sha256").update(clean, "utf8").digest("hex");
  const vault = readVault();
  const existing = Object.values(vault.entries).find(
    (entry) => entry.digest === digest,
  );
  if (existing) return existing.id;

  const id = `sec_${crypto.randomBytes(6).toString("hex")}`;
  const encrypted = encrypt(clean);
  vault.entries[id] = {
    id,
    label: label.trim().slice(0, 60) || "凭据",
    digest,
    createdAt: new Date().toISOString(),
    ...encrypted,
  };
  writeVault(vault);
  return id;
}

/** 内部使用：解密凭据。绝不要把返回值直接返回给模型/日志 */
export function loadSecret(id: string): string | null {
  const entry = readVault().entries[id];
  if (!entry) return null;
  try {
    return decrypt(entry);
  } catch {
    return null;
  }
}

/** 只返回元数据，不返回值 */
export function listSecrets(): SecretEntryMeta[] {
  return Object.values(readVault().entries)
    .map(({ id, label, createdAt }) => ({ id, label, createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function deleteSecret(id: string): boolean {
  const vault = readVault();
  if (!vault.entries[id]) return false;
  delete vault.entries[id];
  writeVault(vault);
  return true;
}

// ------------------------------------------------------------------ 文本保护

// 值一直取到行尾：密码可能包含空格/标点，按「空白或中文标点」截断会把后半段留在明文里。
// 宁可多加密一些说明文字，也不能让秘密残片落进记忆。
const CREDENTIAL_ASSIGNMENT =
  /(密码|口令|pass(?:word|wd|phrase)?|token|api[_-]?key|secret|uuid)\s*(?:是|为|[:=：])\s*([^\n]+)/gi;

function isPlaceholder(value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  if (text.includes("[加密凭据")) return true;
  if (/^(?:x{3,}|\*{3,}|…+|\.{3}|<[^>]*>)$/i.test(text)) return true;
  if (/^\d+$/.test(text)) return true; // token 上限：4096
  if (/^(?:多少|什么|怎么|如何|哪个|是否|吗)[?？]?$/.test(text)) return true;
  return /[?？]$/.test(text);
}

/**
 * 把文本中的密码/Token 赋值替换成加密引用。
 *
 * 例如 `sudo 密码是 abc123` → `sudo 密码是 [加密凭据 sec_xxxx]`。
 * 只替换值，保留原句结构；值本身写入加密库，不进入记忆/提示词。
 */
export function protectSecretsInText(text: string): {
  text: string;
  credentialIds: string[];
} {
  const ids: string[] = [];
  const protectedText = text.replace(
    CREDENTIAL_ASSIGNMENT,
    (full, label: string, value: string) => {
      if (isPlaceholder(value)) return full;
      const id = storeSecret(value, label);
      ids.push(id);
      return full.replace(value, secretRef(id));
    },
  );
  return { text: protectedText, credentialIds: [...new Set(ids)] };
}

/** 文本里是否有“看起来像真的”凭据赋值（用于自动捕获判断） */
export function hasCredentialAssignment(text: string): boolean {
  const pattern = new RegExp(CREDENTIAL_ASSIGNMENT.source, "i");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (!isPlaceholder(match[2] ?? "")) return true;
  }
  return false;
}

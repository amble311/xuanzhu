import * as fs from "fs";
import * as path from "path";
import { getConfigDir } from "../utils/paths";

/**
 * 本地凭据库（~/.xzh/secrets/）。
 *
 * 只存「需要被程序使用、但绝不能进上下文」的值：sudo 密码、访问令牌等。
 * 与记忆严格分离：
 *   - 记忆（MEMORY.md）会被注入每次请求的提示词；
 *   - 凭据只在 `xzh sudo` / 后续的 secret 执行器内部读取，不返回给模型。
 *
 * 文件权限：目录 0700，文件 0600；名称只允许 [A-Za-z0-9._-]，避免路径穿越。
 */

const SECRET_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function secretsDir(): string {
  return path.join(getConfigDir(), "secrets");
}

/** 校验并规范化凭据名称；非法时抛错 */
export function normalizeSecretName(name: string): string {
  const clean = name.trim();
  if (!SECRET_NAME.test(clean) || clean === "." || clean === "..") {
    throw new Error(
      `非法凭据名称：${JSON.stringify(name)}（只允许字母、数字、. _ -，最长 64 字符）`,
    );
  }
  return clean;
}

function secretFile(name: string): string {
  return path.join(secretsDir(), normalizeSecretName(name));
}

function ensureSecretsDir(): void {
  const dir = secretsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // 某些文件系统不支持 chmod，忽略
  }
}

export function hasSecret(name: string): boolean {
  try {
    return fs.existsSync(secretFile(name));
  } catch {
    return false;
  }
}

/** 保存凭据（原子写 + 0600）；值不会出现在日志里 */
export function saveSecret(name: string, value: string): string {
  const clean = value.replace(/\r?\n$/, "");
  if (!clean) throw new Error("凭据内容不能为空。");
  ensureSecretsDir();

  const file = secretFile(name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${clean}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // 忽略
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 忽略
  }
  return file;
}

/** 读取凭据；不存在返回 null。调用方必须保证不要把返回值打印出来 */
export function readSecret(name: string): string | null {
  try {
    const file = secretFile(name);
    if (!fs.existsSync(file)) return null;
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // 忽略
    }
    return fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
  } catch {
    return null;
  }
}

/** 删除凭据；不存在返回 false */
export function deleteSecret(name: string): boolean {
  try {
    const file = secretFile(name);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 列出凭据名称（绝不返回值） */
export function listSecretNames(): string[] {
  try {
    return fs
      .readdirSync(secretsDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.endsWith(".tmp"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

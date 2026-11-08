import * as fs from "fs";
import * as path from "path";
import { gatewayHome } from "../paths";

/**
 * 微信账号与同步游标的落盘位置：`~/.xzh_gateway/weixin/`。
 *
 * 单独一个目录而不是塞进 config.json：token 是凭据、sync_buf 是每个账号一份的游标，
 * 混进配置后既不好备份也不好删（`logout` 要能一次清干净）。
 */
export interface WeixinAccount {
  /** iLink Bot 账号 ID（如 `a5ace6fd482e@im.bot`） */
  accountId: string;
  token: string;
  /** 登录返回的 base_url（可能被重定向到别的 host） */
  baseUrl: string;
  /** 扫码的那个微信用户 ID（用来判断「是不是我」） */
  userId?: string;
  savedAt: string;
}

export function weixinDir(home = gatewayHome()): string {
  return path.join(home, "weixin");
}

export function weixinAccountFile(home = gatewayHome()): string {
  return path.join(weixinDir(home), "account.json");
}

export function weixinSyncFile(home = gatewayHome()): string {
  return path.join(weixinDir(home), "sync.json");
}

export function weixinContextFile(home = gatewayHome()): string {
  return path.join(weixinDir(home), "context.json");
}

function ensureDir(home: string): void {
  fs.mkdirSync(weixinDir(home), { recursive: true, mode: 0o700 });
}

/** 写文件用 0600：里面有 bot token */
function writePrivate(file: string, data: unknown): void {
  ensureDir(path.dirname(path.dirname(file)));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function loadAccount(home = gatewayHome()): WeixinAccount | null {
  const account = readJson<WeixinAccount>(weixinAccountFile(home));
  if (!account?.accountId || !account.token) return null;
  return account;
}

export function saveAccount(account: WeixinAccount, home = gatewayHome()): void {
  writePrivate(weixinAccountFile(home), account);
}

export function clearAccount(home = gatewayHome()): void {
  for (const file of [weixinAccountFile(home), weixinSyncFile(home), weixinContextFile(home)]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

export function loadSyncBuf(home = gatewayHome()): string {
  const data = readJson<{ get_updates_buf?: string }>(weixinSyncFile(home));
  return typeof data?.get_updates_buf === "string" ? data.get_updates_buf : "";
}

export function saveSyncBuf(buf: string, home = gatewayHome()): void {
  writePrivate(weixinSyncFile(home), { get_updates_buf: buf });
}

/** 每个对端最近一次的 context_token（回复必须回显，否则 iLink 会拒） */
export function loadContextTokens(home = gatewayHome()): Record<string, string> {
  return readJson<Record<string, string>>(weixinContextFile(home)) ?? {};
}

export function saveContextTokens(
  tokens: Record<string, string>,
  home = gatewayHome(),
): void {
  writePrivate(weixinContextFile(home), tokens);
}

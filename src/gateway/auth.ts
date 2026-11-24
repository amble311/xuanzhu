import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage } from "node:http";

/**
 * 本地 HTTP 接口的令牌。
 *
 * 为什么需要：`/message` 能驱动一个**带 bash 的 agent**。以前只监听 `127.0.0.1`
 * 就当成「安全」，但本机任何进程（含被 npm 安装的第三方包、浏览器里的
 * localhost SSRF、另一个用户在同一台机器上的进程）都能直接 POST 一条指令。
 *
 * 方案：首次启动生成随机令牌，落盘 0600（`run/http-token`）；`/message` 与
 * `/shutdown` 必须带 `Authorization: Bearer <token>` 或 `X-XZH-Token`。
 * `/health` 保持开放，但只返回不含敏感信息的状态（cwd / lastError 除外时脱敏）。
 *
 * 之所以不用 unix socket：Windows 没有，而 gateway 明确支持 Windows 自启。
 */

const TOKEN_FILE = "http-token";

export function httpTokenPath(gatewayHome: string): string {
  return path.join(gatewayHome, "run", TOKEN_FILE);
}

/** 读令牌；不存在就生成一个（0600）。返回空串表示无法创建（不阻断启动）。 */
export function ensureHttpToken(gatewayHome: string): string {
  const file = httpTokenPath(gatewayHome);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // 不存在：往下创建
  }
  const token = crypto.randomBytes(24).toString("hex");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    return token;
  } catch {
    return "";
  }
}

export function readHttpToken(gatewayHome: string): string {
  try {
    return fs.readFileSync(httpTokenPath(gatewayHome), "utf8").trim();
  } catch {
    return "";
  }
}

/** 从请求里取令牌：优先 `Authorization: Bearer`，其次 `X-XZH-Token` */
export function requestToken(req: IncomingMessage): string {
  const header = req.headers["x-xzh-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const authorization = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() ?? "";
}

/**
 * 校验请求令牌。
 *
 * `expected` 为空（创建失败 / 老目录权限异常）时**放行**：宁可保留本地可用性，
 * 也不要因为令牌文件写不出来就把用户锁在门外 —— 这一点与「新增鉴权」的初衷相反，
 * 但错误配置导致的完全不可用比本机越权更难排查。doctor 会提示令牌状态。
 */
export function authorizeRequest(req: IncomingMessage, expected: string): boolean {
  if (!expected) return true;
  const provided = requestToken(req);
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  // 定长比较（避免按字节早退泄露长度信息）；令牌本身是随机串，风险有限，
  // 但没理由在自己的接口上留一个可测量的比较。
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

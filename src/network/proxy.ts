import * as tls from "tls";
import { SocksClient } from "socks";
import {
  Agent,
  ProxyAgent,
  fetch as undiciFetch,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import type { XuanZhuConfig } from "../config/store";
import { loadSecret } from "../secrets/vault";

/**
 * 全局代理（`xzh vpn`），支持 HTTP(S) 与 SOCKS5/SOCKS5h。
 *
 * 设计取舍：
 * - v2ray / xray 常见入站是 SOCKS（1080/10808），Clash 常见 mixed/HTTP（7890/10809）；
 *   两种都要能用，否则用户只开 SOCKS 时 xzh vpn 会失效。
 * - HTTP(S) 用 undici 的 ProxyAgent；SOCKS 用 `socks` 自定义 undici connector
 *   （HTTPS 目标在 SOCKS socket 上再套 TLS）。
 * - 只在本进程生效：设置 undici 全局 dispatcher + 进程环境变量（bash 子进程继承），
 *   不修改系统代理、不写 ~/.gitconfig / npm config。
 * - 本机地址默认走 NO_PROXY，避免本地模型端点被绕进代理。
 */

const DEFAULT_NO_PROXY = "127.0.0.1,localhost,::1";

export interface AppliedProxy {
  active: boolean;
  proxy?: string;
  noProxy?: string;
  error?: string;
}

let activeProxy: string | undefined;
let proxyDispatcher: Dispatcher | undefined;
let noProxyEntries: string[] = [];
const directDispatcher = new Agent();
const originalFetch =
  (globalThis as { fetch?: typeof undiciFetch }).fetch ?? undiciFetch;

const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:"]);

function parseNoProxy(value?: string): string[] {
  return mergedNoProxy(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** 目标主机是否命中 NO_PROXY（支持 `*`、精确主机、域名后缀） */
export function isNoProxyHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  for (const raw of noProxyEntries) {
    const entry = raw
      .replace(/^\./, "")
      .replace(/^\[|\]$/g, "")
      .replace(/:\d+$/, "");
    if (entry === "*") return true;
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

function isProxyActiveInternal(): boolean {
  return Boolean(activeProxy && proxyDispatcher);
}

/**
 * 代理版 fetch：按 NO_PROXY 自动在「直连」与「代理」之间选择。
 * 不能只设置全局 dispatcher —— 否则 127.0.0.1 的本地模型端点也会被送进代理。
 */
export function proxyFetch(
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
): ReturnType<typeof undiciFetch> {
  if (!isProxyActiveInternal()) return undiciFetch(input, init);
  let url: URL;
  try {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    url = new URL(raw);
  } catch {
    return undiciFetch(input, init);
  }
  const dispatcher = isNoProxyHost(url.hostname)
    ? directDispatcher
    : (proxyDispatcher as Dispatcher);
  return undiciFetch(input, { ...init, dispatcher });
}

/** 校验并规范化代理地址；支持 http/https/socks5/socks5h */
export function normalizeProxyUrl(raw: string): string {
  const text = raw.trim();
  if (!text) throw new Error("代理地址不能为空。");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("代理地址格式无效（应为 http(s):// 或 socks5(h)://host:port）。");
  }
  if (!PROXY_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `只支持 http:// / https:// / socks5:// / socks5h:// 代理（收到 ${url.protocol}）。`,
    );
  }
  if (!url.hostname) throw new Error("代理地址缺少主机名。");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/** 把代理 URL 里的用户名/密码拆出来；config 只保存不含凭据的地址 */
export function splitProxyCredentials(proxy: string): {
  proxy: string;
  auth?: string;
} {
  const url = new URL(proxy);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const auth = username || password ? `${username}:${password}` : undefined;
  if (auth) {
    url.username = "";
    url.password = "";
  }
  return { proxy: url.toString().replace(/\/$/, ""), auth };
}

function attachProxyCredentials(proxy: string, auth: string): string {
  const url = new URL(proxy);
  const separator = auth.indexOf(":");
  const username = separator >= 0 ? auth.slice(0, separator) : auth;
  const password = separator >= 0 ? auth.slice(separator + 1) : "";
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  return url.toString().replace(/\/$/, "");
}

function isSocksProxy(proxy: string): boolean {
  return /^socks5h?:/i.test(proxy);
}

/**
 * 把任意 HTTP/SOCKS 代理包装成 undici Dispatcher。
 *
 * SOCKS 的 connector 需要自己做 TLS：undici 把原始 socket 交给上层时，
 * https 目标必须在这里完成 TLS 握手，否则请求会以明文 HTTP 发给 443。
 */
export function createProxyDispatcher(proxy: string): Dispatcher {
  if (!isSocksProxy(proxy)) return new ProxyAgent(proxy);

  const url = new URL(proxy);
  const proxyPort = Number(url.port || 1080);
  const userId = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;

  return new Agent({
    connect: (options, callback) => {
      SocksClient.createConnection({
        proxy: {
          host: url.hostname,
          port: proxyPort,
          type: 5,
          userId,
          password,
        },
        command: "connect",
        destination: {
          host: options.hostname,
          port: Number(options.port || (options.protocol === "https:" ? 443 : 80)),
        },
        timeout: 10_000,
      })
        .then(({ socket }) => {
          if (options.protocol !== "https:") {
            callback(null, socket);
            return;
          }
          const secure = tls.connect({
            socket,
            servername: options.servername || options.hostname,
          });
          secure.once("secureConnect", () => callback(null, secure));
          secure.once("error", (err) => callback(err, null));
        })
        .catch((err) => callback(err, null));
    },
  });
}

function mergedNoProxy(value?: string): string {
  const items = [DEFAULT_NO_PROXY, value ?? ""]
    .join(",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(items)].join(",");
}

/**
 * 启动时应用配置里的代理。
 *
 * 只应在 CLI 进程入口调用一次；它会把 undici 的全局 dispatcher 换成 ProxyAgent，
 * 因此当前进程内所有 `fetch`（Gemini/Anthropic 的默认实现）与显式传入
 * undici fetch 的 OpenAI Provider 都会走代理。
 */
export function applyProxyConfig(config: XuanZhuConfig): AppliedProxy {
  const raw = config.network?.proxy?.trim();
  if (
    !raw ||
    config.network?.enabled === false ||
    config.network?.lastCheckOk === false
  ) {
    activeProxy = undefined;
    proxyDispatcher = undefined;
    noProxyEntries = [];
    // 恢复原始 fetch（测试/同一进程重新应用配置时）
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
    delete process.env.XZH_PROXY_ACTIVE;
    delete process.env.XZH_PROXY_URL;
    return {
      active: false,
      error:
        config.network?.lastCheckOk === false
          ? "上次代理测试未通过，本次已跳过；运行 `xzh vpn` 在菜单中重新测试并启用。"
          : undefined,
    };
  }

  let proxy: string;
  try {
    proxy = normalizeProxyUrl(raw);
    if (config.network?.proxyAuthId) {
      const auth = loadSecret(config.network.proxyAuthId);
      if (!auth) {
        return {
          active: false,
          error: "代理认证凭据不存在或无法解密；请运行 `xzh vpn` 重新设置代理。",
        };
      }
      proxy = attachProxyCredentials(proxy, auth);
    }
  } catch (err) {
    return {
      active: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const noProxy = mergedNoProxy(config.network?.noProxy);
  noProxyEntries = parseNoProxy(noProxy);
  try {
    proxyDispatcher = createProxyDispatcher(proxy);
    setGlobalDispatcher(proxyDispatcher);
    // Gemini SDK 使用全局 fetch；替换成能识别 NO_PROXY 的版本。
    // OpenAI/Anthropic 会显式传入 proxyFetch（见各自 Provider）。
    (globalThis as { fetch?: unknown }).fetch = proxyFetch;
  } catch (err) {
    proxyDispatcher = undefined;
    return {
      active: false,
      error: `初始化代理失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // bash 子进程（curl / git / npm / pip）通过环境变量使用代理；
  // HTTP 代理同时设置 HTTP(S)_PROXY；SOCKS 只设 ALL_PROXY（很多工具不接受
  // 把 socks URL 填进 HTTP_PROXY）。本机地址始终绕过。
  process.env.ALL_PROXY = proxy;
  if (isSocksProxy(proxy)) {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
  } else {
    process.env.HTTP_PROXY = proxy;
    process.env.HTTPS_PROXY = proxy;
  }
  process.env.NO_PROXY = noProxy;
  process.env.no_proxy = noProxy;
  process.env.XZH_PROXY_ACTIVE = "1";
  process.env.XZH_PROXY_URL = proxy;

  activeProxy = proxy;
  return { active: true, proxy, noProxy };
}

/** 当前进程是否已启用配置代理 */
export function isProxyActive(): boolean {
  return isProxyActiveInternal() || process.env.XZH_PROXY_ACTIVE === "1";
}

/** 当前代理地址（未启用返回 undefined） */
export function currentProxyUrl(): string | undefined {
  return activeProxy || process.env.XZH_PROXY_URL;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`代理测试超时（${timeoutMs}ms）`)),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface ProxyProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * 通过代理访问一个中立的 204 端点，确认 TCP + TLS + CONNECT 都能走通。
 * 只测试代理本身，不影响全局 dispatcher。
 */
export async function probeProxy(
  raw: string,
  timeoutMs = 8_000,
): Promise<ProxyProbeResult> {
  let proxy: string;
  try {
    proxy = normalizeProxyUrl(raw);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const dispatcher = createProxyDispatcher(proxy);
  const targets = [
    "https://www.gstatic.com/generate_204",
    "https://api.github.com/rate_limit",
  ];
  try {
    for (const target of targets) {
      try {
        const response = await withTimeout(
          undiciFetch(target, {
            dispatcher,
            headers: { "user-agent": "xzh/1.0" },
          }),
          timeoutMs,
        );
        const status = response.status;
        await response.body?.cancel();
        if (status >= 200 && status < 400) {
          return { ok: true, status };
        }
      } catch {
        // 换下一个目标再试
      }
    }
    return { ok: false, error: "代理连接失败（目标均不可达）" };
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

/** 测试直连（用于区分「代理坏了」还是「全网络都不通」） */
export async function probeDirect(timeoutMs = 5_000): Promise<boolean> {
  const dispatcher = new Agent();
  try {
    const response = await withTimeout(
      undiciFetch("https://www.gstatic.com/generate_204", {
        dispatcher,
        headers: { "user-agent": "xzh/1.0" },
      }),
      timeoutMs,
    );
    await response.body?.cancel();
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

/** 常见本机代理候选：HTTP 与 SOCKS5 都包含（v2ray 常见 1080/10808 是 SOCKS） */
export const COMMON_PROXY_CANDIDATES = [
  "http://127.0.0.1:10809",
  "http://127.0.0.1:7890",
  "http://127.0.0.1:7891",
  "http://127.0.0.1:2080",
  "http://127.0.0.1:8889",
  "socks5h://127.0.0.1:10808",
  "socks5h://127.0.0.1:1080",
  "socks5h://127.0.0.1:7891",
];

/** 并发探测本机常见代理，按候选顺序返回第一个可用项 */
export async function detectLocalProxy(
  timeoutMs = 4_000,
): Promise<{ url: string; status?: number } | null> {
  const results = await Promise.all(
    COMMON_PROXY_CANDIDATES.map(async (url) => ({
      url,
      result: await probeProxy(url, timeoutMs),
    })),
  );
  const found = results.find((item) => item.result.ok);
  return found
    ? { url: found.url, status: found.result.status }
    : null;
}

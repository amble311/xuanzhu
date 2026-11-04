import { fetch as undiciFetch, Agent } from "undici";
import type { XuanZhuConfig } from "../config/store";
import {
  applyProxyConfig,
  detectLocalProxy,
  type AppliedProxy,
} from "../network/proxy";

/**
 * btc 的**网络引导**：直连优先，不通再自动找本机代理。
 *
 * 为什么需要这一层：币安接口在大陆直连不通，而用户不一定知道要先 `xzh vpn`。
 * 之前的表现是「启动正常、第一次同步就报一串网络错误」，对新手等于劝退。
 *
 * 三条策略：
 * 1. **用户显式配了代理就用它**，不做直连探测 —— 他知道自己要翻墙，
 *    再探测一次只是白白多等 3 秒；
 * 2. 没配（或上次测试失败）→ 先 `probeDirect`，**探的是交易所自己的接口**
 *    （`fapi.binance.com/fapi/v1/ping`），不是 gstatic：能不能翻墙不重要，
 *    能不能连上币安才重要；
 * 3. 直连不通 → 并发探测本机常见代理端口，找到就**只对本次进程**生效
 *    （不写配置文件：没经用户确认的东西不该被持久化），并提示长期方案是 `xzh vpn`。
 *
 * 结果在进程内缓存：后端、巡检、工具调用共用一次探测，不会每个请求都试一遍。
 */

export type BtcNetworkMode = "direct" | "proxy" | "none";

export interface BtcNetworkBootstrap {
  mode: BtcNetworkMode;
  /** 实际使用的代理地址（`mode=proxy` 时） */
  proxy?: string;
  /** 给用户看的说明（启动提示里展示） */
  notes: string[];
  /** 是否命中进程内缓存 */
  cached?: boolean;
}

export interface BtcNetworkOptions {
  config: XuanZhuConfig;
  /** 注入探测函数（测试用；默认探币安 ping） */
  probeDirect?: () => Promise<boolean>;
  /** 注入本机代理探测（测试用；默认并发探测常见端口） */
  detectProxy?: () => Promise<{ url: string } | null>;
  /** 忽略缓存重新探测 */
  force?: boolean;
}

/** 直连探测目标：交易所自己的轻量接口，权重最低、不需要签名 */
const PING_URL = "https://fapi.binance.com/fapi/v1/ping";
const PING_TIMEOUT_MS = 3_000;

/** 直连能不能连上交易所（用独立 Agent，绕开已应用的代理） */
export async function probeExchangeDirect(): Promise<boolean> {
  const dispatcher = new Agent();
  try {
    const response = await undiciFetch(PING_URL, {
      dispatcher,
      headers: { "user-agent": "xzh-btc/1.0" },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

/**
 * 代理探测用的是 `detectLocalProxy()`（并发探常见端口的通用连通性）。
 *
 * 曾尝试把探测目标换成「经该代理访问 fapi 是否通」，结果在**不可用的 socks 代理**上
 * 会挂住（undici 的连接阶段不吃 AbortSignal），直接把后端启动卡死 —— 比误选更糟。
 * 所以这里保留已验证可用的实现，误选的风险由「取价失败 → 波动判断跳过」兜住。
 */
let cached: Promise<BtcNetworkBootstrap> | undefined;

/** 进程内只探测一次：后端/巡检/工具调用共用同一份结论 */
export async function ensureBtcNetwork(
  options: BtcNetworkOptions,
): Promise<BtcNetworkBootstrap> {
  if (!options.force) {
    if (cached) return { ...(await cached), cached: true };
    const pending = resolveNetwork(options).then((result) => {
      return result;
    });
    cached = pending;
    return pending;
  }
  cached = undefined;
  return resolveNetwork(options);
}

export function resetBtcNetworkCache(): void {
  cached = undefined;
}

async function resolveNetwork(
  options: BtcNetworkOptions,
): Promise<BtcNetworkBootstrap> {
  const { config } = options;
  const configured = config.network?.proxy?.trim();

  // 1) 用户显式配置了代理：直接用，不浪费一次直连探测
  if (configured && config.network?.enabled !== false && config.network?.lastCheckOk !== false) {
    const applied = applyProxyConfig(config);
    if (applied.active) {
      return { mode: "proxy", proxy: configured, notes: [] };
    }
    return {
      mode: "direct",
      notes: [`代理配置未生效：${applied.error ?? "未知原因"}`],
    };
  }

  // 2) 没配代理（或上次测试失败）：先试直连
  const probe = options.probeDirect ?? probeExchangeDirect;
  if (await probe()) {
    return {
      mode: "direct",
      notes:
        config.network?.lastCheckOk === false
          ? ["上次代理测试失败，但直连可用，本次走直连"]
          : [],
    };
  }

  // 3) 直连不通：并发探测本机常见代理，命中就临时应用
  const detect = options.detectProxy ?? (() => detectLocalProxy());
  const found = await detect();
  if (found) {
    const applied = applyProxyConfig({
      ...config,
      network: {
        ...config.network,
        enabled: true,
        proxy: found.url,
        lastCheckOk: true,
      },
    });
    if (applied.active) {
      return {
        mode: "proxy",
        proxy: found.url,
        notes: [
          `直连交易所不通，已自动改用本机代理 ${found.url}（仅本次运行；长期生效请运行 xzh vpn）`,
        ],
      };
    }
  }

  return {
    mode: "none",
    notes: [
      "直连交易所不通，也没找到本机代理：请先运行 xzh vpn 配置，或检查网络",
    ],
  };
}

export type { AppliedProxy };

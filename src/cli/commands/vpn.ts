import {
  loadConfig,
  maskProxyUrl,
  saveConfig,
  type NetworkSettings,
  type XuanZhuConfig,
} from "../../config/store";
import {
  detectLocalProxy,
  normalizeProxyUrl,
  probeDirect,
  probeProxy,
  splitProxyCredentials,
  type ProxyProbeResult,
} from "../../network/proxy";
import { deleteSecret, storeSecret } from "../../secrets/vault";
import { promptInput, promptSelect } from "../prompt";
import { ansi } from "../../utils/ansi";

const DEFAULT_NO_PROXY = "127.0.0.1,localhost,::1";
const PROXY_HINT =
  "http://127.0.0.1:10809 或 socks5h://127.0.0.1:10808";

function networkOf(config: XuanZhuConfig): NetworkSettings {
  return {
    ...(config.network ?? {}),
    noProxy: config.network?.noProxy?.trim() || DEFAULT_NO_PROXY,
  };
}

function showStatus(config: XuanZhuConfig): void {
  const net = networkOf(config);
  const proxy = net.proxy?.trim();
  const enabled = Boolean(proxy) && net.enabled !== false;
  const healthy = net.lastCheckOk !== false;

  process.stdout.write(`\n${ansi.bold}玄猪代理${ansi.reset}\n`);
  if (!proxy) {
    process.stdout.write(
      `  ${ansi.gray}状态：${ansi.reset}${ansi.yellow}未配置${ansi.reset}\n` +
        `  ${ansi.gray}地址：${ansi.reset}HTTP(S) 或 SOCKS5，例如 ${PROXY_HINT}\n`,
    );
    return;
  }

  process.stdout.write(
    `  ${ansi.gray}地址：${ansi.reset}${maskProxyUrl(proxy)}\n` +
      `  ${ansi.gray}状态：${ansi.reset}${
        enabled ? `${ansi.green}已启用${ansi.reset}` : `${ansi.yellow}已停用${ansi.reset}`
      }${healthy ? "" : ` ${ansi.red}（上次测试失败，启动时会跳过）${ansi.reset}`}\n` +
      `  ${ansi.gray}NO_PROXY：${ansi.reset}${net.noProxy}\n`,
  );
  if (net.lastCheckAt) {
    process.stdout.write(
      `  ${ansi.gray}最近测试：${ansi.reset}${net.lastCheckAt} · ${
        net.lastCheckOk
          ? `${ansi.green}通过${ansi.reset}`
          : `${ansi.red}失败${ansi.reset}`
      }\n`,
    );
  }
  if (/^socks5h?:/i.test(proxy)) {
    process.stdout.write(
      `${ansi.yellow}  提示：SOCKS 对 npm / pip 支持有限；这些工具建议同时开启 HTTP 入站。${ansi.reset}\n`,
    );
  }
}

function printProbe(result: ProxyProbeResult): void {
  if (result.ok) {
    process.stdout.write(
      `${ansi.green}✓ 代理可用${ansi.reset}${result.status ? `（HTTP ${result.status}）` : ""}\n`,
    );
  } else {
    process.stdout.write(
      `${ansi.red}✗ 代理不可用${ansi.reset}${result.error ? `：${result.error}` : ""}\n`,
    );
  }
}

/** 测试并保存；失败时不覆盖已有配置，除非用户选择强制保存 */
async function saveWithProbe(
  config: XuanZhuConfig,
  proxy: string,
  options: { force?: boolean; silent?: boolean } = {},
): Promise<boolean> {
  let normalized: string;
  try {
    normalized = normalizeProxyUrl(proxy);
  } catch (err) {
    process.stdout.write(
      `${ansi.red}${err instanceof Error ? err.message : String(err)}${ansi.reset}\n`,
    );
    return false;
  }

  const result = await probeProxy(normalized);
  if (!result.ok && !options.force) {
    process.stdout.write(
      `${ansi.red}代理测试失败：${result.error ?? "不可用"}${ansi.reset}\n` +
        `${ansi.gray}未保存；可返回菜单选择「探测本机代理」，或确认客户端已启动后重试。${ansi.reset}\n`,
    );
    return false;
  }

  const net = networkOf(config);
  const split = splitProxyCredentials(normalized);
  let authId: string | undefined;
  if (split.auth) {
    authId = storeSecret(split.auth, "代理认证");
  } else if (net.proxyAuthId) {
    deleteSecret(net.proxyAuthId);
  }
  config.network = {
    ...net,
    proxy: split.proxy,
    ...(authId ? { proxyAuthId: authId } : { proxyAuthId: undefined }),
    enabled: true,
    lastCheckAt: new Date().toISOString(),
    ...(result.ok ? { lastCheckOk: true } : { lastCheckOk: undefined }),
  };
  saveConfig(config);

  if (!options.silent) {
    process.stdout.write(
      `${ansi.green}✓ 已保存代理${ansi.reset} ${maskProxyUrl(split.proxy)}\n` +
        `  ${ansi.gray}${result.ok ? "连通性测试通过" : "未通过连通性测试（已强制保存）"}${ansi.reset}\n` +
        `  ${ansi.gray}下次启动 xzh 时自动用于模型请求与 bash 子进程；本机地址始终绕过。${ansi.reset}\n`,
    );
  }
  return true;
}

async function setProxy(config: XuanZhuConfig): Promise<void> {
  const raw = await promptInput(
    `请输入代理地址（HTTP 或 SOCKS5，例如 ${PROXY_HINT}）`,
    config.network?.proxy ?? "",
  );
  if (!raw.trim()) {
    process.stdout.write(`${ansi.gray}已取消。${ansi.reset}\n`);
    return;
  }

  const ok = await saveWithProbe(config, raw);
  if (ok) return;

  const choice = await promptSelect(
    "代理测试未通过，是否仍然保存？",
    [
      { label: "重新输入", value: "retry" },
      { label: "仍然保存", value: "force" },
      { label: "取消", value: "cancel" },
    ],
    2,
  );
  if (choice === "retry") return setProxy(config);
  if (choice === "force") {
    await saveWithProbe(config, raw, { force: true });
  } else {
    process.stdout.write(`${ansi.gray}已取消，配置未改动。${ansi.reset}\n`);
  }
}

async function testCurrentProxy(config: XuanZhuConfig): Promise<void> {
  const proxy = config.network?.proxy;
  if (!proxy) {
    process.stdout.write(
      `${ansi.yellow}尚未配置代理。${ansi.reset}请先选择「设置 / 修改代理」。\n`,
    );
    return;
  }

  let normalized: string;
  try {
    normalized = normalizeProxyUrl(proxy);
  } catch (err) {
    process.stdout.write(
      `${ansi.red}${err instanceof Error ? err.message : String(err)}${ansi.reset}\n`,
    );
    return;
  }

  process.stdout.write(
    `${ansi.gray}测试代理 ${maskProxyUrl(normalized)}…${ansi.reset}\n`,
  );
  const result = await probeProxy(normalized);
  printProbe(result);

  if (!result.ok) {
    const direct = await probeDirect();
    if (direct) {
      process.stdout.write(
        `${ansi.yellow}直连可用，代理不可用：请检查客户端 HTTP/SOCKS 入站端口，` +
          `或确认代理已启动。${ansi.reset}\n`,
      );
    }
  }

  config.network = {
    ...networkOf(config),
    lastCheckAt: new Date().toISOString(),
    lastCheckOk: result.ok,
  };
  saveConfig(config);
}

async function detectProxy(config: XuanZhuConfig): Promise<void> {
  process.stdout.write(
    `${ansi.gray}探测本机常见 HTTP/SOCKS 代理端口` +
      `（10809 / 7890 / 10808 / 1080 …）…${ansi.reset}\n`,
  );
  const found = await detectLocalProxy();
  if (!found) {
    process.stdout.write(
      `${ansi.yellow}未发现可用的本机 HTTP/SOCKS 代理。${ansi.reset}\n` +
        `${ansi.gray}请确认 v2rayN / Clash 已启动，并开启 HTTP 或 SOCKS 入站` +
        `（常见 HTTP 10809 / 7890，SOCKS 10808 / 1080）。${ansi.reset}\n`,
    );
    return;
  }

  process.stdout.write(
    `${ansi.green}✓ 发现可用代理${ansi.reset} ${maskProxyUrl(found.url)}\n`,
  );
  const use = await promptSelect(
    "要使用这个代理吗？",
    [
      { label: "使用", value: "use" },
      { label: "取消", value: "cancel" },
    ],
    0,
  );
  if (use === "use") await saveWithProbe(config, found.url);
}

async function toggleProxy(config: XuanZhuConfig): Promise<void> {
  const proxy = config.network?.proxy;
  if (!proxy) {
    process.stdout.write(
      `${ansi.yellow}尚未配置代理。${ansi.reset}请先选择「设置 / 修改代理」。\n`,
    );
    return;
  }
  const enabled = config.network?.enabled !== false;
  config.network = { ...networkOf(config), enabled: !enabled };
  saveConfig(config);
  process.stdout.write(
    enabled
      ? `${ansi.green}✓ 已停用代理${ansi.reset}${ansi.gray}（地址保留）${ansi.reset}\n`
      : `${ansi.green}✓ 已启用代理${ansi.reset}\n`,
  );
}

async function clearProxy(config: XuanZhuConfig): Promise<void> {
  if (!config.network?.proxy) {
    process.stdout.write(`${ansi.gray}尚未配置代理。${ansi.reset}\n`);
    return;
  }
  const choice = await promptSelect(
    "确认清除代理配置？",
    [
      { label: "清除", value: "clear" },
      { label: "取消", value: "cancel" },
    ],
    1,
  );
  if (choice !== "clear") {
    process.stdout.write(`${ansi.gray}已取消。${ansi.reset}\n`);
    return;
  }
  if (config.network.proxyAuthId) deleteSecret(config.network.proxyAuthId);
  config.network = {
    enabled: false,
    noProxy: config.network.noProxy || DEFAULT_NO_PROXY,
  };
  saveConfig(config);
  process.stdout.write(`${ansi.green}✓ 已清除代理配置。${ansi.reset}\n`);
}

/**
 * `xzh vpn` 只有一个入口：交互式菜单。
 * 使用方式与 `xzh model` 一致 —— 方向键 / 数字选择，Esc 退出。
 */
async function interactiveMenu(): Promise<void> {
  for (;;) {
    const config = loadConfig();
    showStatus(config);

    const action = await promptSelect(
      "请选择操作：",
      [
        { label: "设置 / 修改代理", value: "set", hint: "http / socks5" },
        { label: "探测本机代理", value: "detect", hint: "v2ray / clash" },
        { label: "测试当前代理", value: "test" },
        { label: "启用 / 停用代理", value: "toggle" },
        { label: "清除代理配置", value: "clear" },
        { label: "退出", value: "exit" },
      ],
      0,
    );

    switch (action) {
      case "set":
        await setProxy(config);
        break;
      case "detect":
        await detectProxy(config);
        break;
      case "test":
        await testCurrentProxy(config);
        break;
      case "toggle":
        await toggleProxy(config);
        break;
      case "clear":
        await clearProxy(config);
        break;
      default:
        process.stdout.write(`\n${ansi.gray}已退出代理设置。${ansi.reset}\n`);
        return;
    }
  }
}

export async function vpnCommand(args: string[]): Promise<void> {
  if (args.length > 0) {
    process.stdout.write(
      `${ansi.yellow}vpn 已改为交互式菜单，请直接运行：${ansi.reset}\n` +
        `  ${ansi.green}xzh vpn${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }
  await interactiveMenu();
}

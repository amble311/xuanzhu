import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AUTOJS6_APP_SERVER_PORT,
  AUTOJS6_PC_SERVER_PORT,
  buildDeviceSetupGuide,
  detectAndroidAbi,
  DEVICE_BRIDGE_PORT,
  DeviceBridge,
  DeviceControlClient,
  findLocalApk,
  isRunningOnAndroid,
  resolveDevicePort,
  AUTOJS6_RELEASES_URL,
} from "../../device";
import { ansi } from "../../utils/ansi";

/**
 * `xzh device` —— 与手机上的 AutoX.js / Auto.js 通信的**设备桥**。
 *
 * 等价于 VSCode 插件 Auto.js-Autox.js-VSCodeExt 的那套功能（把脚本推到手机运行、看日志），
 * 但不需要 VSCode：`serve` 在终端里常驻，其余子命令是**一次性命令**，
 * 通过桥上的本地 HTTP 控制通道（见 `DeviceBridge.handleHttp`）跟它说话。
 *
 * 用法：
 *   xzh device serve [--port 9317]     启动桥（前台常驻，Ctrl+C 停止）
 *   xzh device status                  查看桥与设备状态
 *   xzh device list                    列出已连接设备
 *   xzh device push <文件>             保存脚本到设备（不运行）
 *   xzh device run <文件>              保存脚本并立即运行
 *   xzh device stop [<文件>] [--all]   停止脚本（默认停止全部）
 *   xzh device logs [-n 50]            查看最近的设备日志
 *
 * 通用参数：`--port <端口>`（默认 9317，也可用环境变量 XZH_DEVICE_PORT）、
 *           `--device <名称或连接id>`（只对某台设备下发，默认全部）
 */
export async function deviceCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.error) {
    fail(parsed.error);
    return;
  }

  switch (parsed.sub) {
    case "serve":
    case "start":
      return serveBridge(parsed);
    case "connect":
      return connectAutoJs6(parsed);
    case "apk":
      return showApk(parsed);
    case "check":
      return checkDevice(parsed);
    case "shot":
    case "screenshot":
      return screenshotCommand(parsed);
    case "status":
      return showStatus(parsed);
    case "list":
    case "ls":
    case "devices":
      return listDevices(parsed);
    case "push":
    case "save":
      return sendScript(parsed, "save");
    case "run":
      return sendScript(parsed, "run");
    case "stop":
      return stopScript(parsed);
    case "logs":
    case "log":
      return showLogs(parsed);
    case "help":
    case "-h":
    case "--help":
    case undefined:
      printDeviceHelp();
      return;
    default:
      fail(`未知子命令：${parsed.sub}`, "可用：serve / status / list / push / run / stop / logs");
      return;
  }
}

// ------------------------------------------------------------------ 子命令

/** 启动桥并常驻，直到 Ctrl+C */
async function serveBridge(parsed: ParsedArgs): Promise<void> {
  const port = parsed.port;
  const bridge = new DeviceBridge({
    port,
    baseDir: process.cwd(),
    onStatus: (message) => process.stdout.write(`${ansi.gray}${message}${ansi.reset}\n`),
    onDeviceAttach: (device) =>
      process.stdout.write(
        `\n${ansi.green}●${ansi.reset} 设备已连接：${ansi.bold}${device.name}${ansi.reset}` +
          `${ansi.gray}（${device.kind === "autojs6" ? "AutoJs6" : "AutoX.js"}` +
          `${device.appVersionCode ? ` versionCode ${device.appVersionCode}` : ""}）${ansi.reset}\n`,
      ),
    onDeviceDetach: (device) =>
      process.stdout.write(
        `\n${ansi.yellow}○${ansi.reset} 设备已断开：${device.name}\n`,
      ),
    onLog: (entry) =>
      process.stdout.write(
        `${ansi.gray}[${entry.device}]${ansi.reset} ${entry.text}\n`,
      ),
  });

  // 一个端口被占**不该**让整个桥起不来：VSCode 的 AutoJs6 扩展与 Auto.js 插件
  // 恰好各占一个端口，做成"全有或全无"会让用户误以为 xzh 起不来 —— 而实际只需要
  // 其中一个可用。因此两边分别尝试，最后只在**两边都失败**时才算失败。
  let httpReady = false;
  try {
    await bridge.start();
    httpReady = true;
  } catch (err) {
    process.stdout.write(
      `\n${ansi.yellow}⚠ AutoX.js 监听未启动${ansi.reset}\n` +
        `${ansi.gray}${err instanceof Error ? err.message : String(err)}${ansi.reset}\n`,
    );
  }

  if (httpReady) {
    process.stdout.write(
      `\n${ansi.bold}设备桥已启动${ansi.reset}\n` +
        `  ${ansi.gray}AutoX.js 监听端口：${ansi.reset}${port}\n` +
        bridge
          .urls()
          .map((url) => `  ${ansi.gray}手机 AutoX.js 填：${ansi.reset}${ansi.brightGreen}${url}${ansi.reset}\n`)
          .join(""),
    );
  }

  // AutoJs6 那侧也监听上（手机「客户端模式」连过来）。
  // 与 9317 完全独立：端口被占（多半是 VSCode 的 AutoJs6 扩展）只提示、不中断另一边。
  let listenerReady = false;
  try {
    await bridge.startAutoJs6Listener();
    listenerReady = true;
  } catch (err) {
    process.stdout.write(
      `\n${ansi.yellow}⚠ AutoJs6 监听未启动${ansi.reset}\n` +
        `${ansi.gray}${err instanceof Error ? err.message : String(err)}${ansi.reset}\n` +
        `${ansi.gray}（AutoX.js 那侧不受影响，仍可正常使用）${ansi.reset}\n`,
    );
  }

  if (listenerReady) {
    process.stdout.write(
      `  ${ansi.gray}AutoJs6 监听端口：${ansi.reset}${AUTOJS6_PC_SERVER_PORT}` +
        `${ansi.gray}（手机点「连接电脑 → 客户端模式」填下面地址）${ansi.reset}\n` +
        bridge
          .listenerUrls()
          .map((url) => `  ${ansi.gray}手机 AutoJs6 填：${ansi.reset}${ansi.brightGreen}${url}${ansi.reset}\n`)
          .join(""),
    );
  }

  if (!httpReady && !listenerReady) {
    fail(
      "设备桥没能启动：两个监听端口都不可用。",
      "分别被 VSCode 的 Auto.js 插件（9317）与 AutoJs6 扩展（6347）占用时会这样 —— 禁用其一即可。",
    );
    await bridge.stop();
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `  ${ansi.gray}手机连上后即可推送脚本；日志会显示在这里。保持本窗口开启，停止：Ctrl+C${ansi.reset}\n\n`,
  );

  await stayAlive(() => bridge.stop());
}

/**
 * `xzh device connect <地址>` —— 主动连接手机上的 **AutoJs6（服务器模式）**。
 *
 * 与 `serve`（等手机上的 AutoX.js 连过来）互补：这条用于 AutoJs6，方向相反。
 * 两者都会把本地 HTTP 控制通道拉起来，因此 `xzh device run/logs/...` 对哪种
 * 连接都照常可用。
 *
 * 连不上时**必须给出引导**（这是用户第一次用时的唯一信息来源）：装 AutoJs6 →
 * 打开服务器模式 → 填手机 IP；手机本机运行时则不需要 IP（走 127.0.0.1）。
 * 注意连不上不等于进程结束 —— 客户端会在后台按退避继续重连，Ctrl+C 才退出。
 */
async function connectAutoJs6(parsed: ParsedArgs): Promise<void> {
  const onPhone = isRunningOnAndroid();
  const raw = parsed.positional[0]?.trim() ?? "";
  let host = "";
  let port = AUTOJS6_APP_SERVER_PORT;

  if (raw) {
    const match = /^(.*?)(?::(\d+))?$/.exec(raw);
    host = (match?.[1] ?? raw).trim();
    const parsedPort = match?.[2] ? Number.parseInt(match[2], 10) : NaN;
    if (Number.isFinite(parsedPort)) port = parsedPort;
  } else if (onPhone) {
    // 手机本机运行：AutoJs6 就在同一台设备上，不需要也不该让用户去查 IP
    host = "127.0.0.1";
  }

  if (!host) {
    fail("缺少手机地址", `用法：xzh device connect <手机IP>[:端口]（默认 ${AUTOJS6_APP_SERVER_PORT}）`);
    printSetupGuide({ where: onPhone ? "phone" : "pc" });
    return;
  }

  const bridge = new DeviceBridge({
    port: parsed.port,
    baseDir: process.cwd(),
    onStatus: (message) => process.stdout.write(`${ansi.gray}${message}${ansi.reset}\n`),
    onDeviceAttach: (device) =>
      process.stdout.write(`\n${ansi.green}●${ansi.reset} 手机已就绪：${device.name}\n`),
    onDeviceDetach: () => process.stdout.write(`\n${ansi.yellow}○${ansi.reset} 手机已断开\n`),
    onLog: (entry) =>
      process.stdout.write(`${ansi.gray}[${entry.device}]${ansi.reset} ${entry.text}\n`),
  });

  try {
    await bridge.connectAutoJs6(host, port);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  process.stdout.write(
    `\n${ansi.bold}正在连接手机${ansi.reset} ${ansi.brightGreen}${host}:${port}${ansi.reset}` +
      `${ansi.gray}（AutoJs6 服务器模式）${ansi.reset}\n`,
  );

  if (await waitForAutoJs6(bridge, 6_000)) {
    process.stdout.write(
      `${ansi.green}✓${ansi.reset} 已连接。可以推送脚本了：` +
        `${ansi.gray}xzh device run <脚本>${ansi.reset}\n\n`,
    );
  } else {
    const retrying = bridge.status().autojs6?.retrying ?? false;
    process.stdout.write(
      retrying
        ? `${ansi.yellow}暂时没连上${ansi.reset}${ansi.gray}，仍在后台按退避重试。${ansi.reset}\n\n`
        : `${ansi.red}连不上手机${ansi.reset}${ansi.gray}（已停止重试）。${ansi.reset}\n\n`,
    );
    printSetupGuide({ where: onPhone ? "phone" : "pc", address: `${host}:${port}` });

    if (!retrying) {
      // 已经放弃重试：留一个连不上的常驻进程只会让人以为"在等"。
      // 直接收尾并把退出码置为失败，用户改好配置再跑一次即可。
      await bridge.stop();
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`\n${ansi.gray}（Ctrl+C 退出）${ansi.reset}\n\n`);
  }

  await stayAlive(() => bridge.stop());
}

/**
 * `xzh device apk` —— 告诉用户该装哪个 AutoJs6 安装包、去哪里装。
 *
 * 玄猪**不打包 APK**（每个 ABI 130 MB 上下，进 npm 包不划算），因此这里只做
 * ABI 探测 + 官方下载地址 + 本机缓存提示。
 */
async function showApk(_parsed: ParsedArgs): Promise<void> {
  printSetupGuide({ where: isRunningOnAndroid() ? "phone" : "pc" });
}

/**
 * `xzh device check` —— **首次连接后的体检**：手机能不能被操作。
 *
 * 为什么要单独做一条命令：,能不能操作手机"取决于**无障碍服务**是否真的在运行，
 * 而这是手机侧的状态，xzh 从连接信息里看不出来。实测踩过的两种状态都很隐蔽：
 *   - 报 `无障碍服务未启动`：设置里根本没开；
 *   - 报 `无障碍服务已启用但未运行`：开了但被系统判定没跑起来（要关掉再开或重启）。
 *
 * 体检脚本刻意做了三件事：用 `auto.waitFor(8000)`（**带超时**，避免永久挂住）、
 * 每一步都 `toastLog` 回报（xzh 只能通过日志看结果）、异常也回报成一行结论。
 * 这样无论成功、失败还是卡住，xzh 都能给用户一句明确的下一步。
 */
/**
 * `xzh device shot [输出文件]` —— 截取手机当前屏幕并保存到本地。
 *
 * 实现在桥里（`DeviceBridge.screenshot()`），CLI 只是触发并落盘 —— 因为"自动点系统授权框"
 * 那段样板必须内置（见 `src/device/screenshot.ts`）：`captureScreen()` 会**阻塞**等授权，
 * 而授权框**每次截图都会弹**（真机实测）。
 */
async function screenshotCommand(parsed: ParsedArgs): Promise<void> {
  const client = new DeviceControlClient(parsed.port);
  const devices = await client.devices();
  if (!devices) {
    fail(`连不上设备桥（127.0.0.1:${parsed.port}）`, "先启动：xzh device serve");
    return;
  }
  if (devices.length === 0) {
    fail("没有已连接的手机", "先让手机连上：手机 AutoJs6「连接电脑 → 客户端模式」");
    return;
  }

  process.stdout.write(
    `\n${ansi.gray}正在让手机截图…（会弹系统授权框，脚本会自动点「立即开始」）${ansi.reset}\n`,
  );
  const result = await client.screenshot();
  if (!result.ok) {
    fail(result.message);
    return;
  }

  const target =
    parsed.positional.find((arg) => !arg.startsWith("-")) ??
    path.join(process.cwd(), `xzh-shot-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`);
  try {
    // Buffer 与 Uint8Array 的泛型摩擦（同 autojs6/protocol.ts 的说明），运行时无差异
    fs.writeFileSync(target, result.data as unknown as Uint8Array);
  } catch (err) {
    fail(`保存截图失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  process.stdout.write(
    `${ansi.green}✓ 已保存${ansi.reset} ${target} ${ansi.gray}（${Math.round(
      result.data.length / 1024,
    )} KB，JPEG）${ansi.reset}\n\n`,
  );
}

async function checkDevice(parsed: ParsedArgs): Promise<void> {
  const client = new DeviceControlClient(parsed.port);
  const devices = await client.devices();
  if (!devices) {
    fail(`连不上设备桥（127.0.0.1:${parsed.port}）`, "先启动：xzh device serve");
    return;
  }
  if (devices.length === 0) {
    fail("没有已连接的手机", "先让手机连上：手机 AutoJs6「连接电脑 → 客户端模式」");
    return;
  }

  const probe = path.join(os.tmpdir(), `xzh-device-check-${Date.now()}.js`);
  fs.writeFileSync(
    probe,
    [
      "// 由 xzh device check 生成：探测无障碍服务与设备信息",
      "try {",
      "  auto.waitFor(8000);",
      "  if (!auto.isRunning()) {",
      '    toastLog("【体检】无障碍=未就绪（服务没真正运行）");',
      "  } else {",
      '    toastLog("【体检】无障碍=已就绪");',
      '    toastLog("【体检】设备=" + device.brand + " " + device.model + " " + device.width + "x" + device.height);',
      '    toastLog("【体检】当前界面=" + currentPackage() + " / " + currentActivity());',
      '    toastLog("【体检】结论=可以操作手机");',
      "  }",
      "} catch (e) {",
      '  toastLog("【体检】无障碍=异常：" + e);',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const before = (await client.logs(1))?.length ?? 0;
  const result = await client.exec("run", probe);
  if (!result.ok) {
    fs.rmSync(probe, { force: true });
    fail(result.message ?? "体检脚本未能送达");
    return;
  }
  process.stdout.write(
    `\n${ansi.gray}已在手机上运行体检脚本，等待回报…（最多 15 秒）${ansi.reset}\n`,
  );

  // 等脚本回报：waitFor 最多阻塞 8 秒，因此这里给足 15 秒
  const deadline = Date.now() + 15_000;
  let reported: string[] = [];
  while (Date.now() < deadline) {
    const logs = (await client.logs(40)) ?? [];
    reported = logs.map((entry) => entry.text).filter((text) => text.includes("【体检】"));
    if (reported.some((text) => text.includes("结论=") || text.includes("异常") || text.includes("未就绪"))) {
      break;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  void before;
  fs.rmSync(probe, { force: true });

  // 结论分支：三种情况都给用户**明确的下一步**
  if (reported.some((text) => text.includes("结论=可以操作手机"))) {
    process.stdout.write(`${ansi.green}✓ 可以操作手机${ansi.reset}\n`);
    for (const line of reported) {
      process.stdout.write(`${ansi.gray}  ${line.replace("【体检】", "")}${ansi.reset}\n`);
    }
    process.stdout.write(
      `${ansi.gray}  接下来可以直接让玄猪操作手机（它会先加载 autojs6 技能）。${ansi.reset}\n\n`,
    );
    return;
  }

  if (reported.length === 0) {
    process.stdout.write(
      `${ansi.red}✗ 手机没有回报${ansi.reset}${ansi.gray} —— 脚本很可能**卡在等待无障碍服务**。${ansi.reset}\n`,
    );
  } else {
    process.stdout.write(`${ansi.red}✗ 无障碍服务不可用${ansi.reset}\n`);
    for (const line of reported) {
      process.stdout.write(`${ansi.gray}  ${line.replace("【体检】", "")}${ansi.reset}\n`);
    }
  }

  process.stdout.write(
    `\n${ansi.bold}处理办法${ansi.reset}\n` +
      `  1. 手机上打开 AutoJs6 → 侧边栏「服务」→ 打开「无障碍服务」\n` +
      `  2. 若**已经开着**却仍失败（提示"已启用但未运行"）：把它关掉再打开，或重启手机\n` +
      `  3. 若脚本还挂着，先收掉它：${ansi.reset}xzh device stop\n` +
      `${ansi.gray}  说明：没有无障碍服务，xzh 只能推送脚本，无法点击/滑动/读取界面。${ansi.reset}\n\n`,
  );
  process.exitCode = 1;
}

// ------------------------------------------------------------------ 引导与等待

/** 打印「首次连接手机」的引导（ABI 探测 + 官方地址 + 本机缓存） */
function printSetupGuide(options: {
  where: "pc" | "phone";
  address?: string;
}): void {
  const detection = detectAndroidAbi();
  const guide = buildDeviceSetupGuide({
    where: options.where,
    abi: detection.abi,
    address: options.address,
    localApk: findLocalApk(detection.abi),
  });
  process.stdout.write(
    `\n${ansi.bold}${ansi.yellow}需要先装 AutoJs6${ansi.reset}` +
      `${ansi.gray}（${detection.detail}）${ansi.reset}\n\n`,
  );
  for (const line of guide.split("\n")) {
    process.stdout.write(`${line ? `${ansi.gray}${line}${ansi.reset}` : ""}\n`);
  }
  process.stdout.write("\n");
}

/** 等桥那边的 AutoJs6 连接就绪 */
async function waitForAutoJs6(bridge: DeviceBridge, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bridge.status().autojs6?.connected) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return bridge.status().autojs6?.connected ?? false;
}

/** 常驻直到 Ctrl+C / SIGTERM，然后执行收尾 */
function stayAlive(stop: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    let stopping = false;
    const finish = () => {
      if (stopping) return;
      stopping = true;
      process.stdout.write(`\n${ansi.gray}正在停止设备桥…${ansi.reset}\n`);
      void stop().finally(() => resolve());
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

/** 查看桥与设备状态 */
async function showStatus(parsed: ParsedArgs): Promise<void> {
  const client = new DeviceControlClient(parsed.port);
  const status = await client.status();
  if (!status) {
    process.stdout.write(
      `${ansi.yellow}设备桥未运行${ansi.reset}` +
        `${ansi.gray}（127.0.0.1:${parsed.port}）${ansi.reset}\n` +
        `${ansi.gray}启动：xzh device serve${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n${ansi.green}●${ansi.reset} 设备桥运行中\n`);
  if (status.urls.length > 0) {
    process.stdout.write(
      `  ${ansi.gray}AutoX.js 监听端口：${ansi.reset}${status.port}\n` +
        status.urls
          .map((url) => `    ${ansi.gray}手机 AutoX.js 填：${ansi.reset}${url}\n`)
          .join(""),
    );
  }
  if (status.autojs6Listener) {
    process.stdout.write(
      `  ${ansi.gray}AutoJs6 监听端口：${ansi.reset}${status.autojs6Listener.port}\n` +
        status.autojs6Listener.urls
          .map((url) => `    ${ansi.gray}手机 AutoJs6 填：${ansi.reset}${url}\n`)
          .join(""),
    );
  }
  if (status.autojs6) {
    process.stdout.write(
      `  ${ansi.gray}AutoJs6 出站连接：${ansi.reset}${status.autojs6.address} ` +
        (status.autojs6.connected
          ? `${ansi.green}已连接${ansi.reset}\n`
          : status.autojs6.retrying
            ? `${ansi.yellow}连接中/等待重试${ansi.reset}\n`
            : `${ansi.red}已放弃重试${ansi.reset}\n`),
    );
  }

  process.stdout.write(
    `  ${ansi.gray}已连接设备：${ansi.reset}${status.devices.length}\n`,
  );
  for (const device of status.devices) {
    const kind = device.kind === "autojs6" ? "AutoJs6" : "AutoX.js";
    process.stdout.write(
      `    ${ansi.cyan}${device.name}${ansi.reset} ${ansi.gray}${device.id} · ${kind}${
        device.appVersionCode ? ` versionCode ${device.appVersionCode}` : ""
      }${ansi.reset}\n`,
    );
  }
  process.stdout.write("\n");
}

/** 列出设备 */
async function listDevices(parsed: ParsedArgs): Promise<void> {
  const client = new DeviceControlClient(parsed.port);
  const devices = await client.devices();
  if (!devices) {
    fail(`连不上设备桥（127.0.0.1:${parsed.port}）`, "先启动：xzh device serve");
    return;
  }
  if (devices.length === 0) {
    const status = await client.status();
    process.stdout.write(`${ansi.yellow}当前没有已连接的设备${ansi.reset}\n`);
    // 按**当前实际在监听的方向**给指引，否则用户会去填一个自己没在用的地址
    if (status?.autojs6Listener) {
      process.stdout.write(
        `${ansi.gray}手机 AutoJs6「连接电脑 → 客户端模式」填：${ansi.reset}` +
          `${status.autojs6Listener.urls.join(" 或 ")}\n`,
      );
    }
    if (status?.urls.length) {
      process.stdout.write(
        `${ansi.gray}手机 AutoX.js 填：${ansi.reset}${status.urls.join(" 或 ")}\n`,
      );
    }
    if (status?.autojs6) {
      process.stdout.write(
        `${ansi.gray}AutoJs6 出站连接：${ansi.reset}${status.autojs6.address} ` +
          (status.autojs6.retrying ? "（连接中/等待重试）" : "（已放弃重试）") +
          "\n",
      );
    }
    return;
  }
  process.stdout.write(`\n${ansi.bold}已连接设备（${devices.length}）${ansi.reset}\n`);
  for (const device of devices) {
    const kind = device.kind === "autojs6" ? "AutoJs6" : "AutoX.js";
    process.stdout.write(
      `  ${ansi.cyan}${device.name}${ansi.reset} ${ansi.gray}${device.id} · ${kind}` +
        `${device.appVersionCode ? ` versionCode ${device.appVersionCode}` : ""}${ansi.reset}\n`,
    );
  }
  process.stdout.write("\n");
}

/** 推送脚本（save）或推送并运行（run） */
async function sendScript(parsed: ParsedArgs, cmd: "save" | "run"): Promise<void> {
  const file = parsed.positional[0];
  if (!file) {
    fail(`用法：xzh device ${parsed.sub} <脚本文件>`);
    return;
  }
  const client = new DeviceControlClient(parsed.port);
  const result = await client.exec(cmd, file, parsed.device);
  if (!result.ok) {
    fail(result.message ?? "指令失败");
    return;
  }
  const verb = cmd === "run" ? "已推送到设备并开始运行" : "已保存到设备";
  process.stdout.write(
    `${ansi.green}✓${ansi.reset} ${verb}：${result.path}\n` +
      `${ansi.gray}  目标设备（${result.delivered}）：${(result.devices ?? []).join("、")}${ansi.reset}\n` +
      (cmd === "run"
        ? `${ansi.gray}  查看输出：xzh device logs${ansi.reset}\n`
        : ""),
  );
}

/** 停止脚本 */
async function stopScript(parsed: ParsedArgs): Promise<void> {
  const client = new DeviceControlClient(parsed.port);
  const file = parsed.all ? undefined : parsed.positional[0];
  const result = await client.exec(
    file ? "stop" : "stopAll",
    file,
    parsed.device,
  );
  if (!result.ok) {
    fail(result.message ?? "停止失败");
    return;
  }
  process.stdout.write(
    `${ansi.green}✓${ansi.reset} ${file ? `已停止 ${file}` : "已停止全部脚本"}\n`,
  );
}

/** 查看最近的设备日志 */
async function showLogs(parsed: ParsedArgs): Promise<void> {
  const client = new DeviceControlClient(parsed.port);
  const logs = await client.logs(parsed.limit);
  if (!logs) {
    fail(`连不上设备桥（127.0.0.1:${parsed.port}）`, "先启动：xzh device serve");
    return;
  }
  if (logs.length === 0) {
    process.stdout.write(`${ansi.gray}暂无设备日志。${ansi.reset}\n`);
    return;
  }
  process.stdout.write(`\n${ansi.bold}最近 ${logs.length} 条设备日志${ansi.reset}\n`);
  for (const entry of logs) {
    const time = new Date(entry.at).toLocaleTimeString();
    process.stdout.write(
      `${ansi.gray}${time} [${entry.device}]${ansi.reset} ${entry.text}\n`,
    );
  }
  process.stdout.write("\n");
}

function printDeviceHelp(): void {
  process.stdout.write(`
${ansi.bold}xzh device${ansi.reset} ${ansi.gray}—— 与手机上的 AutoX.js / Auto.js 通信（设备桥）${ansi.reset}

${ansi.bold}用法${ansi.reset}
  ${ansi.green}xzh device connect <手机IP>${ansi.reset} ${ansi.gray}[:端口]${ansi.reset}
                          连接手机上的 AutoJs6（服务器模式，默认 ${AUTOJS6_APP_SERVER_PORT}）并常驻。
                          手机本机运行时可省略地址（自动用 127.0.0.1）
  ${ansi.green}xzh device serve${ansi.reset} ${ansi.gray}[--port 9317]${ansi.reset}
                          反向：等手机上的 AutoX.js 连过来（手机端填它打印的 ws:// 地址）
  ${ansi.green}xzh device apk${ansi.reset}        该装哪个 AutoJs6 安装包、去哪里下载
  ${ansi.green}xzh device check${ansi.reset}      ${ansi.gray}体检：无障碍是否就绪、能否操作手机（首次连接后先跑它）${ansi.reset}
  ${ansi.green}xzh device shot${ansi.reset} ${ansi.gray}[输出文件]${ansi.reset}
                          截取手机当前屏幕，保存为 JPEG（授权框会自动点掉）
  ${ansi.green}xzh device status${ansi.reset}      查看桥与设备状态
  ${ansi.green}xzh device list${ansi.reset}        列出已连接设备
  ${ansi.green}xzh device push <文件>${ansi.reset} 把脚本保存到设备（不运行）
  ${ansi.green}xzh device run <文件>${ansi.reset}  把脚本推到设备并立即运行
  ${ansi.green}xzh device stop${ansi.reset} ${ansi.gray}[<文件>] [--all]${ansi.reset}
                          停止脚本（默认停止全部；给文件则只停那一个）
  ${ansi.green}xzh device logs${ansi.reset} ${ansi.gray}[-n 50]${ansi.reset}
                          查看最近的设备日志

${ansi.bold}通用参数${ansi.reset}
  ${ansi.gray}--port <端口>${ansi.reset}     默认 ${DEVICE_BRIDGE_PORT}（也可用环境变量 XZH_DEVICE_PORT）
  ${ansi.gray}--device <名称>${ansi.reset}   只对某台设备下发指令（默认全部）

${ansi.bold}两种连接方式${ansi.reset}
  · ${ansi.green}AutoJs6${ansi.reset}（推荐）：手机上打开「连接电脑 → 服务器模式」，再用
    xzh device connect <手机IP> 主动连过去。手机与电脑同一局域网即可。
  · ${ansi.green}AutoX.js${ansi.reset}：xzh device serve 之后，手机端填它打印的 ws:// 地址。

${ansi.bold}注意${ansi.reset}
  · serve 会占用 ${DEVICE_BRIDGE_PORT} 端口：${ansi.yellow}VSCode 的 Auto.js 插件用同一个端口，两者不能同时开${ansi.reset}。
  · 只做单文件推送（运行 / 保存 / 停止 / 日志），项目级（zip）同步请用 VSCode 插件。
  · 玄猪不打包 AutoJs6 安装包（每个 ABI 约 130 MB），由 ${ansi.reset}${AUTOJS6_RELEASES_URL}${ansi.gray} 自行下载。
  · 在 xzh 界面内也可以操作：${ansi.green}/device${ansi.reset}（见 /help）。
`);
}

// ------------------------------------------------------------------ 参数

interface ParsedArgs {
  sub: string | undefined;
  positional: string[];
  /** 只对某台设备下发 */
  device?: string;
  port: number;
  /** 日志条数 */
  limit: number;
  /** stop --all */
  all: boolean;
  error?: string;
}

/** 取值型开关 */
const VALUE_FLAGS = new Set(["--port", "--device", "-n", "--limit"]);

/** 布尔型开关（其余以 `-` 开头的一律报错，避免把拼错的参数当成文件名） */
const BOOLEAN_FLAGS = new Set(["--all", "-h", "--help"]);

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    sub: undefined,
    positional: [],
    port: resolveDevicePort(),
    limit: 50,
    all: false,
  };
  const rest = [...args];

  parsed.sub = rest.shift();
  while (rest.length > 0) {
    const arg = rest.shift() as string;
    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === "--all") parsed.all = true;
      // -h/--help 出现在子命令之后时，由各子命令自行忽略（放到 positional 里最省事）
      else parsed.positional.push(arg);
      continue;
    }
    if (arg === "--") {
      parsed.positional.push(...rest);
      break;
    }
    const eq = /^(--[a-z-]+)=(.*)$/.exec(arg);
    if (eq) {
      applyValue(parsed, eq[1], eq[2]);
      if (parsed.error) return parsed;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = rest.shift();
      if (value === undefined) {
        return { ...parsed, error: `${arg} 缺少取值` };
      }
      applyValue(parsed, arg, value);
      if (parsed.error) return parsed;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      return { ...parsed, error: `未知参数：${arg}` };
    }
    parsed.positional.push(arg);
  }
  return parsed;
}

function applyValue(parsed: ParsedArgs, flag: string, value: string): void {
  switch (flag) {
    case "--port": {
      const port = Number.parseInt(value, 10);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        parsed.error = `端口不合法：${value}`;
        return;
      }
      parsed.port = port;
      return;
    }
    case "--device":
      parsed.device = value;
      return;
    case "-n":
    case "--limit": {
      const limit = Number.parseInt(value, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        parsed.error = `条数不合法：${value}`;
        return;
      }
      parsed.limit = limit;
      return;
    }
    default:
      parsed.error = `未知参数：${flag}`;
  }
}

function fail(message: string, hint?: string): void {
  process.stdout.write(`${ansi.red}✗ ${message}${ansi.reset}\n`);
  if (hint) process.stdout.write(`${ansi.gray}  ${hint}${ansi.reset}\n`);
  process.exitCode = 1;
}

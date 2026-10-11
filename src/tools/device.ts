import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildUiDumpScript,
  DeviceControlClient,
  resolveDevicePort,
  UI_DUMP_MAX_NODES,
  type DeviceBridge,
  type DeviceInfo,
} from "../device";
import { expandHome } from "../utils/paths";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";

/**
 * 与**手机**（AutoX.js / Auto.js）交互的工具。
 *
 * 定位：手机是「另一个运行环境」，xzh 通过设备桥把脚本推过去跑、并回收脚本日志 ——
 * 与 VSCode 插件的 `Run` / `Save` 等价，只是换成由 Agent 自己来操作。
 *
 * 桥有两种存在形式，工具都能用：
 *   1. **xzh 进程内**（TUI 里 `/device serve`）—— 直接调 `DeviceBridge` 的方法；
 *   2. **另一个进程**（`xzh device serve`）—— 走桥上的本地 HTTP 控制通道。
 * 这样"agent 自己连手机"和"用户先开着桥、再让 agent 推脚本"两种用法都成立。
 *
 * 桥**不会**由工具自行启动：它要占端口、还要用户在手机上点连接，隐式启动只会让状态难以理解。
 * 没启动时工具会明确给出启动方式。
 */

interface DeviceSummary {
  name: string;
  id: string;
  appVersionCode: number;
}

interface DeviceActionResult {
  ok: boolean;
  message?: string;
  path?: string;
  delivered?: number;
  devices?: string[];
}

interface DeviceLogLine {
  device: string;
  text: string;
}

/** 两种桥来源归一化后的操作集合 */
interface DeviceOps {
  /** 来源说明（结果摘要里带上，便于排查"连的到底是哪个桥"） */
  source: string;
  list(): Promise<DeviceSummary[] | null>;
  push(file: string, target?: string): Promise<DeviceActionResult>;
  run(file: string, target?: string): Promise<DeviceActionResult>;
  stop(file: string | undefined, target?: string): Promise<DeviceActionResult>;
  logs(limit: number): Promise<DeviceLogLine[] | null>;
  /** 截取手机当前屏幕；成功返回 JPEG 字节（由桥负责生成脚本、推给手机、等图片回传） */
  screenshot(): Promise<{ ok: true; data: Buffer } | { ok: false; message: string }>;
}

function buildOps(ctx: ToolContext): DeviceOps {
  const bridge: DeviceBridge | undefined = ctx.deviceBridge;
  if (bridge?.isRunning()) {
    return {
      source: `xzh 内置设备桥（端口 ${bridge.getPort()}）`,
      list: async () =>
        bridge.listDevices().map((device: DeviceInfo) => ({
          name: device.name,
          id: device.id,
          appVersionCode: device.appVersionCode,
        })),
      push: async (file, target) => bridge.pushScript(file, target),
      run: async (file, target) => bridge.runScript(file, target),
      stop: async (file, target) => bridge.stopScript(file, target),
      logs: async (limit) =>
        bridge.recentLogs(limit).map((entry) => ({
          device: entry.device,
          text: entry.text,
        })),
      screenshot: async () => bridge.screenshot(),
    };
  }

  const port = resolveDevicePort();
  const client = new DeviceControlClient(port);
  return {
    source: `设备桥（127.0.0.1:${port}）`,
    list: async () => {
      const devices = await client.devices();
      return devices
        ? devices.map((device) => ({
            name: device.name,
            id: device.id,
            appVersionCode: device.appVersionCode,
          }))
        : null;
    },
    push: async (file, target) => client.exec("save", file, target),
    run: async (file, target) => client.exec("run", file, target),
    stop: async (file, target) => client.exec(file ? "stop" : "stopAll", file, target),
    screenshot: async () => client.screenshot(),
    logs: async (limit) => {
      const logs = await client.logs(limit);
      return logs ? logs.map((entry) => ({ device: entry.device, text: entry.text })) : null;
    },
  };
}

/** 桥不可达时的统一提示（把"怎么启动"直接写清楚，避免模型自行猜测） */
function notRunning(ops: DeviceOps): ToolResult {
  return {
    ok: false,
    content:
      `设备桥不可用（${ops.source}）。\n` +
      "请让用户先把手机连上，任选其一：\n" +
      "· AutoJs6（推荐）：手机上打开「连接电脑 → 服务器模式」，然后在 xzh 里执行 " +
      "`/device connect <手机IP>`（手机本机运行时不用填 IP）；\n" +
      "· AutoX.js：`/device serve`，再让手机填它打印出的 ws:// 地址。\n" +
      "另开一个终端跑 `xzh device connect <手机IP>` / `xzh device serve` 也可以。\n" +
      "若手机还没装 AutoJs6，用 `xzh device apk` 查看该装哪个版本（玄猪不打包安装包）。",
  };
}

/** 把参数里的相对路径按当前工作目录解析成绝对路径 */
function resolveInputPath(ctx: ToolContext, input: string): string {
  const expanded = input.startsWith("~")
    ? path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? "",
        input.slice(1),
      )
    : input;
  return path.isAbsolute(expanded) ? expanded : path.resolve(ctx.cwd, expandHome(expanded));
}

function formatDevices(devices: DeviceSummary[]): string {
  return devices
    .map((device) => `- ${device.name}（${device.id}，AutoX.js versionCode ${device.appVersionCode}）`)
    .join("\n");
}

// ------------------------------------------------------------------ 工具定义

const deviceListTool: ToolDefinition = {
  name: "device_list",
  description:
    "列出当前已连接的手机设备（通过设备桥连上来的 AutoX.js / Auto.js）。" +
    "推脚本或运行脚本之前先看一眼，确认手机是否已连上。",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx): Promise<ToolResult> {
    const ops = buildOps(ctx);
    const devices = await ops.list();
    if (!devices) return notRunning(ops);
    if (devices.length === 0) {
      return {
        ok: true,
        content:
          `没有已连接的设备（${ops.source}）。` +
          "请确认手机与电脑在同一网络，且手机上的 AutoX.js 已连接到桥打印出的 ws:// 地址。",
        summary: "0 台设备",
      };
    }
    return {
      ok: true,
      content: `已连接 ${devices.length} 台设备：\n${formatDevices(devices)}`,
      summary: `${devices.length} 台设备`,
    };
  },
};

const devicePushTool: ToolDefinition = {
  name: "device_push",
  description:
    "把一个脚本文件**保存**到手机（不运行）。" +
    "手机上跑的是 AutoX.js 脚本时用这个把本地改好的代码同步过去；只想看效果就直接用 device_run。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "要推送的脚本文件路径（相对当前工作目录或绝对路径）" },
      device: {
        type: "string",
        description: "只推送到指定设备（设备名或连接 id）；不传表示所有已连接设备",
      },
    },
    required: ["path"],
  },
  requiresConfirmation: true,
  async execute(args, ctx): Promise<ToolResult> {
    if (!args.path) return { ok: false, content: "缺少必填参数：path" };
    const file = resolveInputPath(ctx, String(args.path).trim());
    const ops = buildOps(ctx);
    const result = await ops.push(file, args.device ? String(args.device) : undefined);
    return actionResult(result, ops, `已保存到 ${result.delivered ?? 0} 台设备`);
  },
};

const deviceRunTool: ToolDefinition = {
  name: "device_run",
  description:
    "把脚本文件推到手机上**并立即运行**，然后可以用 device_logs 查看手机上的输出。" +
    "这是「操作手机」的主通道（等价于 VSCode 插件的 F5）。\n" +
    "**写脚本前先 load_skill autojs6** —— 里面有 AutoJs6 的 API 速查与必须遵守的约定。\n" +
    "三条要点：① 脚本在**手机上**跑，返回值不会回来，因此每步都要 toastLog 回报，" +
    "再用 device_logs 读；② 本工具**发出即返回**，不等于脚本跑完 —— 先 sleep 1~3 秒再读日志；" +
    "③ 需要 UI 操作的脚本**必须**以 auto.waitFor(8000) 开头（auto() 在服务未真正运行时直接抛错）。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "要运行的脚本文件路径（相对当前工作目录或绝对路径）" },
      device: {
        type: "string",
        description: "只在指定设备上运行（设备名或连接 id）；不传表示所有已连接设备",
      },
    },
    required: ["path"],
  },
  requiresConfirmation: true,
  async execute(args, ctx): Promise<ToolResult> {
    if (!args.path) return { ok: false, content: "缺少必填参数：path" };
    const file = resolveInputPath(ctx, String(args.path).trim());
    const ops = buildOps(ctx);
    const result = await ops.run(file, args.device ? String(args.device) : undefined);
    return actionResult(
      result,
      ops,
      `已在 ${result.delivered ?? 0} 台设备上启动（用 device_logs 看输出）`,
    );
  },
};

const deviceStopTool: ToolDefinition = {
  name: "device_stop",
  description:
    "停止手机上正在运行的脚本。不传 path 表示停止全部（AutoX.js 的「停止所有脚本」）——" +
    "脚本是死循环时这是唯一的收尾手段。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "只停止这个脚本；不传表示停止全部脚本" },
      device: { type: "string", description: "只对指定设备生效（设备名或连接 id）" },
    },
  },
  requiresConfirmation: true,
  async execute(args, ctx): Promise<ToolResult> {
    const ops = buildOps(ctx);
    const file = args.path ? resolveInputPath(ctx, String(args.path).trim()) : undefined;
    const result = await ops.stop(file, args.device ? String(args.device) : undefined);
    return actionResult(result, ops, file ? "已请求停止该脚本" : "已请求停止全部脚本");
  },
};

const deviceLogsTool: ToolDefinition = {
  name: "device_logs",
  description:
    "读取手机上脚本最近打印的日志（AutoX.js 里 console.log / toast 之类的内容会回到这里）。" +
    "运行脚本后用它确认执行结果，比让用户肉眼盯手机靠谱。",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "最多返回多少行，默认 50" },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const raw = Number(args.limit ?? 50);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 500) : 50;
    const ops = buildOps(ctx);
    const logs = await ops.logs(limit);
    if (!logs) return notRunning(ops);
    if (logs.length === 0) {
      return {
        ok: true,
        content: `暂时没有设备日志（${ops.source}）。脚本可能还没输出，或没在运行。`,
        summary: "0 行日志",
      };
    }
    const body = logs.map((line) => `[${line.device}] ${line.text}`).join("\n");
    return {
      ok: true,
      content: `最近 ${logs.length} 行设备日志：\n${body}`,
      summary: `${logs.length} 行日志`,
    };
  },
};

/** 把桥的返回统一转成工具结果 */
function actionResult(
  result: DeviceActionResult,
  ops: DeviceOps,
  successSummary: string,
): ToolResult {
  if (!result.ok) {
    // 桥可达但操作失败（没设备、文件读不到……）—— 直接把原因抛给模型
    return { ok: false, content: result.message ?? "操作失败" };
  }
  const targets = (result.devices ?? []).join("、");
  return {
    ok: true,
    content:
      `${successSummary}${targets ? `：${targets}` : ""}\n` +
      `${result.path ? `脚本：${result.path}\n` : ""}来源：${ops.source}`,
    summary: successSummary,
  };
}

/**
 * 截取手机当前屏幕。
 *
 * ⚠ 关键限制：工具返回值是**纯文本**，模型**看不到图片内容**。因此这个工具的价值是
 * "给用户产出一个截图文件"，而不是"让模型看图"。想让模型自己判断界面上有什么，
 * 应该在脚本里用文本树（`text()` / `textMatches().find()`）把结果**打印成文字**，
 * 再用 `device_logs` 读回来 —— 那才是模型能"看见"的形式。
 */
const deviceScreenshotTool: ToolDefinition = {
  name: "device_screenshot",
  description:
    "截取**手机当前屏幕**并保存为 JPEG；**图片会直接附在结果之后**，你能看到画面内容。\n" +
    "用途：① 无障碍读不到的界面（微信、应用分身、游戏）—— 先 device_read_screen 判断，\n" +
    "控件数为 0 时改用它看图；② 把画面拿给用户确认。\n" +
    "看完之后要操作，就按坐标 click(x,y)（图里的像素坐标即屏幕坐标）。\n" +
    "首次/每次截图手机都会弹系统授权框，桥内置的脚本会自动点掉（无需人工）。",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "保存路径（相对当前工作目录或绝对路径）；不传则写到系统临时目录",
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const ops = buildOps(ctx);
    const result = await ops.screenshot();
    if (!result.ok) {
      return { ok: false, content: `${result.message}\n（来源：${ops.source}）` };
    }
    const target =
      typeof args.path === "string" && args.path.trim()
        ? resolveInputPath(ctx, args.path.trim())
        : path.join(os.tmpdir(), `xzh-device-shot-${Date.now()}.jpg`);
    try {
      fs.writeFileSync(target, result.data as unknown as Uint8Array);
    } catch (err) {
      return {
        ok: false,
        content: `截图已拿到但保存失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      ok: true,
      content:
        `已截取手机屏幕：${target}（${Math.round(result.data.length / 1024)} KB，JPEG）\n` +
        `图片**已附在本条结果之后** —— 直接看图判断界面内容、决定点哪里（按坐标 click(x,y)）。\n` +
        `若你无法看到图片，说明当前模型不支持视觉：此时请让用户看这张图，或改用 device_read_screen。\n` +
        `（来源：${ops.source}）`,
      // 让"截图"对模型真正有用：把图片一并交给 Agent（它会作为一条 user 消息追加）。
      images: [{ mimeType: "image/jpeg", data: result.data.toString("base64") }],
    };
  },
};

/**
 * 读取手机**当前界面内容**（以文字返回）。
 *
 * 这是模型"看"手机屏幕的**唯一正确方式**：把无障碍树读成文字，模型才能读到内容；
 * 截图（`device_screenshot`）的返回值只有文件路径，模型看不到图片。
 * 「看 → 判断 → 动（device_run）→ 再看验证」这个闭环里的两次"看"都用它。
 */
const deviceReadScreenTool: ToolDefinition = {
  name: "device_read_screen",
  description:
    "读取手机**当前界面**的内容并**以文字返回**：包名 / Activity、可见控件的文本与描述、" +
    "是否可点击、以及坐标 —— 这是你「看」手机屏幕的正确方式。\n" +
    "用于：判断当前停在哪个界面、找要点的控件、确认操作结果。\n" +
    "（device_screenshot 只产出你看不到的图片文件，给用户看用；要自己判断界面一律用本工具。）",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx): Promise<ToolResult> {
    const ops = buildOps(ctx);
    // 每次运行一个唯一标记：日志缓冲是跨调用共享的，只按「【界面】」过滤会把
    // **上一次运行的残留**也算进来，从而报出过期界面 —— 实测踩过，必须用标记划界。
    const runId = `r${Date.now()}`;
    const marker = `【开始】${runId}`;
    const file = path.join(os.tmpdir(), `xzh-ui-dump-${Date.now()}.js`);
    try {
      fs.writeFileSync(file, buildUiDumpScript(UI_DUMP_MAX_NODES, runId), "utf8");
      const started = await ops.run(file);
      if (!started.ok) {
        return { ok: false, content: `${started.message ?? "读取界面失败"}\n（来源：${ops.source}）` };
      }
    } finally {
      fs.rmSync(file, { force: true });
    }

    // 轮询到结束标记：无障碍路径通常 1~3 秒；但**降级到 OCR 时**要截图(含授权) +
    // 手机端 PaddleOCR 推理（实测单次 ~7 秒，且 AIDL 插件可能重试 3 次）→ 放宽到 45 秒。
    const deadline = Date.now() + 45_000;
    let collected: string[] = [];
    while (Date.now() < deadline) {
      const texts = ((await ops.logs(200)) ?? []).map((line) => line.text);
      const startIndex = texts.map((text) => text.includes(marker)).lastIndexOf(true);
      collected =
        startIndex < 0
          ? []
          : texts
              .slice(startIndex)
              // 取本次运行标记之后的**我们自己的诊断行**（都以 【 开头）：
              // 这样以后新增输出类型（【OCR】/【判断】…）不必再改这里。
              .filter((text) => text.includes("【"));
      const done = collected.some(
        (text) =>
          text.includes("【完成】") ||
          text.includes("读取失败") ||
          text.includes("无障碍未就绪"),
      );
      if (done) break;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }

    if (collected.length === 0) {
      return {
        ok: false,
        content:
          "没有从手机读回界面内容（脚本可能没跑起来，或卡在等待无障碍服务）。\n" +
          "可先跑 xzh device check 体检，或用 device_stop 收掉挂住的脚本。\n" +
          `（来源：${ops.source}）`,
      };
    }
    return {
      ok: true,
      content: `${collected.join("\n")}\n（来源：${ops.source}）`,
    };
  },
};

export const deviceTools: ToolDefinition[] = [
  deviceListTool,
  devicePushTool,
  deviceRunTool,
  deviceStopTool,
  deviceLogsTool,
  deviceReadScreenTool,
  deviceScreenshotTool,
];

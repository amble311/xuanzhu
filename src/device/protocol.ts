import { VERSION } from "../utils/version";

/**
 * AutoX.js / Auto.js **设备桥**的线协议。
 *
 * ⚠ 注意 `helloReply()` 里回报给手机的版本号**不是**玄猪自身的版本，
 * 原因见 `DEVICE_PLUGIN_PROTOCOL_VERSION`。
 *
 * 协议沿用 VSCode 插件 Auto.js-Autox.js-VSCodeExt（`out/autojs-debug.js`）的既有约定 ——
 * 手机端的 AutoX.js 就是按这套协议连过来的，**改协议等于改手机端**，因此这里逐字保持兼容：
 * 手机作为 WebSocket **客户端**连到 PC 的 `ws://<ip>:<port>/`，双方收发 JSON 文本帧。
 *
 * 本文件只放「线格式」，不含任何网络逻辑（网络在 `server.ts`）。
 */

/** 桥监听的默认端口（与插件一致，手机端默认也填这个） */
export const DEVICE_BRIDGE_PORT = 9317;

/**
 * 设备连上后必须在该时限内发来 `hello`，否则断开。
 *
 * 与插件一致：没有握手超时的话，任何误连到该端口的东西都会永久占着一个设备槽位。
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * 握手应答里回报给手机的「PC 端版本」。
 *
 * **不要回玄猪自身的版本号。** 手机端会拿这个字段判兼容性，它认识的是
 * 「Auto.js-Autox.js-VSCodeExt」那套版本序列（当前插件 `1.110.0`）——
 * 实测现象：回 `0.3.0` 时 AutoX.js（versionCode 722 / OPPO PHQ110）在收到应答后
 * 立刻断开，手机端提示**握手失败**；而它与 VSCode 插件（回 `1.110.0`）能正常连接。
 * 两者的应答**只有这个字段不同**，因此这里表达的是**所实现的插件协议版本**。
 *
 * 可用环境变量 `XZH_DEVICE_PLUGIN_VERSION` 覆盖，以便手机端将来提高要求时不必改代码。
 */
export const DEVICE_PLUGIN_PROTOCOL_VERSION =
  process.env.XZH_DEVICE_PLUGIN_VERSION?.trim() || "1.110.0";

/**
 * 玄猪自身版本，仅用于日志与界面展示。
 *
 * 保留导出是为了让调用方一眼看出「回给手机的不是它」这个刻意的区分。
 */
export const BRIDGE_IMPLEMENTATION_VERSION = VERSION;

/** 设备发来的 `hello` 数据 */
export interface DeviceHelloData {
  /** 设备名（一般为手机型号，界面用它区分设备） */
  device_name?: string;
  /** AutoX.js 的 app versionCode；>= 629 才认新式握手应答 */
  app_version_code?: number;
}

/** PC → 设备的指令名（单文件场景） */
export type DeviceCommand =
  /** 保存并立即运行 */
  | "run"
  /** 只保存到设备，不运行 */
  | "save"
  /** 先 stopAll 再 run */
  | "rerun"
  /** 停止指定脚本 */
  | "stop"
  /** 停止全部脚本 */
  | "stopAll";

/** 消息 id：插件用 `${Date.now()}_${Math.random()}`，这里保持同样形态 */
export function nextMessageId(): string {
  return `${Date.now()}_${Math.random()}`;
}

/**
 * 握手应答。
 *
 * `app_version_code < 629` 的老版本只认 `data` 字段，多塞字段会被它当成错误，
 * 因此这里按版本号分两种形态（与插件一致）。
 */
export function helloReply(appVersionCode: number): string {
  const messageId = nextMessageId();
  if (appVersionCode >= 629) {
    return JSON.stringify({
      message_id: messageId,
      data: "ok",
      version: DEVICE_PLUGIN_PROTOCOL_VERSION,
      debug: false,
      type: "hello",
    });
  }
  return JSON.stringify({
    message_id: messageId,
    data: "连接成功",
    debug: false,
    type: "hello",
  });
}

/** ping 应答：原样回带 data */
export function pongReply(data: unknown): string {
  return JSON.stringify({ type: "pong", data });
}

/**
 * 单文件指令。
 *
 * 关键点：**脚本全文以字符串形式塞在 `script` 字段里**（插件的 `runOrRerun()` / `saveTo()`
 * 就是这么发的），因此「把一个脚本推到手机」**不需要任何文件传输或压缩** ——
 * 这是本实现只做单文件就能覆盖日常调试的原因。
 */
export function scriptCommand(
  command: DeviceCommand,
  filePath: string,
  script: string,
): string {
  return JSON.stringify({
    type: "command",
    message_id: nextMessageId(),
    data: { command, id: filePath, name: filePath, script },
  });
}

/** 不带脚本正文的指令（stop / stopAll） */
export function plainCommand(
  command: DeviceCommand,
  data: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "command",
    message_id: nextMessageId(),
    data: { command, ...data },
  });
}

/**
 * 解析设备发来的帧。
 *
 * 非 JSON、非对象、缺 `type` 一律返回 `null`（由调用方忽略）——
 * 手机上跑着用户自己的脚本，发什么过来都不该让桥崩掉。
 */
export function parseDeviceMessage(
  raw: string,
): { type: string; data: unknown } | null {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; data?: unknown };
    if (!parsed || typeof parsed !== "object") return null;
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (!type) return null;
    return { type, data: parsed.data };
  } catch {
    return null;
  }
}

/** 从 hello 数据里安全取出设备名与 versionCode（手机端字段可能缺失或类型不对） */
export function readHelloData(data: unknown): {
  name: string;
  appVersionCode: number;
} {
  const raw = (data ?? {}) as DeviceHelloData;
  const name =
    typeof raw.device_name === "string" && raw.device_name.trim()
      ? raw.device_name.trim()
      : "";
  const code =
    typeof raw.app_version_code === "number" && Number.isFinite(raw.app_version_code)
      ? raw.app_version_code
      : 0;
  return { name, appVersionCode: code };
}

/** 从日志消息里取出文本（设备可能发 `{log: "..."}` 或直接发字符串） */
export function readLogData(data: unknown): string {
  if (typeof data === "string") return data;
  const raw = (data ?? {}) as { log?: unknown };
  if (typeof raw.log === "string") return raw.log;
  return "";
}

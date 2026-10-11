/**
 * AutoJs6「连接电脑」的线协议。
 *
 * ⚠ 这是**另一套协议**，与 AutoX.js 的 WebSocket 协议（`../protocol.ts`）毫无关系：
 * 它是**裸 TCP + 自定义二进制分帧 + JSON 载荷**。实现依据是 AutoJs6 的源码
 * （`app/src/main/java/org/autojs/autojs/pluginclient/JsonSocket.java`、
 * `JsonSocketClient.kt`、`JsonSocketServer.kt`、`DevPluginResponseHandler.java`），
 * 逐字对齐 —— 改协议等于改手机端。
 *
 * ## 帧格式
 *
 * 每条消息 = 8 字节头 + 载荷：
 *
 * ```
 * [ int32 BE 载荷长度 ][ int32 BE 类型 ][ 载荷 … ]
 * ```
 *
 * 类型：`1` = JSON（UTF-8 文本）、`2` = BYTES（二进制，例如项目 zip）。
 * 头是**大端**（AutoJs6 注释里明确写了 "use Buffer#readInt32BE for a socket server
 * in Node.js"）。TCP 是字节流，**必须自己处理粘包/半包**，见 `AutoJs6FrameDecoder`。
 *
 * ## 握手（两个方向不对称，这是最容易踩空的地方）
 *
 * - **客户端模式**（手机主动连电脑，默认端口 `6347`）：手机连上后**先发** `hello`
 *   （`device_name` / `app_version` / `app_version_code` / `device_id`），
 *   电脑必须回一条 `hello`，且 `data.extensionVersion` **必须 ≥ 1.0.13**
 *   （AutoJs6 的 `VSCODE_EXT_REQUIRED_VERSION`）—— 否则手机上会弹「连接无法建立」并断开。
 *   这条门槛与 AutoX.js 的 `version` 字段是同一类坑，务必别回自己的版本号。
 * - **服务器模式**（手机监听 `7347`）：**由连过来的一方（xzh）先发 hello**，
 *   手机收到 `hello` 即视为已连接，**不校验版本**。
 *
 * ## 命令
 *
 * | 方向 | 消息 |
 * | --- | --- |
 * | PC→手机 | `{"type":"command","data":{"command":"run","id","name","script"}}` |
 * | PC→手机 | `{"type":"command","data":{"command":"save","name","script"}}` |
 * | PC→手机 | `{"type":"command","data":{"command":"stop","id"}}` / `{"command":"stopAll"}` |
 * | PC→手机 | `{"type":"bytes_command","md5":"<zip的md5>","data":{"command":"run_project"｜"save_project","dir","name"}}`（先发 `type=2` 的二进制帧） |
 * | 手机→PC | `{"type":"log","data":{"log":"…"}}` |
 * | 手机→PC | `{"type":"command","data":{"\u00a0cmd\u00a0":"…"}}`（手机侧脚本/插件上报，`cmd` 前后是**不间断空格**） |
 */

// ── 字节工具 ────────────────────────────────────────────────
//
// 本项目的 TS 自带 `Uint8Array<TArrayBuffer>` 泛型，而 `@types/node@20.2.5` 的
// `Buffer` 声明没有跟上，于是 `Buffer.from(Buffer)` / `Buffer.concat([Buffer])`
// 这类调用**类型上**不兼容（运行时完全正常）。项目里既有多处
// `as unknown as Uint8Array[]`（见 `utils/clipboard.ts`、`device/client.ts`），
// 这里把转换收口成两个函数，免得断言撒得到处都是。

/** Buffer → Uint8Array（仅用于满足类型检查） */
const asBytes = (value: Buffer): Uint8Array => value as unknown as Uint8Array;

/**
 * 交给 `net.Socket#write` 的转换。
 *
 * 同样只是类型摩擦：`write()` 的形参是 `Uint8Array`，而这里的 `Buffer` 声明
 * 在泛型上对不上（运行时完全正常）。统一从这里过一道，调用处就不必写断言。
 */
export const toWritable = (buffer: Buffer): Uint8Array => asBytes(buffer);

/** 复制一段 Buffer（类型上需要绕过 Buffer/Uint8Array 的泛型摩擦） */
function copyBuffer(value: Buffer): Buffer {
  return Buffer.from(asBytes(value)) as Buffer;
}

/** 拼接多个 Buffer */
function concatBuffers(parts: Buffer[]): Buffer {
  return Buffer.concat(parts.map(asBytes) as unknown as Uint8Array[]) as Buffer;
}

/** 帧头长度：两个 int32 */
export const AUTOJS6_HEADER_SIZE = 8;

/** 帧类型：JSON 文本 */
export const AUTOJS6_TYPE_JSON = 1;
/** 帧类型：二进制（项目 zip 等） */
export const AUTOJS6_TYPE_BYTES = 2;

/** 载荷长度上限（防止对端给出一个荒谬的长度把我们拖死） */
export const AUTOJS6_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

/**
 * 握手超时。与 AutoJs6 的 `JsonSocket.HANDSHAKE_TIMEOUT = 6400` 一致：
 * 手机端握手超时会主动断开并提示"握手超时"，我们这边只是用它来清理死连接。
 */
export const AUTOJS6_HANDSHAKE_TIMEOUT_MS = 6_400;

/** 客户端模式下 **PC 端该监听的端口**（AutoJs6 的 `DevPluginService.PC_SERVER`） */
export const AUTOJS6_PC_SERVER_PORT = 6347;

/** 服务器模式下**手机监听的端口**（AutoJs6 的 `DevPluginService.AJ_SERVER`） */
export const AUTOJS6_APP_SERVER_PORT = 7347;

/**
 * 回给手机的「VSCode 扩展版本」。
 *
 * AutoJs6 客户端模式会拿它和 `VSCODE_EXT_REQUIRED_VERSION` 比较
 * （当前 AutoJs6 6.7.0 的要求是 `1.0.13`），低于要求就拒绝连接。
 * 因此这里表达的是**所实现的插件协议版本**，不是玄猪自身版本；
 * 环境变量 `XZH_AUTOJS6_EXT_VERSION` 可覆盖（手机端将来提高要求时免改代码）。
 */
export const AUTOJS6_EXTENSION_VERSION =
  process.env.XZH_AUTOJS6_EXT_VERSION?.trim() || "1.0.13";

/** 一条解析出来的帧 */
export interface AutoJs6Frame {
  kind: "json" | "bytes";
  /** JSON 帧为 UTF-8 文本；BYTES 帧为原始字节 */
  payload: string | Buffer;
}

/** 把长度/类型编码成 8 字节大端头 */
function headerBytes(length: number, type: number): Buffer {
  const header = Buffer.alloc(AUTOJS6_HEADER_SIZE);
  header.writeInt32BE(length, 0);
  header.writeInt32BE(type, 4);
  return header;
}

/** 编码一条 JSON 帧（文本已序列化完成时用这个，避免二次序列化） */
export function encodeJsonText(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  return concatBuffers([headerBytes(payload.length, AUTOJS6_TYPE_JSON), payload]);
}

/** 编码一条 JSON 帧 */
export function encodeJsonFrame(value: unknown): Buffer {
  return encodeJsonText(JSON.stringify(value));
}

/** 编码一条二进制帧 */
export function encodeBytesFrame(data: Buffer): Buffer {
  return concatBuffers([headerBytes(data.length, AUTOJS6_TYPE_BYTES), data]);
}

/**
 * 增量帧解码器。
 *
 * TCP 不保证一次 `data` 事件对应一条完整消息 —— 一条消息可能被拆成多次到达
 * （半包），多条消息也可能挤在一次里（粘包）。因此必须缓冲后按头里的长度切分。
 *
 * 用法：`const frames = decoder.push(chunk)`，返回本次能完整解析出的所有帧。
 */
export class AutoJs6FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /** 喂入一段字节，返回其中解析完成的帧 */
  push(chunk: Buffer): AutoJs6Frame[] {
    // 统一经 Buffer.from 归一化：新版 @types/node 里 Buffer 带 ArrayBufferLike 泛型参数，
    // 而 subarray() 的返回类型不再能直接赋回 Buffer 字段（运行时完全正常，纯类型问题）。
    const incoming = copyBuffer(chunk);
    this.buffer =
      this.buffer.length === 0 ? incoming : concatBuffers([this.buffer, incoming]);
    const frames: AutoJs6Frame[] = [];

    while (this.buffer.length >= AUTOJS6_HEADER_SIZE) {
      const length = this.buffer.readInt32BE(0);
      const type = this.buffer.readInt32BE(4);
      if (length < 0 || length > AUTOJS6_MAX_PAYLOAD_BYTES) {
        // 长度离谱 = 流已经错位（或对端不是这个协议），继续解析只会越读越乱
        throw new Error(
          `AutoJs6 帧长度非法：${length}（上限 ${AUTOJS6_MAX_PAYLOAD_BYTES}），连接可能不是 AutoJs6 协议`,
        );
      }
      if (this.buffer.length < AUTOJS6_HEADER_SIZE + length) break; // 半包，等后续字节

      // 复制出来而不是 slice：载荷要交给调用方长期持有，不能与复用的累积缓冲共享内存
      const payload = copyBuffer(
        this.buffer.subarray(AUTOJS6_HEADER_SIZE, AUTOJS6_HEADER_SIZE + length),
      );
      this.buffer = copyBuffer(this.buffer.subarray(AUTOJS6_HEADER_SIZE + length));

      if (type === AUTOJS6_TYPE_JSON) {
        frames.push({ kind: "json", payload: payload.toString("utf8") });
      } else if (type === AUTOJS6_TYPE_BYTES) {
        frames.push({ kind: "bytes", payload });
      }
      // 其它类型由 AutoJs6 自己定义为非法（"Unknown data type"），这里直接跳过
    }
    return frames;
  }

  /** 缓冲区里是否有残留（用于诊断「对端发了半条就不发了」） */
  get pendingBytes(): number {
    return this.buffer.length;
  }
}

// ------------------------------------------------------------------ 消息

export interface AutoJs6Message {
  type: string;
  data: Record<string, unknown>;
}

/** 解析 JSON 帧；非对象或缺 `type` 时返回 null */
export function parseAutoJs6Message(text: string): AutoJs6Message | null {
  try {
    const parsed = JSON.parse(text) as { type?: unknown; data?: unknown };
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.type !== "string" || !parsed.type) return null;
    const data =
      parsed.data && typeof parsed.data === "object"
        ? (parsed.data as Record<string, unknown>)
        : {};
    return { type: parsed.type, data };
  } catch {
    return null;
  }
}

/**
 * 握手应答（客户端模式：手机连我们时回这条）。
 *
 * 必须放在 `data.extensionVersion`，且不低 `1.0.13` —— 手机拿它做
 * `Version(currentVersion).isAtLeast(requiredVersion)` 判定。
 */
export function helloReply(extensionVersion = AUTOJS6_EXTENSION_VERSION): string {
  return JSON.stringify({ type: "hello", data: { extensionVersion } });
}

/**
 * 握手拒绝（客户端模式）。手机收到 `data.errorMessage` 会直接弹框并断开。
 * 只在真的无法服务时用；正常一律用 `helloReply()`。
 */
export function helloRejection(errorMessage: string): string {
  return JSON.stringify({ type: "hello", data: { errorMessage } });
}

/** 手机侧 hello 里的信息 */
export interface AutoJs6HelloData {
  deviceName: string;
  appVersion: string;
  appVersionCode: number;
  deviceId: string;
}

/** 从 hello 的 data 里安全取值（字段缺失或类型不对都不该让桥崩掉） */
export function readHelloData(data: Record<string, unknown>): AutoJs6HelloData {
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    deviceName: str(data.device_name).trim(),
    appVersion: str(data.app_version).trim(),
    appVersionCode: num(data.app_version_code),
    deviceId: str(data.device_id).trim(),
  };
}

/** 单文件指令（run / save / stop / stopAll） */
export function commandMessage(
  command: string,
  data: Record<string, unknown> = {},
): string {
  return JSON.stringify({ type: "command", data: { command, ...data } });
}

/**
 * 二进制指令（项目级 zip）。
 *
 * 与 AutoJs6 的实现一致：**先发二进制帧，再发这条带 md5 的 `bytes_command`**，
 * 手机按 md5 把两者配对（哪个先到都行，两边各有一个等待表）。
 */
export function bytesCommandMessage(
  command: string,
  md5: string,
  data: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "bytes_command",
    md5,
    data: { command, ...data },
  });
}

/** 从 log 消息里取文本；不是 log 或没有内容时返回 null */
export function readLogText(message: AutoJs6Message): string | null {
  if (message.type !== "log") return null;
  const raw = message.data.log;
  return typeof raw === "string" ? raw : null;
}

/**
 * 手机上报的脚本/插件指令。
 *
 * 注意键名是 `"\u00a0cmd\u00a0"`（**不间断空格**包着 cmd，AutoJs6 的
 * `JsonSocket.sendCommand` 就是这么写的），不是 `command` —— 按普通键名取会永远取不到。
 */
export function readReportedCommand(message: AutoJs6Message): string | null {
  const raw = message.data["\u00a0cmd\u00a0"];
  return typeof raw === "string" ? raw : null;
}

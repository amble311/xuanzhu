import * as net from "net";
import {
  AUTOJS6_APP_SERVER_PORT,
  AUTOJS6_EXTENSION_VERSION,
  AutoJs6FrameDecoder,
  commandMessage,
  encodeJsonText,
  parseAutoJs6Message,
  readLogText,
  readReportedCommand,
  toWritable,
} from "./protocol";
import { VERSION } from "../../utils/version";

/**
 * AutoJs6 **服务器模式**下的客户端：xzh 主动连到手机，之后所有指令都走这条连接。
 *
 * 为什么统一选这个方向（而不是 AutoJs6 的"客户端模式"让手机连电脑）：
 *   - 手机连电脑要求用户先在手机上**正确填好电脑的 IP**，且电脑必须监听一个端口，
 *     两边网络稍有出入（多网卡、防火墙）就卡住；
 *   - xzh 主动连手机只需要一个地址（手机 IP），在电脑和在手机本地（`127.0.0.1`）
 *     是**同一套代码**，本地模式还能完全不联网。
 *
 * 握手：**由我们先发 hello**（服务器模式下 AutoJs6 收到 hello 即视为已连接，
 * 不回包、也不校验版本）。因此"连接成功"的判据是 TCP 连上 + hello 已写出；
 * 真正的失败会以 socket 错误 / 立刻断开的形式暴露出来（见 `quickFailures`）。
 *
 * 断线自动重连（带退避）：手机端切后台、切走服务器模式、网络抖动都很常见，
 * 手动重连的体验太差。但**连续多次"刚连上就断"要停下并给出可操作的提示** ——
 * 否则多半是端口填错/对端根本不是 AutoJs6，无限重试只会刷屏。
 */

export interface AutoJs6ClientOptions {
  host: string;
  /** 默认 7347（AutoJs6 服务器模式端口） */
  port?: number;
  /** 断线重连的基础间隔（毫秒），默认 1500；设为 0 表示不自动重连 */
  reconnectDelayMs?: number;
  onStatus?: (message: string) => void;
  onLog?: (text: string) => void;
  /** 手机端上报的指令（`\u00a0cmd\u00a0` 键，例如 rerun） */
  onPhoneCommand?: (command: string, data: Record<string, unknown>) => void;
  /** 连接建立（可用于登记设备）；重连成功后会再次触发 */
  onConnect?: () => void;
  /** 连接断开（含主动 close 与网络异常） */
  onDisconnect?: () => void;
}

/** 连接建立后多久之内断开算"快速失败"（多半是对端不对） */
const QUICK_FAILURE_MS = 2_000;

/** 连续快速失败多少次后放弃重连 */
const MAX_QUICK_FAILURES = 3;

/** 重连退避的上限 */
const MAX_RECONNECT_DELAY_MS = 15_000;

/** TCP 连接超时：IP 被黑洞（同网段但设备不在）时会一直挂着，必须自己兜住 */
const CONNECT_TIMEOUT_MS = 5_000;

export class AutoJs6Client {
  private readonly host: string;
  private readonly port: number;
  private readonly options: AutoJs6ClientOptions;

  private socket: net.Socket | null = null;
  private decoder = new AutoJs6FrameDecoder();
  /** 是否处于"应该在连接"的状态（`close()` 之后为 false） */
  private active = false;
  private connected = false;
  private connecting = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private quickFailures = 0;
  private connectedAt = 0;

  constructor(options: AutoJs6ClientOptions) {
    this.options = options;
    this.host = options.host.trim();
    this.port = options.port ?? AUTOJS6_APP_SERVER_PORT;
  }

  getAddress(): string {
    return `${this.host}:${this.port}`;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * 是否仍在尝试连接（含等待重连）。
   *
   * 与 `isConnected()` 分开是必要的：连不上时"还会不会自己接上"直接决定要不要
   * 引导用户去装/配置 —— 已经放弃重连却提示"仍在后台重试"就是撒谎。
   */
  isRetrying(): boolean {
    return this.active;
  }

  /** 开始连接（失败会按退避自动重试，直到 `close()`） */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.attempt = 0;
    this.quickFailures = 0;
    this.connectOnce();
  }

  /** 停止并断开（会取消待执行的重连） */
  close(): void {
    this.active = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const socket = this.socket;
    const wasConnected = this.connected;
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    if (socket) {
      // 先摘掉监听：否则 destroy() 触发的 'close' 会再走一遍 handleDisconnect 与重连
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        // 忽略
      }
    }
    if (wasConnected) this.options.onDisconnect?.();
  }

  // ---------------------------------------------------------------- 指令

  /** 让手机保存并立即运行一段脚本 */
  runScript(script: string, id: string, name: string): boolean {
    return this.sendJson(commandMessage("run", { id, name, script }));
  }

  /** 让手机保存一段脚本（不运行） */
  saveScript(script: string, name: string): boolean {
    return this.sendJson(commandMessage("save", { name, script }));
  }

  /** 停止手机上指定 id 的脚本 */
  stopScript(id: string): boolean {
    return this.sendJson(commandMessage("stop", { id }));
  }

  /** 停止手机上全部脚本 */
  stopAllScripts(): boolean {
    return this.sendJson(commandMessage("stopAll"));
  }

  /** 发送一条已序列化的 JSON 消息（消息文本由 protocol 的构造函数生成） */
  sendJson(payload: string): boolean {
    const socket = this.socket;
    if (!this.connected || !socket) return false;
    try {
      socket.write(toWritable(encodeJsonText(payload)));
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- 连接

  private connectOnce(): void {
    if (!this.active || this.socket || this.connecting) return;
    this.connecting = true;
    this.decoder = new AutoJs6FrameDecoder();

    const socket = new net.Socket();
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);

    // 连接超时：目标 IP 被黑洞（同网段但没有这个设备）时 connect 会一直挂着
    const connectTimer = setTimeout(() => {
      if (!this.connected) {
        this.options.onStatus?.(`连接 ${this.getAddress()} 超时（${CONNECT_TIMEOUT_MS} ms）`);
        socket.destroy();
      }
    }, CONNECT_TIMEOUT_MS);
    const clearConnectTimer = () => clearTimeout(connectTimer);
    socket.once("close", clearConnectTimer);

    socket.connect(this.port, this.host);

    socket.on("connect", () => {
      clearConnectTimer();
      this.connecting = false;
      this.connected = true;
      this.connectedAt = Date.now();
      this.attempt = 0;
      // 服务器模式下由我们先发 hello（AutoJs6 收到即置为已连接，不回包）
      this.sendHello();
      this.options.onStatus?.(`已连接手机 ${this.getAddress()}（AutoJs6 服务器模式）`);
      this.options.onConnect?.();
    });

    socket.on("data", (chunk: Buffer) => this.handleData(chunk));

    socket.on("error", (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED 是最常见的：手机没开服务器模式 / IP 不对 / 不在同一网络
      this.options.onStatus?.(
        err.code === "ECONNREFUSED"
          ? `连接被拒绝（${this.getAddress()}）：手机上 AutoJs6 的「服务器模式」没开，或地址不对`
          : `连接出错：${err.message}`,
      );
    });

    socket.on("close", () => this.handleDisconnect());
  }

  /** 发一条 hello；服务器模式下手机只认"收到 hello"这个事实，不校验内容 */
  private sendHello(): void {
    this.sendJson(
      JSON.stringify({
        type: "hello",
        data: {
          device_name: `xzh ${VERSION}`,
          app_version: VERSION,
          app_version_code: 0,
          device_id: "",
          extensionVersion: AUTOJS6_EXTENSION_VERSION,
        },
      }),
    );
  }

  private handleData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      // 长度字段离谱 = 对端不是这个协议（例如连到了别的服务），直接断开并停止重试
      this.options.onStatus?.(
        `${this.getAddress()} 返回的数据不是 AutoJs6 协议：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.active = false;
      this.close();
      return;
    }

    for (const frame of frames) {
      if (frame.kind !== "json") continue; // 二进制帧（项目 zip 回传）暂不处理
      const message = parseAutoJs6Message(String(frame.payload));
      if (!message) continue;

      const log = readLogText(message);
      if (log !== null) {
        this.options.onLog?.(log);
        continue;
      }
      const reported = readReportedCommand(message);
      if (reported !== null) {
        this.options.onPhoneCommand?.(reported, message.data);
      }
    }
  }

  private handleDisconnect(): void {
    const wasConnected = this.connected;
    const livedMs = this.connectedAt > 0 ? Date.now() - this.connectedAt : Number.MAX_SAFE_INTEGER;
    this.socket = null;
    this.connected = false;
    this.connecting = false;

    if (wasConnected) this.options.onDisconnect?.();

    if (!this.active) return;

    // 刚连上就断：多半是端口/模式填错，累计几次后停下并给指引，而不是无限刷屏
    if (wasConnected && livedMs < QUICK_FAILURE_MS) {
      this.quickFailures++;
      if (this.quickFailures >= MAX_QUICK_FAILURES) {
        this.active = false;
        this.options.onStatus?.(
          `与 ${this.getAddress()} 连续 ${this.quickFailures} 次刚连上就断开，已停止重连。` +
            `请确认：① 手机上 AutoJs6 打开「连接电脑 → 服务器模式」；② 地址与端口（默认 7347）正确；` +
            `③ xzh 与手机在同一网络（手机本机运行时用 127.0.0.1）。`,
        );
        return;
      }
    } else if (wasConnected) {
      this.quickFailures = 0;
    }

    if (!wasConnected && this.quickFailures < MAX_QUICK_FAILURES) {
      // 连都没连上（如 ECONNREFUSED）：同样累计，避免对着一个没开服务的端口无限重试
      this.quickFailures++;
      if (this.quickFailures >= MAX_QUICK_FAILURES) {
        this.active = false;
        this.options.onStatus?.(
          `连接 ${this.getAddress()} 失败 ${this.quickFailures} 次，已停止重连。` +
            `请确认手机上 AutoJs6 已打开「连接电脑 → 服务器模式」（默认端口 ${AUTOJS6_APP_SERVER_PORT}）。`,
        );
        return;
      }
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const base = this.options.reconnectDelayMs ?? 1_500;
    if (base <= 0) return;
    if (this.retryTimer) return;

    const delay = Math.min(base * 2 ** this.attempt, MAX_RECONNECT_DELAY_MS);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.options.onStatus?.(`正在重连 ${this.getAddress()}…（第 ${this.attempt} 次）`);
      this.connectOnce();
    }, delay);
  }
}



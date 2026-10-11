import * as net from "net";
import {
  AUTOJS6_EXTENSION_VERSION,
  AUTOJS6_PC_SERVER_PORT,
  AutoJs6FrameDecoder,
  helloReply,
  parseAutoJs6Message,
  readHelloData,
  readLogText,
  readReportedCommand,
  toWritable,
  encodeJsonText,
} from "./protocol";

/**
 * AutoJs6 **客户端模式**下的服务端：手机主动连我们（默认 `6347`）。
 *
 * 这是 AutoJs6 官方 VSCode 扩展走的那条路 —— 也是**手机端 UI 支持最好的方向**：
 * 用户在手机上点「连接电脑 → 客户端模式」、填电脑 IP 即可，不用碰手机上的服务端开关。
 * xzh 监听 `6347` 并回应握手，即成为该官方扩展的**替代品**。
 *
 * 与 `client.ts`（xzh 主动连手机的「服务器模式 / 7347」）互补，两者协议完全相同，
 * 只是 socket 的来源相反：
 *
 *   | 方向 | 谁监听 | 谁先发 hello | 版本校验 |
 *   | --- | --- | --- | --- |
 *   | 客户端模式（本文件） | **我们** `6347` | 手机 | **有**：应答里 `extensionVersion` 必须 ≥ 1.0.13 |
 *   | 服务器模式（client.ts） | 手机 `7347` | 我们 | 无 |
 *
 * 握手时序要点：手机连上后立刻发 `hello`，然后**只等 6400ms** 我们的应答，
 * 超时就断开并在手机上弹「连接无法建立」。因此必须**收到 hello 立即回**，
 * 且回的是**插件协议版本**（见 `AUTOJS6_EXTENSION_VERSION`），不是玄猪自己的版本号。
 */

/** 一条已连接的设备（握手完成后才有 name / 版本） */
export interface AutoJs6Peer {
  /** 连接标识：`remoteAddress:remotePort` */
  id: string;
  /** 手机型号（来自 hello 的 device_name） */
  name: string;
  appVersion: string;
  appVersionCode: number;
}

export interface AutoJs6ServerOptions {
  /** 监听端口；默认 6347（AutoJs6 的 PC_SERVER） */
  port?: number;
  onStatus?: (message: string) => void;
  /** 握手成功（设备可用） */
  onAttach?: (peer: AutoJs6Peer) => void;
  /** 连接断开 */
  onDetach?: (peer: AutoJs6Peer) => void;
  /** 手机回传的脚本日志 */
  onLog?: (peer: AutoJs6Peer, text: string) => void;
  /** 手机上报的指令（`\u00a0cmd\u00a0` 键，例如 rerun） */
  onPhoneCommand?: (peer: AutoJs6Peer, command: string, data: Record<string, unknown>) => void;
}

/** 单条连接的内部状态 */
interface Connection {
  socket: net.Socket;
  id: string;
  decoder: AutoJs6FrameDecoder;
  peer: AutoJs6Peer | null;
  handshakeTimer: NodeJS.Timeout;
}

/** 未握手连接的清理时限（手机侧是 6400ms，我们这边放宽一点只用于防泄漏） */
const HANDSHAKE_TIMEOUT_MS = 10_000;

export class AutoJs6Server {
  private readonly options: AutoJs6ServerOptions;
  private readonly port: number;
  private server: net.Server | null = null;
  private readonly connections = new Map<string, Connection>();

  constructor(options: AutoJs6ServerOptions = {}) {
    this.options = options;
    this.port = options.port ?? AUTOJS6_PC_SERVER_PORT;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  getPort(): number {
    return this.port;
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = net.createServer((socket) => this.handleConnection(socket));

    return new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `端口 ${this.port} 已被占用 —— 这是 AutoJs6「客户端模式」的端口。` +
                `两种可能：① VSCode 里的 AutoJs6 扩展（003.autojs6-vscode-ext）正在运行，` +
                `请在 VSCode 里禁用它；② 已经有另一个 xzh 设备桥在跑。` +
                `同一个端口上的两个服务会互相抢手机连接。`,
            ),
          );
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        server.on("error", (err) => this.options.onStatus?.(`AutoJs6 监听出错：${err.message}`));
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, "0.0.0.0");
    }).then(() => {
      this.server = server;
      this.options.onStatus?.(
        `AutoJs6 监听已就绪（端口 ${this.port}）：手机上「连接电脑 → 客户端模式」填本机 IP 即可`,
      );
    });
  }

  async stop(): Promise<void> {
    for (const connection of [...this.connections.values()]) {
      this.dispose(connection);
    }
    this.connections.clear();

    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** 已握手完成的设备 */
  listDevices(): AutoJs6Peer[] {
    return [...this.connections.values()]
      .map((connection) => connection.peer)
      .filter((peer): peer is AutoJs6Peer => peer !== null);
  }

  /** 给某台设备发一条已序列化的 JSON 消息 */
  sendTo(id: string, payload: string): boolean {
    const connection = this.connections.get(id);
    if (!connection || !connection.peer) return false;
    return this.write(connection, payload);
  }

  /** 广播给全部已握手设备，返回送达数 */
  broadcast(payload: string): number {
    let delivered = 0;
    for (const connection of this.connections.values()) {
      if (!connection.peer) continue;
      if (this.write(connection, payload)) delivered++;
    }
    return delivered;
  }

  /** 断开某台设备（未连接时什么都不做） */
  closeDevice(id: string): void {
    const connection = this.connections.get(id);
    if (connection) this.dispose(connection);
  }

  // ---------------------------------------------------------------- 内部

  private handleConnection(socket: net.Socket): void {
    const remote = socket.remoteAddress ?? "unknown";
    // 去掉 IPv6 映射前缀，否则界面上会显示 ::ffff:192.168.1.2
    const host = remote.startsWith("::ffff:") ? remote.slice("::ffff:".length) : remote;
    const id = `${host}:${socket.remotePort ?? 0}`;

    const connection: Connection = {
      socket,
      id,
      decoder: new AutoJs6FrameDecoder(),
      peer: null,
      handshakeTimer: setTimeout(() => {
        if (!connection.peer) {
          this.options.onStatus?.(`连接 ${id} 未在 ${HANDSHAKE_TIMEOUT_MS / 1000} 秒内握手，已断开。`);
          this.dispose(connection);
        }
      }, HANDSHAKE_TIMEOUT_MS),
    };
    this.connections.set(id, connection);

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);
    socket.on("data", (chunk: Buffer) => this.handleData(connection, chunk));
    socket.on("error", (err) => {
      this.options.onStatus?.(`与 ${id} 的连接出错：${err.message}`);
      this.dispose(connection);
    });
    socket.on("close", () => this.dispose(connection));
  }

  private handleData(connection: Connection, chunk: Buffer): void {
    let frames;
    try {
      frames = connection.decoder.push(chunk);
    } catch (err) {
      // 长度字段离谱 = 对端不是 AutoJs6（例如误连到了别的服务）
      this.options.onStatus?.(
        `${connection.id} 发来的数据不是 AutoJs6 协议：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.dispose(connection);
      return;
    }

    for (const frame of frames) {
      if (frame.kind !== "json") continue; // 二进制帧（项目 zip）暂不处理
      const message = parseAutoJs6Message(String(frame.payload));
      if (!message) continue;

      if (message.type === "hello") {
        this.handleHello(connection, message.data, String(frame.payload));
        continue;
      }

      const log = readLogText(message);
      if (log !== null && connection.peer) {
        this.options.onLog?.(connection.peer, log);
        continue;
      }

      const reported = readReportedCommand(message);
      if (reported !== null && connection.peer) {
        this.options.onPhoneCommand?.(connection.peer, reported, message.data);
      }
    }
  }

  private handleHello(
    connection: Connection,
    data: Record<string, unknown>,
    raw: string,
  ): void {
    const hello = readHelloData(data);
    connection.peer = {
      id: connection.id,
      name: hello.deviceName || connection.id,
      appVersion: hello.appVersion,
      appVersionCode: hello.appVersionCode,
    };
    clearTimeout(connection.handshakeTimer);

    // 必须**立即**回，且回的是插件协议版本 —— 手机只等 6400ms，
    // 并会拿 `data.extensionVersion` 和它的 VSCODE_EXT_REQUIRED_VERSION 比较。
    const reply = helloReply();
    const sent = this.write(connection, reply);
    this.options.onStatus?.(
      `握手：${connection.peer.name}（AutoJs6 ${hello.appVersion || "?"} / versionCode ${
        hello.appVersionCode
      }）${sent ? "" : "——⚠ 应答发送失败"}｜回报协议版本 ${AUTOJS6_EXTENSION_VERSION}`,
    );
    this.options.onStatus?.(`  手机原始 hello：${truncateText(raw, 240)}`);
    this.options.onAttach?.(connection.peer);
  }

  private write(connection: Connection, payload: string): boolean {
    if (connection.socket.destroyed) return false;
    try {
      connection.socket.write(toWritable(encodeJsonText(payload)));
      return true;
    } catch {
      return false;
    }
  }

  /** 清理一条连接（可重复调用） */
  private dispose(connection: Connection): void {
    clearTimeout(connection.handshakeTimer);
    const removed = this.connections.delete(connection.id);
    const peer = connection.peer;
    connection.peer = null;
    try {
      connection.socket.destroy();
    } catch {
      // 忽略
    }
    if (removed && peer) this.options.onDetach?.(peer);
  }
}

/** 截断用于日志的原始报文 */
function truncateText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

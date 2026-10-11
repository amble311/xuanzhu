import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { WebSocket, WebSocketServer } from "ws";
import { AutoJs6Client } from "./autojs6/client";
import {
  AUTOJS6_APP_SERVER_PORT,
  AUTOJS6_PC_SERVER_PORT,
  commandMessage as autoJs6CommandMessage,
} from "./autojs6/protocol";
import { AutoJs6Server } from "./autojs6/server";
import { buildScreenshotScript } from "./screenshot";
import {
  BRIDGE_IMPLEMENTATION_VERSION,
  DEVICE_BRIDGE_PORT,
  DEVICE_PLUGIN_PROTOCOL_VERSION,
  HANDSHAKE_TIMEOUT_MS,
  helloReply,
  parseDeviceMessage,
  plainCommand,
  pongReply,
  readHelloData,
  readLogData,
  scriptCommand,
  type DeviceCommand,
} from "./protocol";

/**
 * AutoX.js / Auto.js 设备桥。
 *
 * 作用：在 PC 上起一个 WebSocket 服务（默认 9317），手机端的 AutoX.js 连上来之后，
 * 就能把脚本**推过去并运行**、接收脚本日志 —— 也就是把 VSCode 插件那套"操作手机的桥"
 * 搬到终端里，让 xzh 自己（或命令行）能操作手机。
 *
 * 与原插件的差异：
 *   - 只做**单文件**（保存 / 运行 / 停止 / 日志）。插件还有"整个项目打包 zip 同步"，
 *     那条路要二进制帧 + md5，本实现不涉及；
 *   - 不做 ADB/USB 模式（免填 IP 那条），需要 USB 时请用插件或自己 `adb forward`；
 *   - 日志走事件回调（终端面板 / stdout），不依赖 VSCode 的 OutputChannel。
 */

/**
 * 设备连接来自哪套传输。
 *
 * 两套协议**完全不同**，但都接到同一套设备注册表上，因此上层（指令下发、
 * 日志缓冲、HTTP 控制通道、Agent 工具）只需认 `DeviceKind`：
 *   - `autoxjs`：AutoX.js 作为 WebSocket 客户端**连到我们**（我们监听 9317）；
 *   - `autojs6`：我们作为 TCP 客户端**连到手机**（手机开服务器模式，默认 7347）。
 */
export type DeviceKind = "autoxjs" | "autojs6";

/** 连上的设备（握手完成后 `name` 才有值） */
export interface DeviceInfo {
  /** 来源传输（决定界面上的标签与指令编码方式） */
  kind: DeviceKind;
  /** 连接标识（AutoX.js 为 `remoteAddress:remotePort`；AutoJs6 为 `host:port`） */
  id: string;
  /** 设备名。AutoX.js 会上报手机型号；AutoJs6 服务器模式不上报，因此可能是地址 */
  name: string;
  /** AutoX.js / AutoJs6 的 versionCode（AutoJs6 服务器模式拿不到，为 0） */
  appVersionCode: number;
  /** 握手完成时间（毫秒时间戳） */
  attachedAt: number;
}

export interface DeviceLogEntry {
  /** 来源设备名（未命名时退回 id） */
  device: string;
  text: string;
  at: number;
}

export interface DeviceBridgeOptions {
  port?: number;
  /** 相对路径的基准目录（默认进程 cwd） */
  baseDir?: string;
  /** 日志环形缓冲容量，供 `device_logs` 回读（默认 500 行） */
  logBufferSize?: number;
  onDeviceAttach?: (device: DeviceInfo) => void;
  onDeviceDetach?: (device: DeviceInfo) => void;
  onLog?: (entry: DeviceLogEntry) => void;
  /** 桥自身的状态变化（启动 / 停止 / 出错），用于提示用户 */
  onStatus?: (message: string) => void;
}

export interface BridgeStatus {
  running: boolean;
  /** AutoX.js 那侧监听的控制/WebSocket 端口 */
  port: number;
  /** 手机上该填的地址（可能多个网卡）；仅在 AutoX.js 模式下有意义 */
  urls: string[];
  devices: DeviceInfo[];
  /** AutoJs6 出站连接的状态（未启用时为 null） */
  autojs6: {
    address: string;
    connected: boolean;
    /** 是否仍在尝试（含退避重连）；为 false 表示已放弃，需要用户介入 */
    retrying: boolean;
  } | null;
  /** AutoJs6 入站监听（手机「客户端模式」连我们）的状态；未启用时为 null */
  autojs6Listener: { port: number; urls: string[] } | null;
}

/** 单文件脚本大小上限：脚本是一段文本，正常不过几十 KB */
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;

export type ScriptResult =
  | { ok: true; path: string; delivered: number; devices: string[] }
  | { ok: false; message: string };

/**
 * 桥内统一的「一条设备连接」视图。
 *
 * 两种传输（AutoX.js 的 WebSocket 服务端、AutoJs6 的 TCP 客户端）各自实现它，
 * 上层的指令下发 / 日志缓冲 / 控制通道只认这个视图 —— 于是两种协议天然共享
 * `xzh device run/logs/...`、`/device` 与 `device_*` 工具，无需任何分支。
 */
interface Session {
  kind: DeviceKind;
  /**
   * 这条会话由谁建立。
   *
   * 需要区分是因为 AutoJs6 有**两个方向**（我们连手机的 `dial`、手机连我们的 `listen`），
   * 两者的 `kind` 相同但生命周期各自由不同的入口管理，清理时必须各清各的。
   */
  origin: "dial" | "listen";
  id: string;
  /** 握手完成后的设备信息；null 表示尚未握手 */
  info: DeviceInfo | null;
  /** 发送一条**已序列化**的 JSON 消息；连接不可用时返回 false */
  sendJson(payload: string): boolean;
  /** 连接是否仍可用 */
  isAlive(): boolean;
  /** 断开并清理（含定时器、重连计划）；可重复调用 */
  close(): void;
}

export class DeviceBridge {
  private readonly port: number;
  private readonly baseDir: string;
  private readonly logBufferSize: number;
  private readonly options: DeviceBridgeOptions;
  private readonly sessions = new Set<Session>();
  private readonly logs: DeviceLogEntry[] = [];
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  /** AutoJs6 的出站连接（`connectAutoJs6()` 建立；未启用时为 null） */
  private autojs6: { client: AutoJs6Client; address: string } | null = null;
  /** AutoJs6 的**入站**监听（手机「客户端模式」连我们，`startAutoJs6Listener()` 建立） */
  private autojs6Server: AutoJs6Server | null = null;
  /** 最近一次手机回传的截图（`/shot` 收到即覆盖） */
  private latestShot: { data: Buffer; at: number } | null = null;

  constructor(options: DeviceBridgeOptions = {}) {
    this.options = options;
    this.port = options.port ?? DEVICE_BRIDGE_PORT;
    this.baseDir = options.baseDir ?? process.cwd();
    this.logBufferSize = Math.max(50, options.logBufferSize ?? 500);
  }

  // ---------------------------------------------------------------- 生命周期

  /**
   * 启动服务。
   *
   * 失败时抛出的错误带**可操作的说明**：这个端口最常被 VSCode 的 Auto.js 插件占用，
   * 直接抛 `EADDRINUSE` 用户只会一头雾水。
   */
  async start(options: { announceUrls?: boolean } = {}): Promise<void> {
    if (this.httpServer) return;

    const server = http.createServer((req, res) => this.handleHttp(req, res));
    const wss = new WebSocketServer({ server });

    // ⚠ ws 会把底层 http server 的 'error' **转发到 wss 自身**（见 ws 的 addListeners）。
    // 不监听它，端口被占用时这里会抛出未捕获的 'error' 事件，进程被直接打掉 ——
    // 而用户真正需要看到的是下面那句「端口被占用」的可操作提示。
    wss.on("error", () => undefined);

    wss.on("connection", (socket, request) => this.handleConnection(socket, request));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `端口 ${this.port} 已被占用。可能是：\n` +
                `  · 玄猪自己已经有一个设备桥在跑（用 \`xzh device status\` 看一眼，` +
                `同一个控制端口同时只能有一个桥）；\n` +
                `  · VSCode 的 Auto.js / AutoX.js 插件正在运行（它用 9317，两者不能同时开）。\n` +
                `换端口再试：--port <端口>。`,
            ),
          );
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, "0.0.0.0");
    });

    this.httpServer = server;
    this.wss = wss;
    this.options.onStatus?.(
      options.announceUrls === false
        ? // AutoJs6 模式下由 xzh 主动连手机，这里再报一串 ws:// 只会让人以为要填那个地址
          `控制通道已就绪（端口 ${this.port}）`
        : `设备桥已启动，监听 ${this.port}。手机上的 AutoX.js 填：${this.urls().join(" 或 ")}`,
    );
  }

  /** 停止服务：关闭所有设备连接与监听端口 */
  async stop(): Promise<void> {
    // 先断 AutoJs6 的出站连接：它会重连，必须在关服务前停掉
    this.disconnectAutoJs6();
    await this.stopAutoJs6Listener();
    for (const session of this.sessions) {
      try {
        session.close();
      } catch {
        // 忽略单个连接的关闭失败
      }
    }
    this.sessions.clear();

    const wss = this.wss;
    this.wss = null;
    if (wss) {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }

    const server = this.httpServer;
    this.httpServer = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.options.onStatus?.("设备桥已停止。");
  }

  isRunning(): boolean {
    // 两种传输任一在跑就算"桥在运行"：只开 AutoJs6 监听（或只开 AutoX.js 监听）
    // 都是合法状态，比如 VSCode 占着 9317 时用户仍然可以只用 AutoJs6。
    return this.httpServer !== null || this.autojs6Server !== null;
  }

  getPort(): number {
    return this.port;
  }

  /** 手机端该填的地址（每个非内网回环网卡一个） */
  urls(): string[] {
    const ips = localIPv4Addresses();
    return (ips.length > 0 ? ips : ["127.0.0.1"]).map((ip) => `ws://${ip}:${this.port}`);
  }

  // ---------------------------------------------------------------- 设备

  /** 已握手完成的设备 */
  listDevices(): DeviceInfo[] {
    return [...this.sessions]
      .map((session) => session.info)
      .filter((info): info is DeviceInfo => info !== null)
      .sort((a, b) => a.attachedAt - b.attachedAt);
  }

  /** 当前状态快照（供 `/device`、`/status` 与工具使用） */
  status(): BridgeStatus {
    return {
      running: this.isRunning(),
      port: this.port,
      urls: this.isRunning() ? this.urls() : [],
      devices: this.listDevices(),
      autojs6: this.autojs6
        ? {
            address: this.autojs6.address,
            connected: this.autojs6.client.isConnected(),
            retrying: this.autojs6.client.isRetrying(),
          }
        : null,
      autojs6Listener: this.autojs6Server
        ? { port: this.autojs6Server.getPort(), urls: this.listenerUrls() }
        : null,
    };
  }

  // ---------------------------------------------------------------- AutoJs6

  /**
   * 主动连接手机上的 **AutoJs6**（它开「连接电脑 → 服务器模式」，默认 7347）。
   *
   * 为什么统一走这个方向：AutoJs6 的「客户端模式」要求用户先在手机上正确填写
   * **电脑的 IP**，而「服务器模式」只需要一个地址 —— 电脑上是手机 IP，
   * 手机本机（termux）上是 `127.0.0.1`，同一套代码覆盖两种部署，本地还完全不联网。
   *
   * 会顺带把控制通道（HTTP）拉起来：一次性命令 `xzh device run/logs/...`
   * 正是通过它找到这个常驻进程的。
   */
  async connectAutoJs6(host: string, port = AUTOJS6_APP_SERVER_PORT): Promise<void> {
    await this.start({ announceUrls: false });
    this.disconnectAutoJs6();

    const address = `${host.trim()}:${port}`;
    const client = new AutoJs6Client({
      host: host.trim(),
      port,
      onStatus: (message) => this.options.onStatus?.(message),
      onLog: (text) => this.appendLog(address, text),
      onPhoneCommand: (command, data) => {
        // 手机端可能主动要求重跑某个脚本（日志面板上的「重跑」）：能定位到文件就照做
        const id = typeof data.id === "string" ? data.id : "";
        if (command === "rerun" && id) {
          this.options.onStatus?.(`手机请求重跑：${id}`);
          this.runScript(id);
        }
      },
      onConnect: () => {
        session.info = {
          kind: "autojs6",
          id: address,
          // 服务器模式下手机不上报设备名，用地址代替；用户可用 --name 覆盖展示名
          name: address,
          appVersionCode: 0,
          attachedAt: Date.now(),
        };
        this.options.onDeviceAttach?.(session.info);
      },
      onDisconnect: () => {
        const info = session.info;
        session.info = null;
        if (info) this.options.onDeviceDetach?.(info);
      },
    });

    const session: Session = {
      kind: "autojs6",
      origin: "dial",
      id: address,
      info: null,
      sendJson: (payload) => client.sendJson(payload),
      isAlive: () => client.isConnected(),
      close: () => client.close(),
    };

    this.autojs6 = { client, address };
    // 先登记：未连通时 sendJson 返回 false，指令会如实报「未送达」；
    // 而 listDevices() 只看握手完成的会话，所以界面上不会出现一个假的设备。
    this.sessions.add(session);
    client.start();
  }

  /** 断开 AutoJs6 **出站**连接（不影响入站监听，也不影响 AutoX.js 那侧） */
  disconnectAutoJs6(): void {
    this.autojs6 = null;
    for (const session of [...this.sessions]) {
      if (session.kind !== "autojs6" || session.origin !== "dial") continue;
      this.sessions.delete(session);
      // 已连上的会话会经 client 的 onDisconnect 发出 detach 事件，这里不再重复发
      session.close();
    }
  }

  /**
   * 启动 AutoJs6 **入站**监听：手机点「连接电脑 → 客户端模式」填本机 IP 即可连上
   * （默认 `6347`，与 AutoJs6 官方 VSCode 扩展同一个端口，因此**两者不能同时开**）。
   *
   * 为什么值得同时支持这个方向：手机端 UI 就支持它 —— 用户在手机上点一下、填个 IP 就行，
   * 不必去开手机上的服务端开关（那个入口在部分版本里还是「开发中」）。
   */
  async startAutoJs6Listener(port = AUTOJS6_PC_SERVER_PORT): Promise<void> {
    if (this.autojs6Server) return;

    const server = new AutoJs6Server({
      port,
      onStatus: (message) => this.options.onStatus?.(message),
      onLog: (peer, text) => this.appendLog(peer.name, text),
      onPhoneCommand: (peer, command, data) => {
        // 手机端可能主动要求重跑某个脚本（日志面板上的「重跑」）
        const id = typeof data.id === "string" ? data.id : "";
        if (command === "rerun" && id) {
          this.options.onStatus?.(`手机请求重跑：${id}`);
          this.runScript(id);
        }
      },
      onAttach: (peer) => {
        const session: Session = {
          kind: "autojs6",
          origin: "listen",
          id: peer.id,
          info: {
            kind: "autojs6",
            id: peer.id,
            // 客户端模式下手机会上报型号，这里能拿到真正的设备名
            name: peer.name,
            appVersionCode: peer.appVersionCode,
            attachedAt: Date.now(),
          },
          sendJson: (payload) => server.sendTo(peer.id, payload),
          isAlive: () => server.listDevices().some((device) => device.id === peer.id),
          close: () => server.closeDevice(peer.id),
        };
        this.sessions.add(session);
        this.options.onDeviceAttach?.(session.info as DeviceInfo);
      },
      onDetach: (peer) => {
        const session = [...this.sessions].find(
          (item) =>
            item.kind === "autojs6" && item.origin === "listen" && item.id === peer.id,
        );
        if (!session) return;
        this.sessions.delete(session);
        const info = session.info;
        session.info = null;
        if (info) this.options.onDeviceDetach?.(info);
      },
    });

    this.autojs6Server = server;
    try {
      await server.start();
    } catch (err) {
      this.autojs6Server = null;
      throw err;
    }
  }

  /** 停止 AutoJs6 入站监听（并清掉它建立的会话） */
  async stopAutoJs6Listener(): Promise<void> {
    const server = this.autojs6Server;
    this.autojs6Server = null;
    if (!server) return;

    for (const session of [...this.sessions]) {
      if (session.kind !== "autojs6" || session.origin !== "listen") continue;
      this.sessions.delete(session);
      const info = session.info;
      session.info = null;
      if (info) this.options.onDeviceDetach?.(info);
    }
    await server.stop();
  }

  /** 入站监听的地址（每个非回环网卡一个），供界面提示用户填到手机上 */
  listenerUrls(): string[] {
    if (!this.autojs6Server) return [];
    const port = this.autojs6Server.getPort();
    const ips = localIPv4Addresses();
    return (ips.length > 0 ? ips : ["127.0.0.1"]).map((ip) => `${ip}:${port}`);
  }

  // ---------------------------------------------------------------- 截图

  /**
   * 触发一次手机截图，返回图片字节。
   *
   * 三步：① 生成脚本（`screenshot.ts` 里装着"自动点授权框"的样板，见那里的注释）
   * 推到手机运行；② 手机把缩图以 base64 POST 回 `/shot`；③ 这里收下来。
   *
   * 为什么图片要"绕一圈"回传：`captureScreen()` 得到的 `Image` 在手机内存里，
   * 而设备桥只有"推脚本 + 收日志"两条通路，没有文件回传 —— 所以让手机主动发回来。
   */
  async screenshot(
    timeoutMs = 20_000,
  ): Promise<{ ok: true; data: Buffer } | { ok: false; message: string }> {
    const devices = this.listDevices();
    if (devices.length === 0) return { ok: false, message: this.noDeviceMessage() };
    if (!this.httpServer) {
      return { ok: false, message: "控制通道没有运行，无法接收手机回传的截图。" };
    }

    // 用与手机同网段的那个本机 IP：多网卡机器上给错地址（docker/回环）会让手机传不回来
    const device = devices[0];
    const script = buildScreenshotScript({
      host: this.preferredHostFor(device.id),
      port: this.port,
    });

    const file = path.join(os.tmpdir(), `xzh-shot-${Date.now()}.js`);
    let result: ScriptResult;
    try {
      fs.writeFileSync(file, script, "utf8");
      result = this.sendScript("run", file);
    } finally {
      fs.rmSync(file, { force: true });
    }
    if (!result.ok) return { ok: false, message: result.message };

    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    while (Date.now() < deadline) {
      const shot = this.latestShot;
      if (shot && shot.at > startedAt) return { ok: true, data: shot.data };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return {
      ok: false,
      message:
        `等待手机截图超时（${Math.round(timeoutMs / 1000)} 秒）。常见原因：` +
        "① 系统授权框没被点掉（脚本会自动点「立即开始」，仍失败可手动点一次）；" +
        "② 脚本卡住（用 xzh device stop 收尾）；③ 手机与电脑不在同一网络。",
    };
  }

  /** 手机侧能访问到本机的哪个 IP：取与设备同网段的那个 */
  private preferredHostFor(deviceId: string): string {
    const remote = deviceId.split(":")[0] ?? "";
    const prefix = remote.split(".").slice(0, 3).join(".");
    const candidates = localIPv4Addresses();
    return candidates.find((ip) => ip.startsWith(`${prefix}.`)) ?? candidates[0] ?? "127.0.0.1";
  }

  // ---------------------------------------------------------------- 指令

  /** 保存脚本到设备（不运行） */
  pushScript(filePath: string, target?: string): ScriptResult {
    return this.sendScript("save", filePath, target);
  }

  /** 保存脚本到设备并立即运行 */
  runScript(filePath: string, target?: string): ScriptResult {
    return this.sendScript("run", filePath, target);
  }

  /** 停止脚本：给了路径就停那一个，否则停掉全部 */
  stopScript(filePath?: string, target?: string): ScriptResult {
    const sessions = this.selectSessions(target);
    if (sessions.length === 0) {
      return { ok: false, message: this.noDeviceMessage() };
    }
    const stopId = filePath ? this.resolvePath(filePath) : "";
    let delivered = 0;
    for (const session of sessions) {
      if (
        this.sendTo(
          session,
          session.kind === "autojs6"
            ? autoJs6CommandMessage(filePath ? "stop" : "stopAll", filePath ? { id: stopId } : {})
            : filePath
              ? plainCommand("stop", { id: stopId })
              : plainCommand("stopAll"),
        )
      ) {
        delivered++;
      }
    }
    return {
      ok: true,
      path: filePath ? this.resolvePath(filePath) : "",
      delivered,
      devices: sessions.map((session) => deviceLabel(session.info)),
    };
  }

  private sendScript(
    command: DeviceCommand,
    filePath: string,
    target?: string,
  ): ScriptResult {
    if (!this.isRunning()) {
      return {
        ok: false,
        message:
          "设备桥尚未启动。请在 xzh 里执行 /device serve，或在另一个终端运行 `xzh device serve`。",
      };
    }

    const resolved = this.resolvePath(filePath);
    let script: string;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        return { ok: false, message: `不是文件：${resolved}` };
      }
      if (stat.size > MAX_SCRIPT_BYTES) {
        return {
          ok: false,
          message: `脚本过大（${Math.round(stat.size / 1024)} KB），上限 ${Math.round(
            MAX_SCRIPT_BYTES / 1024,
          )} KB。项目级同步请改用 VSCode 插件。`,
        };
      }
      script = fs.readFileSync(resolved, "utf8");
    } catch (err) {
      return {
        ok: false,
        message: `读取脚本失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const sessions = this.selectSessions(target);
    if (sessions.length === 0) {
      return { ok: false, message: this.noDeviceMessage() };
    }

    // 两套协议的指令载荷结构一致（`{type:"command", data:{command,…}}`），
    // 差别只在 AutoX.js 会多带一个 message_id、AutoJs6 严格不需要 —— 各自用自己
    // 的构造函数生成，避免将来某一侧加字段时互相污染。
    let delivered = 0;
    for (const session of sessions) {
      const payload =
        session.kind === "autojs6"
          ? autoJs6CommandMessage(command, {
              id: resolved,
              name: path.basename(resolved),
              script,
            })
          : scriptCommand(command, resolved, script);
      if (this.sendTo(session, payload)) delivered++;
    }
    if (delivered === 0) {
      return { ok: false, message: "指令未能送达任何设备（连接可能刚刚断开）。" };
    }
    return {
      ok: true,
      path: resolved,
      delivered,
      devices: sessions.map((session) => deviceLabel(session.info)),
    };
  }

  // ---------------------------------------------------------------- 日志

  /**
   * 记录一条设备日志（两种传输共用）。
   *
   * 抽出来是因为 AutoJs6 的日志来自出站连接的 socket 回调（此时并没有一个"session"
   * 在手边），而 AutoX.js 的来自 WebSocket 消息 —— 但缓冲与事件必须完全一致，
   * 否则 `device_logs` 工具会时灵时不灵。
   */
  private appendLog(device: string, text: string): void {
    const entry: DeviceLogEntry = { device, text, at: Date.now() };
    this.logs.push(entry);
    if (this.logs.length > this.logBufferSize) {
      this.logs.splice(0, this.logs.length - this.logBufferSize);
    }
    this.options.onLog?.(entry);
  }

  /** 最近的设备日志（最新的在后） */
  recentLogs(limit = 50): DeviceLogEntry[] {
    const count = Math.max(1, limit);
    return this.logs.slice(-count);
  }

  clearLogs(): void {
    this.logs.length = 0;
  }

  // ---------------------------------------------------------------- 内部

  /**
   * AutoX.js 那侧的连接（**手机连我们**）。
   *
   * 这里把一个 WebSocket 包成统一的 `Session`：发送走文本帧、`isAlive` 看 readyState、
   * `close` 顺带清掉握手定时器。上层因此完全不需要知道底下是 WebSocket 还是 TCP。
   */
  private handleConnection(socket: WebSocket, request: http.IncomingMessage): void {
    const remote = request.socket.remoteAddress ?? "unknown";
    const id = `${remote}:${request.socket.remotePort ?? 0}`;
    // 先声明定时器再建 session：close() 依赖它，避免"引用在声明之前"
    let handshakeTimer: NodeJS.Timeout | undefined;
    const session: Session = {
      kind: "autoxjs",
      origin: "listen",
      id,
      info: null,
      sendJson: (payload) => {
        if (socket.readyState !== WebSocket.OPEN) return false;
        try {
          socket.send(payload);
          return true;
        } catch {
          return false;
        }
      },
      isAlive: () => socket.readyState === WebSocket.OPEN,
      close: () => {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        try {
          socket.close();
        } catch {
          // 忽略
        }
      },
    };

    handshakeTimer = setTimeout(() => {
      if (!session.info) {
        // 没有 hello 就断开：否则任何误连到 9317 的东西都会永久占位
        this.options.onStatus?.(
          `连接 ${id} 未在 ${HANDSHAKE_TIMEOUT_MS / 1000} 秒内握手，已断开。`,
        );
        session.close();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    this.sessions.add(session);

    socket.on("message", (raw) => {
      const text = raw.toString();
      const message = parseDeviceMessage(text);
      if (!message) {
        // 手机端发来的东西解析不了：留下原文，否则排查握手问题时会完全没有线索
        this.options.onStatus?.(
          `收到无法解析的消息（已忽略）：${truncateText(text, 200)}`,
        );
        return;
      }
      this.handleDeviceMessage(session, message.type, message.data, text);
    });
    socket.on("close", () => this.detach(session));
    socket.on("error", () => this.detach(session));
  }

  private handleDeviceMessage(
    session: Session,
    type: string,
    data: unknown,
    raw: string,
  ): void {
    switch (type) {
      case "hello": {
        const { name, appVersionCode } = readHelloData(data);
        session.info = {
          kind: "autoxjs",
          id: session.id,
          name: name || session.id,
          appVersionCode,
          attachedAt: Date.now(),
        };
        // 不用在这里清握手定时器：它触发时会先看 `session.info`，已握手即什么都不做。
        // （定时器由 session.close() 负责清理，这样两种传输的清理路径只有一条。）
        const reply = helloReply(appVersionCode);
        const sent = this.sendTo(session, reply);
        // 握手是最容易出问题的一步（手机端的兼容性校验只认插件版本号），
        // 因此把"收到的原文 + 我们回的原文"都留进日志，出问题时不用猜。
        this.options.onStatus?.(
          `握手：${name || session.id}（versionCode ${appVersionCode}）` +
            `${sent ? "" : "——⚠ 应答发送失败"}` +
            `｜协议版本 ${DEVICE_PLUGIN_PROTOCOL_VERSION}（实现 v${BRIDGE_IMPLEMENTATION_VERSION}）`,
        );
        this.options.onStatus?.(`  手机原始 hello：${truncateText(raw, 240)}`);
        this.options.onStatus?.(`  已回应：${truncateText(reply, 240)}`);
        this.options.onDeviceAttach?.(session.info);
        return;
      }
      case "ping":
        this.sendTo(session, pongReply(data));
        return;
      case "device_name": {
        // 部分版本先连上、稍后才把设备名报过来
        const { name } = readHelloData(data);
        if (session.info && name) session.info.name = name;
        return;
      }
      case "log": {
        const text = readLogData(data);
        if (!text) return;
        this.appendLog(deviceLabel(session.info), text);
        return;
      }
      default:
        // 未知类型一律忽略（不崩），但要留痕：握手阶段漏处理某种消息就会表现为"连上又立刻断开"
        this.options.onStatus?.(
          `收到未知消息类型「${type}」，已忽略：${truncateText(raw, 200)}`,
        );
        return;
    }
  }

  private detach(session: Session): void {
    if (!this.sessions.delete(session)) return;
    if (session.info) {
      this.options.onDeviceDetach?.(session.info);
      session.info = null;
    }
    // 会话自己负责清理：WebSocket 会话清握手定时器，AutoJs6 会话停掉重连计划
    session.close();
  }

  private sendTo(session: Session, payload: string): boolean {
    return session.isAlive() && session.sendJson(payload);
  }

  /** 选出目标设备：不传 target 表示所有已握手设备；传了就按 id 精确匹配或设备名模糊匹配 */
  private selectSessions(target?: string): Session[] {
    const attached = [...this.sessions].filter((session) => session.info !== null);
    if (!target) return attached;
    const needle = target.trim().toLowerCase();
    return attached.filter((session) => {
      const info = session.info as DeviceInfo;
      return (
        session.id.toLowerCase() === needle ||
        info.name.toLowerCase().includes(needle)
      );
    });
  }

  /**
   * 「没有设备」时的提示。
   *
   * 按**当前启用的传输**给指引 —— 否则用户看到的是自己没在用的那套（比如用
   * AutoJs6 却被告知"去手机 AutoX.js 里填 WebSocket 地址"），只会更困惑。
   */
  private noDeviceMessage(): string {
    if (this.autojs6Server) {
      return (
        `AutoJs6 尚未连接（本机正在监听 ${this.listenerUrls().join(" 或 ")}）。请确认：` +
        "① 手机上 AutoJs6 打开「连接电脑 → 客户端模式」，填入上面的地址；" +
        "② 端口用默认的 " +
        `${AUTOJS6_PC_SERVER_PORT}；③ 手机与电脑在同一网络。`
      );
    }
    if (this.autojs6) {
      return (
        `AutoJs6 尚未连接（${this.autojs6.address}）。请确认：` +
        "① 手机上 AutoJs6 打开「连接电脑 → 服务器模式」（默认端口 7347）；" +
        "② 地址填的是手机 IP，手机本机运行 xzh 时用 127.0.0.1；" +
        "③ 两者在同一网络。"
      );
    }
    return (
      "当前没有已连接的设备。请确认：① 手机与电脑在同一网络；" +
      `② 手机 AutoX.js 里填了 ${this.urls().join(" 或 ") || `ws://<电脑IP>:${this.port}`} 并点了连接。`
    );
  }

  private resolvePath(filePath: string): string {
    const expanded = filePath.startsWith("~")
      ? path.join(os.homedir(), filePath.slice(1))
      : filePath;
    return path.isAbsolute(expanded) ? expanded : path.resolve(this.baseDir, expanded);
  }

  // ---------------------------------------------------------------- 控制通道

  /**
   * 极简 HTTP 控制通道。
   *
   * 为什么需要：桥是常驻进程，而 `xzh device push/run/...` 是一次性命令 ——
   * 它们得能找到"已经在跑的那个桥"。插件用的是同一思路（`/exec?cmd=save&path=...`），
   * 这里保持兼容并补上查询接口。
   *
   * 只监听 0.0.0.0 是为了让手机连进来；控制接口没有鉴权，因此**只应在本机可信网络使用**
   * （与插件行为一致：它同样对同网段开放）。
   */
  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const json = (payload: unknown, code = 200) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };

    switch (url.pathname) {
      case "/":
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(
          `xzh device bridge\n` +
            `devices: ${this.listDevices().length}\n` +
            `url: ${this.urls().join(" ")}\n` +
            `endpoints: /status /devices /logs /exec?cmd=save|run|rerun|stop|stopAll&path=<脚本>\n`,
        );
        return;
      case "/status":
        json(this.status());
        return;
      case "/devices":
        json({ devices: this.listDevices() });
        return;
      case "/logs": {
        const limit = Number(url.searchParams.get("limit") ?? "50");
        json({ logs: this.recentLogs(Number.isFinite(limit) ? limit : 50) });
        return;
      }
      case "/exec": {
        const cmd = (url.searchParams.get("cmd") ?? "").trim();
        const scriptPath = (url.searchParams.get("path") ?? "").trim();
        const target = (url.searchParams.get("device") ?? "").trim() || undefined;
        switch (cmd) {
          case "save":
          case "push":
            json(scriptPath ? this.pushScript(scriptPath, target) : { ok: false, message: "缺少 path 参数" });
            return;
          case "run":
            json(scriptPath ? this.runScript(scriptPath, target) : { ok: false, message: "缺少 path 参数" });
            return;
          case "rerun": {
            if (!scriptPath) {
              json({ ok: false, message: "缺少 path 参数" });
              return;
            }
            // 与插件语义一致：先停掉再跑（手机端切换脚本时不做这一步容易残留上一个脚本）
            this.stopScript(undefined, target);
            setTimeout(() => this.runScript(scriptPath, target), 800);
            json({ ok: true, path: this.resolvePath(scriptPath), action: "rerun" });
            return;
          }
          case "stop":
            json(this.stopScript(scriptPath || undefined, target));
            return;
          case "stopAll":
            json(this.stopScript(undefined, target));
            return;
          default:
            json({ ok: false, message: `未知 cmd：${cmd}` }, 400);
            return;
        }
      }
      case "/shot": {
        // 手机把截图 POST 上来（body 是 base64 文本，见 screenshot.ts）
        if (req.method !== "POST") {
          json({ ok: false, message: "请用 POST 上传截图" }, 405);
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          // Buffer/Uint8Array 的泛型摩擦，见 autojs6/protocol.ts 里的同类说明
          const raw = Buffer.concat(chunks as unknown as Uint8Array[]);
          const data = Buffer.from(raw.toString("utf8").trim(), "base64");
          if (data.length === 0) {
            json({ ok: false, message: "截图内容为空" }, 400);
            return;
          }
          this.latestShot = { data, at: Date.now() };
          json({ ok: true, bytes: data.length });
        });
        return;
      }
      case "/screenshot": {
        // 触发一次截图并**直接把图片返回**（CLI 与工具都走这条，避免两步轮询）
        void this.screenshot()
          .then((result) => {
            if (!result.ok) {
              json({ ok: false, message: result.message }, 504);
              return;
            }
            res.writeHead(200, {
              "content-type": "image/jpeg",
              "content-length": String(result.data.length),
            });
            res.end(result.data);
          })
          .catch((err) => json({ ok: false, message: String(err) }, 500));
        return;
      }
      default: {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found\n");
        return;
      }
    }
  }
}

/** 截断用于日志的原始报文（手机端可能回传很长的内容） */
function truncateText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 设备展示名：优先设备名，缺失时退回连接 id */
function deviceLabel(info: DeviceInfo | null): string {
  if (!info) return "未握手连接";
  return info.name || info.id;
}

/** 本机所有非回环 IPv4（手机要连的就是这些地址之一） */
function localIPv4Addresses(): string[] {
  const result: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] ?? []) {
      if (info.family === "IPv4" && !info.internal) result.push(info.address);
    }
  }
  return result;
}

import * as http from "http";
import { DEVICE_BRIDGE_PORT } from "./protocol";

/**
 * 设备桥的**控制通道客户端**。
 *
 * 桥是常驻进程（`xzh device serve`，或 TUI 里的 `/device serve`），而 push / run / stop
 * 这类操作既可能来自**另一个进程**的一次性命令，也可能来自 xzh 进程内的 Agent 工具 ——
 * 两者都通过桥上的 HTTP 接口说话（见 `DeviceBridge.handleHttp`）。
 *
 * 用 `http.request` 而不是全局 `fetch`：Node 18 早期版本用 fetch 会打印
 * ExperimentalWarning，而这里的请求都是本机短连接，用内置 http 更稳且无告警。
 */

export interface DeviceControlDevice {
  /** 来源传输（AutoX.js / AutoJs6），与 `server.ts` 的 `DeviceKind` 保持一致 */
  kind: "autoxjs" | "autojs6";
  id: string;
  name: string;
  appVersionCode: number;
  attachedAt: number;
}

export interface DeviceControlStatus {
  running: boolean;
  port: number;
  /** AutoX.js 那侧手机要填的 ws:// 地址 */
  urls: string[];
  devices: DeviceControlDevice[];
  /**
   * AutoJs6 的**出站**连接（xzh 连手机的服务器模式）。未启用为 null。
   *
   * 注意这里必须与 `server.ts` 的 `BridgeStatus` 保持同步 —— 这段类型描述的是
   * 桥通过 HTTP 控制通道返回的 JSON，字段对不上时 CLI / 工具会读到 undefined。
   */
  autojs6: {
    address: string;
    connected: boolean;
    retrying: boolean;
  } | null;
  /** AutoJs6 的**入站**监听（手机客户端模式连我们）。未启用为 null */
  autojs6Listener: { port: number; urls: string[] } | null;
}

export interface DeviceControlLog {
  device: string;
  text: string;
  at: number;
}

export interface DeviceControlResult {
  ok: boolean;
  message?: string;
  path?: string;
  delivered?: number;
  devices?: string[];
}

/** 单次控制请求的超时（本机回环，正常都在毫秒级） */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * 解析设备桥端口，优先级：显式值 > 环境变量 `XZH_DEVICE_PORT` > 默认 9317。
 *
 * 环境变量存在的意义：想避开 VSCode 插件占用的 9317 时，
 * 只要 `export XZH_DEVICE_PORT=9399`，`serve` 与其余子命令就都跟着换，无需每个命令都带 `--port`。
 */
export function resolveDevicePort(explicit?: number): number {
  if (typeof explicit === "number" && explicit > 0 && explicit <= 65535) {
    return explicit;
  }
  const fromEnv = Number.parseInt(process.env.XZH_DEVICE_PORT ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv <= 65535) return fromEnv;
  return DEVICE_BRIDGE_PORT;
}

export class DeviceControlClient {
  private readonly port: number;

  constructor(port: number = DEVICE_BRIDGE_PORT) {
    this.port = port;
  }

  getPort(): number {
    return this.port;
  }

  /** 桥是否在运行（顺带拿到状态）；不可达时返回 null */
  /**
   * 触发一次手机截图（桥负责生成脚本、推给手机、等图片回传），返回 JPEG 字节。
   *
   * 单独实现而不用通用的 JSON 请求辅助：响应体是**二进制图片**，不是 JSON；
   * 失败时才回 JSON（`{message}`），因此这里按状态码分支处理。
   */
  screenshot(
    timeoutMs = 40_000,
  ): Promise<{ ok: true; data: Buffer } | { ok: false; message: string }> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: this.port,
          path: "/screenshot",
          method: "POST",
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            // Buffer/Uint8Array 的泛型摩擦（同 autojs6/protocol.ts 里的说明）
            const body = Buffer.concat(chunks as unknown as Uint8Array[]);
            if (res.statusCode === 200) {
              resolve({ ok: true, data: body });
              return;
            }
            let message = `截图失败（HTTP ${res.statusCode}）`;
            try {
              const parsed = JSON.parse(body.toString("utf8")) as { message?: string };
              if (parsed.message) message = parsed.message;
            } catch {
              // 非 JSON 响应：保留默认信息
            }
            resolve({ ok: false, message });
          });
        },
      );
      req.on("error", (err) => resolve({ ok: false, message: String(err) }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, message: `截图超时（${timeoutMs}ms）` });
      });
      req.end();
    });
  }

  async status(): Promise<DeviceControlStatus | null> {
    return this.request<DeviceControlStatus>("/status");
  }

  async isRunning(): Promise<boolean> {
    return (await this.status()) !== null;
  }

  async devices(): Promise<DeviceControlDevice[] | null> {
    const result = await this.request<{ devices: DeviceControlDevice[] }>("/devices");
    return result ? result.devices : null;
  }

  async logs(limit = 50): Promise<DeviceControlLog[] | null> {
    const result = await this.request<{ logs: DeviceControlLog[] }>(
      `/logs?limit=${encodeURIComponent(String(limit))}`,
    );
    return result ? result.logs : null;
  }

  /** 下发一条指令（save / run / rerun / stop / stopAll） */
  async exec(
    cmd: string,
    scriptPath?: string,
    device?: string,
  ): Promise<DeviceControlResult> {
    const params = new URLSearchParams({ cmd });
    if (scriptPath) params.set("path", scriptPath);
    if (device) params.set("device", device);
    const result = await this.request<DeviceControlResult>(
      `/exec?${params.toString()}`,
    );
    if (!result) {
      return {
        ok: false,
        message:
          `连不上设备桥（127.0.0.1:${this.port}）。先在另一个终端运行 \`xzh device serve\`，` +
          `或在 xzh 里执行 /device serve。`,
      };
    }
    return result;
  }

  private request<T>(pathname: string): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: this.port,
          path: pathname,
          method: "GET",
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks as unknown as Uint8Array[]).toString("utf8")) as T);
            } catch {
              // 桥返回了非 JSON（例如 404 的纯文本）——当作不可用
              resolve(null);
            }
          });
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.on("error", () => resolve(null));
      req.end();
    });
  }
}

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentEvents } from "../core/agent";
import { activeModelEntry, loadConfig } from "../config/store";
import { commandHelpLines } from "../core/help-text";
import { btcInfoLines, collectBtcPanelData } from "../btc/panel-data";
import { aInfoLines, collectASharePanelData } from "../a/info";
import { createProvider } from "../llm";
import { createAShareMode } from "../modes/a";
import { createBtcMode } from "../modes/btc";
import type { AgentMode } from "../modes";
import { getAShareHome, getBtcHome } from "../utils/paths";
import { VERSION } from "../utils/version";
import { gatewayHome, gatewayPaths } from "./paths";
import {
  gatewayPort,
  isPidAlive,
  parseGatewayCommand,
  readGatewayMode,
  readGatewayState,
  writeGatewayMode,
  writeGatewayState,
  type GatewayModeState,
  type GatewayState,
} from "./service";
import { loadAccount } from "./weixin/paths";
import { startWeixinChannel, type WeixinChannel } from "./weixin/channel";

/**
 * `xzh gateway run`：常驻后台进程。
 *
 * 语义等价于「在 `~/.xzh_gateway` 里启动 xzh」，差别是：
 * - 不渲染 TUI，没有 quit/exit 这类命令能让它退出；
 * - **忽略 SIGHUP**：关终端、SSH 断线都不该把它带走；
 * - 对外暴露一个极简 HTTP 接口（`/health`、`/message`、`/shutdown`），
 *   作为未来微信频道的接入点 —— 频道适配层只需要 POST 文本、拿回回复。
 *
 * 刻意不做的事：不在这里实现「微信协议」。协议会变、要凭据、要重连，
 * 属于适配层；gateway 只保证「进程常驻 + 一个稳定的消息入口」。
 */

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  process.stdout.write(`${line}\n`);
}

function acquireLock(lockFile: string): boolean {
  const write = (): boolean => {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };
  if (write()) return true;
  // 已存在：只有确认「pid 不在了」才接管，避免把活着的实例顶掉
  try {
    const pid = Number(fs.readFileSync(lockFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) return false;
    fs.rmSync(lockFile, { force: true });
  } catch {
    return false;
  }
  return write();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(chunks.map((chunk) => chunk.toString("utf8")).join("")));
    req.on("error", reject);
  });
}

export async function runGateway(): Promise<void> {
  const home = gatewayHome();
  const paths = gatewayPaths(home);
  fs.mkdirSync(paths.run, { recursive: true });
  fs.mkdirSync(paths.logs, { recursive: true });

  if (!acquireLock(paths.lockFile)) {
    const existing = readGatewayState(home);
    process.stderr.write(
      `gateway 已在运行（pid ${existing?.pid ?? "?"}），本次退出。\n` +
        "要看状态用 `xzh gateway status`，重启用 `xzh gateway restart`。\n",
    );
    process.exit(1);
  }

  const port = gatewayPort();
  const startedAt = new Date().toISOString();
  const state: GatewayState = {
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
    version: VERSION,
    cwd: home,
    port,
  };

  let agent: Agent | null = null;
  let modelLabel = "";
  let lastError: string | undefined;
  /** 当前这轮回复的累积文本（Agent.run 的产出通过事件回调给） */
  let replyBuffer = "";
  /** 需要确认的工具：无人在场时拒绝，并把原因带回给调用方 */
  let deniedNote = "";

  /** 当前模式（持久化在 run/mode.json，重启后仍是同一个频道模式） */
  let modeState = readGatewayMode(home);
  if (modeState?.name === "btc") {
    process.env.XZH_BTC_ROLE = modeState.paper ? "paper" : "live";
  }

  const modeSpec = (
    state: GatewayModeState | null,
  ): { mode?: AgentMode; cwd: string; label: string } => {
    if (state?.name === "btc") {
      const mode = createBtcMode({ paper: state.paper === true });
      return { mode, cwd: mode.home, label: mode.label };
    }
    if (state?.name === "a") {
      const mode = createAShareMode();
      return { mode, cwd: mode.home, label: mode.label };
    }
    return { cwd: home, label: "xzh 普通模式" };
  };

  /**
   * 切换模式：先清旧模式再切目录（否则 cwdLocked 会拒绝），然后重新注入提示词/工具。
   * 不启动 btc 常驻后端 —— 与 TUI 的 `/btc` 语义一致，避免切个模式就触发自主巡检。
   */
  const applyGatewayMode = (next: GatewayModeState | null): string => {
    const spec = modeSpec(next);
    process.env.XZH_BTC_ROLE =
      next?.name === "btc" ? (next.paper ? "paper" : "live") : "live";

    if (agent) {
      agent.setMode(undefined);
      if (path.resolve(agent.getCwd()) !== path.resolve(spec.cwd)) {
        agent.setCwd(spec.cwd);
      }
      if (spec.mode) agent.setMode(spec.mode);
    }
    try {
      spec.mode?.bootstrap?.(spec.cwd);
    } catch {
      // 资产释放失败不阻断；工具会自行报环境未就绪
    }

    modeState = next;
    writeGatewayMode(next, home);
    state.cwd = spec.cwd;
    writeGatewayState(state, home);
    log(`模式切换：${spec.label}（cwd=${spec.cwd}）`);
    return spec.label;
  };

  // 微信里的 /help 与 xzh 界面完全一致（ANSI 转义对纯文本渠道无意义，strip 掉）
  const commandHelp = (): string => {
    const plain = commandHelpLines().map((line) =>
      line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""),
    );
    return [
      "玄猪命令帮助（与 xzh 内一致）：",
      ...plain,
      "",
      "微信内说明：/btc、/btc moni、/a、/xzh 会切换模式并自动拉起对应后台；",
      "鼠标 / 快捷键 / 右侧终端等条目仅适用于 xzh 界面。",
    ].join("\n");
  };

  /** 切模式后拉起对应后台（btc 的 live/paper 后端、A 股巡检）；已在运行时是「复用」 */
  const ensureBackend = async (mode: AgentMode): Promise<string | undefined> => {
    if (!mode.ensureService) return undefined;
    try {
      return (await mode.ensureService()).message || undefined;
    } catch (err) {
      return `后台进程启动失败：${err instanceof Error ? err.message : String(err)}`;
    }
  };

  /** 返回 null 表示「不是命令」，应交给模型 */
  const handleCommand = async (text: string): Promise<string | null> => {
    const command = parseGatewayCommand(text);
    if (!command) return null;
    if (command.kind === "help") return commandHelp();
    if (command.kind === "usage") return command.message;

    if (command.kind === "info") {
      if (!modeState) {
        return "当前是普通模式；发送 /btc、/btc moni 或 /a 切换模式后，/info 才有右侧面板详情可看。";
      }
      if (modeState.name === "btc") {
        const data = await collectBtcPanelData(
          getBtcHome(),
          modeState.paper ? "paper" : "live",
        );
        return btcInfoLines(data).join("\n");
      }
      const data = await collectASharePanelData();
      return aInfoLines(data).join("\n");
    }

    if (command.kind === "xzh") {
      if (!modeState) return `当前已是 xzh 普通模式（${home}）。`;
      const previous = modeSpec(modeState).label;
      applyGatewayMode(null);
      return `✓ 已退出 ${previous}，回到 ${home}。`;
    }

    if (command.kind === "btc") {
      if (modeState?.name === "btc" && (modeState.paper === true) === command.paper) {
        const serviceMessage = await ensureBackend(createBtcMode({ paper: command.paper }));
        return `已在 ${modeSpec(modeState).label}。${serviceMessage ? `\n${serviceMessage}` : ""}`;
      }
      const label = applyGatewayMode({ name: "btc", paper: command.paper });
      const serviceMessage = await ensureBackend(createBtcMode({ paper: command.paper }));
      return `✓ 已切换到 ${label}（工作目录 ${getBtcHome()}）。${serviceMessage ? `\n${serviceMessage}` : ""}`;
    }

    if (modeState?.name === "a") {
      const serviceMessage = await ensureBackend(createAShareMode());
      return `已在 A 股分析模式。${serviceMessage ? `\n${serviceMessage}` : ""}`;
    }
    const label = applyGatewayMode({ name: "a" });
    const serviceMessage = await ensureBackend(createAShareMode());
    return `✓ 已切换到 ${label}（工作目录 ${getAShareHome()}）。${serviceMessage ? `\n${serviceMessage}` : ""}`;
  };

  const ensureAgent = (): Agent => {
    if (agent) return agent;
    const config = loadConfig();
    const active = activeModelEntry(config);
    if (!active) {
      throw new Error("尚未配置任何模型（先运行 xzh model add）");
    }
    const provider = createProvider(config, active);
    modelLabel = `${active.provider}/${active.model}`;

    const events: AgentEvents = {
      onText: (delta) => {
        replyBuffer += delta;
      },
      onReasoning: () => undefined,
      onToolStart: (call) => log(`工具 ${call.name}`),
      onToolEnd: () => undefined,
      onStatus: () => undefined,
      onNotice: (message) => log(`提示 ${message}`),
      // gateway 目前没有交互式确认通道；未来接微信时可以把这里换成「发消息问用户」
      confirm: async (request) => {
        deniedNote = `需要确认的操作（${request.tool}）已拒绝：gateway 当前没有交互式确认通道`;
        log(deniedNote);
        return false;
      },
      onRoundLimit: async () => false,
    };

    const spec = modeSpec(modeState);
    try {
      spec.mode?.bootstrap?.(spec.cwd);
    } catch {
      // 资产释放失败不阻断；工具会自行报环境未就绪
    }
    agent = new Agent(provider, config, spec.cwd, events, active, {
      mode: spec.mode,
      autoMemory: true,
      taskLedger: false,
      backgroundJobs: false,
      maxToolRounds: 60,
    });
    // 重启后恢复到持久化的 btc / a 模式时，后台也要跟着拉起来
    if (spec.mode?.ensureService) {
      void spec.mode
        .ensureService()
        .then((result) => log(result.message))
        .catch((err: unknown) => log(`后台拉起失败：${err instanceof Error ? err.message : String(err)}`));
    }
    state.model = modelLabel;
    state.cwd = spec.cwd;
    writeGatewayState(state, home);
    return agent;
  };

  /** 串行处理：Agent 实例不是并发安全的，同时两条消息会把上下文搅在一起 */
  let queue: Promise<unknown> = Promise.resolve();
  const handleMessage = (text: string): Promise<string> => {
    const task = queue.then(async () => {
      // `/btc` / `/a` / `/xzh` 这类命令不进入对话历史，也不调用模型
      const commandReply = await handleCommand(text);
      if (commandReply !== null) return commandReply;

      const runner = ensureAgent();
      replyBuffer = "";
      deniedNote = "";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5 * 60_000);
      try {
        await runner.run(text, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      const reply = replyBuffer.trim() || "（本轮没有文本输出）";
      return deniedNote ? `${reply}\n\n[${deniedNote}]` : reply;
    });
    // 无论成败都要让队列继续，否则一条失败的消息会把后续全部堵死
    queue = task.catch(() => undefined);
    return task;
  };

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    try {
      if (req.method === "GET" && (url === "/health" || url === "/")) {
        json(res, 200, {
          ok: true,
          pid: process.pid,
          uptimeSec: Math.round(process.uptime()),
          version: VERSION,
          model: modelLabel || null,
          mode: modeState?.name ?? "xzh",
          cwd: modeSpec(modeState).cwd,
          lastError: lastError ?? null,
        });
        return;
      }

      if (req.method === "POST" && url === "/message") {
        const raw = await readBody(req);
        let text = "";
        try {
          const parsed = JSON.parse(raw) as { text?: unknown };
          text = typeof parsed.text === "string" ? parsed.text.trim() : "";
        } catch {
          json(res, 400, { ok: false, error: "请求体必须是 JSON：{ \"text\": \"...\" }" });
          return;
        }
        if (!text) {
          json(res, 400, { ok: false, error: "text 不能为空" });
          return;
        }
        try {
          const reply = await handleMessage(text);
          json(res, 200, { ok: true, reply, model: modelLabel || null });
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          state.lastError = lastError;
          writeGatewayState(state, home);
          json(res, 503, { ok: false, error: lastError });
        }
        return;
      }

      if (req.method === "POST" && url === "/shutdown") {
        json(res, 200, { ok: true, stopping: true });
        setTimeout(() => void shutdown(0), 50);
        return;
      }

      json(res, 404, { ok: false, error: "未知路径（/health、/message、/shutdown）" });
    } catch (err) {
      json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.on("error", (err) => {
    lastError = `监听 127.0.0.1:${port} 失败：${err.message}`;
    state.lastError = lastError;
    writeGatewayState(state, home);
    log(lastError);
    cleanup();
    process.exit(1);
  });

  let weixin: WeixinChannel | null = null;

  server.listen(port, "127.0.0.1", () => {
    log(`gateway 已启动 pid=${process.pid} port=${port} cwd=${home}`);
    // 启动即写一次状态：`xzh gateway` 的等待逻辑靠它判断「起来了」
    writeGatewayState(state, home);

    // 微信频道：登录过才启动（没登录不该在日志里刷重试）
    const account = loadAccount(home);
    if (account) {
      const allowed = (process.env.XZH_WEIXIN_ALLOWED_USERS ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      weixin = startWeixinChannel({
        home,
        account,
        log,
        allowedUsers: allowed,
        // 与 HTTP /message 共用同一条串行队列：同一个 Agent 实例不能并发
        onMessage: (text) => handleMessage(text),
      });
      log(`微信频道已启动 account=${account.accountId}`);
    } else {
      log("微信未登录（要接微信请运行 xzh gateway weixin login）");
    }
  });

  const heartbeat = setInterval(() => {
    state.updatedAt = new Date().toISOString();
    try {
      writeGatewayState(state, home);
    } catch (err) {
      log(`写状态失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, 30_000);
  heartbeat.unref();

  // 关键：SIGHUP 不退出。关终端 / SSH 断线时 shell 会发它，
  // 常驻服务被「关窗口」带走就等于没有常驻。
  process.on("SIGHUP", () => log("收到 SIGHUP，继续运行"));

  let closing = false;
  const cleanup = (): void => {
    try {
      fs.rmSync(paths.lockFile, { force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(paths.stateFile, { force: true });
    } catch {
      // ignore
    }
  };

  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    log("gateway 正在退出");
    weixin?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup();
    process.exit(code);
  };

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  // 兜底：任何意外退出路径都别留下锁文件（否则下次启动要人工删）
  process.on("exit", cleanup);
}

/** 供测试与工具复用：当前 gateway 的日志尾部 */
export function tailGatewayLog(home = gatewayHome(), lines = 20): string {
  try {
    const file = path.join(gatewayPaths(home).logFile);
    const text = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    return text.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

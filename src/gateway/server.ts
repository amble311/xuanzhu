import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentEvents } from "../core/agent";
import { activeModelEntry, loadConfig, saveConfig } from "../config/store";
import { commandHelpLines } from "../core/help-text";
import { formatLocalTime } from "../utils/time";
import { btcInfoLines, btcTradeHistoryLines, collectBtcPanelData } from "../btc/panel-data";
import { aInfoLines, aTradeLines, collectASharePanelData } from "../a/info";
import { TOOLS, toolVisibleInMode } from "../tools";
import { describeTrigger, readTriggers } from "../btc/triggers";
import { setPaused } from "../btc/pause";
import { ensureBtcBackend, stopBtcBackend } from "../btc/daemon";
import { startAService, stopAService } from "../a/monitor";
import { readPause as readAPause, setPaused as setAPaused } from "../a/pause";
import { canResetPaperLedger, resetPaperLedger } from "../btc/paper-reset";
import { expandHome, getDataSubdir } from "../utils/paths";
import { readRules, describeRule } from "../a/rules";
import { readRuleAudits } from "../a/rule-audit";
import { readScheduleQueue } from "../a/schedule";
import { loadWatchlist } from "../a/watchlist";
import { poolSize } from "../a/settings";
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
  readPeerModes,
  sameGatewayMode,
  writePeerMode,
  writeGatewayMode,
  writeGatewayState,
  type GatewayModeState,
  type GatewayState,
} from "./service";
import { loadAccount } from "./weixin/paths";
import { startWeixinChannel, type WeixinChannel } from "./weixin/channel";
import { startFeedForwarder, type FeedForwarder } from "./feed";
import { startOutbox, type Outbox } from "./outbox";
import { WEIXIN_CAPABILITIES } from "./channels";
import {
  appendDigest,
  batchDigestEntries,
  clearDigest,
  digestHint,
  formatDigest,
  readDigest,
} from "./digest";
import { authorizeRequest, ensureHttpToken } from "./auth";
import { createPeerQueues } from "./queues";
import { withBtcRole, type BtcRole } from "../btc/role";
import { loadSessionMessages } from "../core/sessions";
import { applyProxyConfig } from "../network/proxy";

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

  // `/message` 能驱动一个有 bash 的 agent：只监听 127.0.0.1 不等于安全，
  // 本机任意进程都能 POST。首次启动生成令牌（0600），客户端要带 Bearer。
  const httpToken = ensureHttpToken(home);

  // 代理：网关是 systemd 拉起的，**不会继承 shell 的 HTTP(S)_PROXY**（~/.bashrc 里的
  // export 只对交互式 shell 生效）。不应用配置代理的话，币安行情会直连失败，
  // 微信 `/info` 就显示「行情接口不可用」，而终端里（继承了 shell env）一切正常。
  const bootConfig = loadConfig();
  try {
    const applied = applyProxyConfig(bootConfig);
    if (applied.error) log(`代理：${applied.error}`);
    else if (applied.active) log(`代理：已启用 ${applied.proxy}`);
  } catch (err) {
    log(`代理初始化失败：${err instanceof Error ? err.message : String(err)}`);
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

  let modelLabel = "";
  let lastError: string | undefined;

  /**
   * 单个「对话对端」的会话。
   *
   * **为什么必须按对端隔离**：Agent 实例自带对话历史，模式（cwd / 工具集 / 记忆）也挂在
   * 实例上。以前全进程共用一个 Agent —— 微信里 A 股聊完再 `/btc`，旧上下文仍在，
   * 模型会把两个账本混着答（2026-11-13 实测「btc 模拟盘里说 A 股工具已加载」）；
   * 两个微信号同时使用时，还会互相覆盖模式与历史。
   *
   * 现在每个对端（HTTP `/message` 也算一个）各有一个 Agent + 模式 + 缓冲；
   * **同一对端串行、不同对端并发**（见 `createPeerQueues`），会话通过
   * AsyncLocalStorage 传给命令与事件回调，不再有可被并发覆盖的进程级变量。
   */
  interface GatewaySession {
    key: string;
    agent: Agent | null;
    mode: GatewayModeState | null;
    replyBuffer: string;
    deniedNote: string;
    lastToolNote: string;
  }

  const HTTP_SESSION_KEY = "__http__";

  /**
   * 每个「对端 + 模式」一份会话文件（JSONL，格式与 `src/core/sessions.ts` 一致）。
   *
   * 为什么分模式：切模式会清空对话历史（`agent.setMode`），但旧会话文件里仍有内容；
   * 若共用一个文件，重启后恢复出来的历史会带着上一个模式的上下文，正是
   * 「A 股聊完再 /btc，模型把两个账本混着答」的成因。
   */
  const sessionFileFor = (key: string, mode: GatewayModeState | null): string => {
    const hash = createHash("sha1")
      .update(`${key}|${mode?.name ?? "xzh"}${mode?.name === "btc" ? `:${mode.paper === true}` : ""}`)
      .digest("hex")
      .slice(0, 12);
    return path.join(home, "data", "sessions", `${hash}.jsonl`);
  };

  /** 会话文件不存在就写一行 meta（`loadSessionMessages` 会跳过它） */
  const ensureSessionFile = (file: string, cwd: string): string => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) {
        fs.writeFileSync(
          file,
          `${JSON.stringify({
            type: "meta",
            cwd: path.resolve(cwd),
            version: VERSION,
            startedAt: new Date().toISOString(),
          })}\n`,
          "utf8",
        );
      }
    } catch {
      // 会话文件创建失败只影响重启恢复，不阻断对话
    }
    return file;
  };

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
   * btc 的网络引导（直连交易所不通 → 自动找本机代理），进程内只做一次。
   *
   * 与 TUI 的 `xzh btc` 走同一条路径（`src/btc/network.ts`）：网关由 systemd 拉起，
   * **不继承 `~/.bashrc` 里的 HTTP(S)_PROXY** —— 不跑这一步，`fetchTicker` 会直连超时，
   * 面板与 `/info` 就只剩「行情接口不可用」，而终端里一切正常。
   */
  let btcNetworkReady: Promise<void> | undefined;
  const ensureBtcNetworkOnce = (): Promise<void> => {
    btcNetworkReady ??= import("../btc/network")
      .then(({ ensureBtcNetwork }) => ensureBtcNetwork({ config: loadConfig() }))
      .then((result) => {
        if (result.notes.length > 0) log(`网络：${result.notes.join("；")}`);
        else if (result.proxy) log(`网络：经代理 ${result.proxy}`);
      })
      .catch((err: unknown) => {
        log(`网络引导失败：${err instanceof Error ? err.message : String(err)}`);
      });
    return btcNetworkReady;
  };

  /**
   * 兼容用的「进程级角色」。
   *
   * 角色判定的**正确来源**是任务上下文（`src/btc/role.ts` 的 `currentBtcRole()`）：
   * 不同对端可能同时跑实盘与模拟盘，进程环境变量只能有一个值。这里只是给
   * feed 标签、子进程继承之类的兜底用，不参与账本/工具的角色判断。
   */
  const applyRoleEnv = (mode: GatewayModeState | null): void => {
    process.env.XZH_BTC_ROLE =
      mode?.name === "btc" ? (mode.paper ? "paper" : "live") : "live";
  };

  /** 当前模式（按微信对端持久化；重启后恢复最后一次对话的模式） */
  const peerModes = readPeerModes(home);
  const bootPeer = peerModes.lastPeer;
  const bootMode =
    (bootPeer ? peerModes.modes[bootPeer] : undefined) ?? readGatewayMode(home);

  const sessions = new Map<string, GatewaySession>();
  const initialSession: GatewaySession = {
    key: bootPeer ?? HTTP_SESSION_KEY,
    agent: null,
    mode: bootMode,
    replyBuffer: "",
    deniedNote: "",
    lastToolNote: "",
  };
  sessions.set(initialSession.key, initialSession);

  /**
   * 任务上下文：每条消息一个，跨 `await` 传播。
   *
   * 以前这里是 5 个进程级变量 + `activateSession()` / `saveSession()` 来回搬运；
   * 那种做法只在「同一时刻只处理一条消息」时成立。现在不同对端可以并发，
   * 状态必须跟着任务走 —— 否则 A 的流式回复会混进 B 的缓冲区、B 切模式会改掉
   * A 正在用的 cwd 与工具集。
   *
   * `rt()` 在任务内取 AsyncLocalStorage 里的会话；任务外（`/health`、状态展示）
   * 退回 `activeSession`（最近一次激活的会话），只用于只读展示。
   */
  const taskStore = new AsyncLocalStorage<GatewaySession>();
  let activeSession: GatewaySession = initialSession;
  const rt = (): GatewaySession => taskStore.getStore() ?? activeSession;
  applyRoleEnv(bootMode);

  const sessionFor = (peer?: string): GatewaySession => {
    const key = peer?.trim() || HTTP_SESSION_KEY;
    const existing = sessions.get(key);
    if (existing) return existing;
    // 新对端：优先用它上次的模式；没有记录才继承 gateway 最近一次的模式
    const saved = peer ? readPeerModes(home).modes[peer] : undefined;
    const session: GatewaySession = {
      key,
      agent: null,
      mode: saved ?? readGatewayMode(home),
      replyBuffer: "",
      deniedNote: "",
      lastToolNote: "",
    };
    sessions.set(key, session);
    return session;
  };

  // 不再需要 activateSession / saveSession：会话对象本身就是状态载体，
  // 任务内通过 `rt()` 拿到自己那一份，互不覆盖。

  /**
   * 切换模式：先清旧模式再切目录（否则 cwdLocked 会拒绝），然后重新注入提示词/工具。
   * 不启动 btc 常驻后端 —— 与 TUI 的 `/btc` 语义一致，避免切个模式就触发自主巡检。
   *
   * 只改**当前任务所属会话**的 Agent 与模式；其他对端的历史与模式完全不受影响
   * （状态都挂在各自的 GatewaySession 上，没有可被覆盖的进程级变量）。
   */
  const applyGatewayMode = (next: GatewayModeState | null, peer?: string): string => {
    const spec = modeSpec(next);
    const session = rt();
    applyRoleEnv(next);

    const sessionAgent = session.agent;
    if (sessionAgent) {
      // setMode 检测到模式真的变了会清空该会话历史（见 core/agent.ts）
      sessionAgent.setMode(undefined);
      if (path.resolve(sessionAgent.getCwd()) !== path.resolve(spec.cwd)) {
        sessionAgent.setCwd(spec.cwd);
      }
      if (spec.mode) sessionAgent.setMode(spec.mode);
    }
    try {
      spec.mode?.bootstrap?.(spec.cwd);
    } catch {
      // 资产释放失败不阻断；工具会自行报环境未就绪
    }

    session.mode = next;
    writeGatewayMode(next, home);
    if (peer) writePeerMode(peer, next, home);
    state.cwd = spec.cwd;
    writeGatewayState(state, home);
    log(`模式切换：${spec.label}（cwd=${spec.cwd}，会话=${rt().key}）`);
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
      "微信内说明：命令集与终端一致；/btc、/btc moni、/a、/xzh 会切换模式并自动拉起对应后台。",
      "界面专属命令（/clear、/copy、/image、/mouse、/term、/device、/feed、/focus、/resume、/init、/undo、/exit）会说明原因，其余均可用。",
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

  /** 终端界面专属命令：微信里直接说明原因，而不是当成「未知命令」 */
  const TUI_ONLY: Record<string, string> = {
    clear: "/clear 用于清屏，微信没有界面；要清对话上下文请用 /reset。",
    copy: "/copy 仅终端可用（复制到系统剪贴板）。",
    image: "微信侧目前只支持文本；图片附件请在终端用 /image。",
    mouse: "/mouse 仅终端可用（切换鼠标捕获）。",
    term: "/term 仅终端可用（右侧终端面板）。",
    device: "/device 手机桥仅终端可用，命令行请用 xzh device ...。",
    feed: "/feed 过程流仅终端可用；微信已自动推送巡检结论与动作（也可用 /info）。",
    focus: "/focus 工作集仅终端可用（终端里维护文件工作集）。",
    resume: "/resume 会话切换仅终端可用；微信频道固定使用 gateway 自己的会话。",
    init: "/init 需要交互确认，请在终端运行 xzh init。",
    undo: "/undo 需要逐项确认，请在终端使用 /undo。",
    exit: "gateway 是常驻服务，不能从对话退出；停止请用 xzh gateway stop。",
  };

  /** 与终端同一套 /help 列表的命令路由（微信侧） */
  const runRawCommand = async (name: string, arg: string): Promise<string> => {
    if (TUI_ONLY[name]) return TUI_ONLY[name];

    switch (name) {
      case "cwd": {
        const runner = ensureAgent();
        const mode = rt().mode;
        return `工作目录：${runner.getCwd()}\n模式：${mode ? modeSpec(mode).label : "xzh 普通模式"}`;
      }
      case "switch": {
        if (!arg) return "用法：/switch <目录>";
        const current = rt().mode;
        if (current) return `当前为 ${modeSpec(current).label}，目录已锁定，不能 /switch；先 /xzh 退出模式。`;
        const runner = ensureAgent();
        try {
          runner.setCwd(path.resolve(expandHome(arg)));
        } catch (err) {
          return `切换失败：${err instanceof Error ? err.message : String(err)}`;
        }
        state.cwd = runner.getCwd();
        writeGatewayState(state, home);
        return `✓ 已切换工作目录：${state.cwd}`;
      }
      case "reset": {
        if (arg.trim().toLowerCase().startsWith("moni")) {
          // 只在 BTC 模拟盘会话里允许：其他模式下重置会「顺手清掉另一个模式的账本」
          const allowed = canResetPaperLedger(rt().mode);
          if (!allowed.ok) return allowed.reason;
          const capitalText = arg.trim().split(/\s+/)[1];
          const capital = capitalText === undefined ? undefined : Number(capitalText);
          if (capital !== undefined && (!Number.isFinite(capital) || capital <= 0)) {
            return "用法：/reset moni [初始资金]";
          }
          const result = await resetPaperLedger({
            home: getBtcHome(),
            capital,
            source: "command",
          });
          return result.ok
            ? `✓ 模拟盘已重置，初始资金 ${result.data.capital.toLocaleString("en-US")}`
            : `✗ 重置失败：${result.error}`;
        }
        // 重置必须同时换一个会话文件：否则旧历史还在文件里，重启后又会被恢复回来
        const runner = ensureAgent();
        runner.reset();
        const nextSession = ensureSessionFile(
          sessionFileFor(rt().key, rt().mode),
          runner.getCwd(),
        );
        runner.restoreSession([], nextSession);
        return "✓ 已重置对话上下文";
      }
      case "digest": {
        // 「能拉的不推」：窗口关闭期间被降级的巡检结论，在这里按需取。
        // 取完即清空，否则回复尾部的「另有 N 轮摘要」会一直挂着。
        const text = formatDigest(home, Math.min(10, Math.max(1, Number(arg) || 3)));
        if (!text.startsWith("没有未推送")) clearDigest(home);
        return text;
      }
      case "compact": {
        const result = await ensureAgent().compactHistory();
        return result.compacted
          ? `✓ 已压缩上下文：${result.before} 条 → ${result.after} 条`
          : `未压缩：${result.reason ?? "历史较短"}`;
      }
      case "tr": {
        const mode = rt().mode;
        if (!mode) {
          return "当前是普通模式；发送 /btc、/btc moni 或 /a 切换模式后，/tr 才有交易记录可看。";
        }
        const limit = Number(arg) || 20;
        const lines =
          mode.name === "btc"
            ? await btcTradeHistoryLines(
                getBtcHome(),
                mode.paper ? "paper" : "live",
                limit,
              )
            : aTradeLines(limit);
        return lines.join("\n");
      }
      case "tools": {
        const modeName = rt().mode?.name;
        const visible = TOOLS.filter((tool) => toolVisibleInMode(tool, modeName));
        return `当前可用工具 ${visible.length} 个：\n` + visible.map((tool) => `- ${tool.name}`).join("\n");
      }
      case "context": {
        const runner = ensureAgent();
        const chars = runner.messages.reduce((sum, message) => sum + message.content.length, 0);
        return `历史 ${runner.messages.length} 条 · 约 ${chars} 字\n工具 ${TOOLS.length} 个（当前模式可见 ${
          TOOLS.filter((tool) => toolVisibleInMode(tool, rt().mode?.name)).length
        } 个）\n（gateway 侧不做像素级预算统计，终端 /context 更完整）`;
      }
      case "usage":
        return "微信频道不统计 token 用量；终端的 /usage 会显示本轮与累计真实用量。";
      case "autonomy": {
        const runner = ensureAgent();
        const next = arg.trim().toLowerCase();
        if (!next) return `当前自治等级：${runner.getAutonomyMode()}（ask / observe / auto）`;
        if (next !== "ask" && next !== "observe" && next !== "auto") {
          return "用法：/autonomy [ask|observe|auto]";
        }
        runner.setAutonomyMode(next);
        return `✓ 自治等级已切换为 ${next}`;
      }
      case "auto": {
        const next = arg.trim().toLowerCase();
        if (next !== "on" && next !== "off") return "用法：/auto [on|off]";
        const config = loadConfig();
        config.autoApprove = next === "on";
        saveConfig(config);
        return `✓ 自动批准已${next === "on" ? "开启" : "关闭"}（写入配置，新会话生效）`;
      }
      case "jobs": {
        const runner = ensureAgent();
        const parts = arg.trim().split(/\s+/).filter(Boolean);
        if (parts[0] === "kill" && parts[1]) {
          const result = runner.killBackgroundJob(parts[1]);
          return result.ok ? `✓ ${result.message}` : `✗ ${result.message}`;
        }
        const jobs = runner.getBackgroundJobs();
        if (jobs.length === 0) return "没有后台任务";
        return jobs
          .map((job) => `${job.id} [${job.status}] ${job.command}${job.code !== null ? `（退出码 ${job.code}）` : ""}`)
          .join("\n");
      }
      case "goal": {
        const runner = ensureAgent();
        const value = arg.trim();
        if (!value || value === "status") {
          const goal = runner.getGoal();
          return goal ? `当前目标：${goal.text}` : "当前没有目标（/goal <目标> 设定）";
        }
        if (value === "off") {
          runner.clearGoal();
          return "✓ 已清除目标";
        }
        const goal = runner.setGoal(value);
        return `✓ 已设定目标：${goal.text}\n发送 /goal continue 继续推进`;
      }
      case "stop":
      case "start":
      case "restart": {
        const mode = rt().mode;
        if (!mode) return `/${name} 仅在 btc / btc moni / a 模式下可用。`;
        const isBtc = mode.name === "btc";
        const role = mode.paper ? "paper" : "live";
        const label = isBtc ? (role === "paper" ? "btc 模拟盘" : "btc 实盘") : "A 股后台服务";
        const messages: string[] = [];

        if (name !== "start") {
          if (isBtc) {
            const result = await stopBtcBackend(role);
            messages.push(
              result.stopped
                ? `✓ 已停止 ${label} 后端`
                : result.error
                  ? `✗ 停止失败：${result.error}`
                  : `${label} 后端本来没在运行`,
            );
          } else {
            const result = await stopAService();
            messages.push(
              result.ok
                ? result.stopped
                  ? "✓ 已停止 A 股后台服务"
                  : "A 股后台服务本来没在运行"
                : `✗ 停止失败：${result.error}`,
            );
          }
        }
        if (name !== "stop") {
          if (isBtc) {
            const result = await ensureBtcBackend({ role });
            messages.push(
              result.running
                ? result.started
                  ? `✓ 已启动 ${label} 后端`
                  : `${label} 后端已在运行`
                : `✗ 启动失败：${result.error ?? "未知原因"}`,
            );
          } else {
            const result = await startAService();
            messages.push(
              result.ok
                ? result.started
                  ? "✓ 已启动 A 股后台服务"
                  : "A 股后台服务已在运行"
                : `✗ 启动失败：${result.error ?? "未知原因"}`,
            );
          }
        }
        return messages.join("\n");
      }
      case "pause": {
        const resume = arg.trim().toLowerCase() === "resume";
        if (rt().mode?.name === "a") {
          if (arg.trim().toLowerCase() === "status") {
            const pause = readAPause();
            return pause.paused
              ? `A 股巡检已暂停（${pause.at ?? "?"}，/pause resume 恢复）`
              : "A 股巡检运行中（/pause 可暂停，进程仍在）";
          }
          setAPaused(!resume, "/pause");
          return resume ? "✓ 已恢复 A 股巡检与交易" : "✓ 已暂停 A 股巡检与交易（/pause resume 恢复）";
        }
        if (rt().mode?.name !== "btc") return "/pause 仅在 btc / btc moni / a 模式下有效";
        setPaused(getBtcHome(), !resume, "/pause");
        return resume ? "✓ 已恢复 btc 后端巡检" : "✓ 已暂停 btc 后端巡检（/pause resume 恢复）";
      }
      case "watch":
      case "watchlist": {
        if (rt().mode?.name !== "a") return "/watch 仅在 a 模式下显示自选股；btc 叫醒条件请用 /wakeup。";
        const data = await collectASharePanelData();
        const lines = [`A 股自选池 ${data.watch.length}/${poolSize()}（★=持仓）`];
        if (data.watch.length === 0) lines.push("为空；收盘后 16:00 自动选股。");
        for (const row of data.watch) {
          lines.push(
            `${row.held ? "★ " : "  "}- ${row.code} ${row.name} ${row.score} 分` +
              (row.price > 0 ? ` ${row.price.toFixed(2)}（${row.pct >= 0 ? "+" : ""}${row.pct.toFixed(2)}%）` : ""),
          );
        }
        lines.push("", "监控规则请用 /wakeup；完整详情用 /info。");
        return lines.join("\n");
      }
      case "wakeup":
      case "monitor": { // 旧名保留为别名
        const mode = rt().mode;
        if (mode?.name === "btc") {
          const triggers = readTriggers(
            getBtcHome(),
            mode.paper ? "paper" : "live",
          );
          if (triggers.length === 0) return "当前没有叫醒条件（btc_trigger 可添加）";
          return `叫醒条件 ${triggers.length} 条：\n` + triggers.map((trigger) => `- ${describeTrigger(trigger)}`).join("\n");
        }
        if (rt().mode?.name === "a") {
          const rules = readRules();
          const queue = readScheduleQueue();
          const lines: string[] = [`A 股监控规则 ${rules.length} 条（命中只唤醒巡检）`];
          if (queue[0]) {
            lines.push(`下一轮巡检：${formatLocalTime(queue[0].at, "monthday")} ${queue[0].reason}`);
          }
          if (rules.length === 0) {
            lines.push("暂无规则；可用 a_trigger 添加价格 / 涨跌幅 / MA20 / 链式 / formula 条件。");
          }
          for (const rule of rules) {
            lines.push(`- ${describeRule(rule)}${rule.note ? ` — ${rule.note}` : ""}`);
          }
          const audits = readRuleAudits(3);
          if (audits.length > 0) {
            lines.push("", "最近规则审计：");
            for (const audit of audits) {
              lines.push(
                `- ${formatLocalTime(audit.ts, "monthday")} ${audit.actor} ${audit.action} ` +
                  `${audit.code ?? ""} ${audit.kind ?? ""} ${audit.ok ? "通过" : `拒绝：${audit.error ?? ""}`}`,
              );
            }
          }
          lines.push("", "自选股列表请用 /watch（或 /watchlist）。");
          return lines.join("\n");
        }
        return "/wakeup 仅在 btc / a 模式下有效";
      }
      case "model": {
        const config = loadConfig();
        const runner = ensureAgent();
        const models = config.models ?? [];
        if (!arg.trim()) {
          if (models.length === 0) return `当前模型：${runner.getActiveModel()?.id ?? "未配置"}`;
          return (
            "可用模型：\n" +
            models
              .map((entry, index) => `${index + 1}. ${entry.id}${runner.getActiveModel()?.id === entry.id ? "（当前）" : ""}`)
              .join("\n") +
            "\n切换：/model <序号|id>"
          );
        }
        const key = arg.trim();
        const entry =
          models.find((item) => item.id === key) ??
          models[Number(key) - 1] ??
          models.find((item) => `${item.provider}/${item.model}` === key);
        if (!entry) return `没有找到模型：${key}`;
        try {
          const changed = runner.switchModel(entry);
          return changed ? `✓ 已切换到 ${entry.id}` : `当前已是 ${entry.id}`;
        } catch (err) {
          return `✗ 切换失败：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      case "memory": {
        const runner = ensureAgent();
        const global = arg.trim().toLowerCase() === "global";
        const file = global
          ? path.join(getDataSubdir(), "memory", "MEMORY.md")
          : path.join(runner.getCwd(), ".xuanzhu", "MEMORY.md");
        try {
          const text = fs.readFileSync(file, "utf8").trim();
          if (!text) return `${file}\n（空）`;
          const lines = text.split("\n").slice(0, 25);
          return `${file}\n${lines.join("\n")}${text.split("\n").length > 25 ? "\n…" : ""}`;
        } catch {
          return `没有找到${global ? "全局" : "项目"}记忆：${file}`;
        }
      }
      case "prompt": {
        const config = loadConfig();
        const keys = Object.keys(config.promptOverrides ?? {});
        if (keys.length === 0) return "没有提示词分段覆盖";
        return `已覆盖的提示词段落：${keys.join("、")}\n（查看详情请在终端使用 /prompt list）`;
      }
      case "intent": {
        const next = arg.trim().toLowerCase();
        if (next !== "on" && next !== "off") return "用法：/intent [on|off]";
        const config = loadConfig();
        config.intent.enabled = next === "on";
        saveConfig(config);
        return `✓ 意图分析已${next === "on" ? "开启" : "关闭"}（写入配置，新会话生效）`;
      }
      default:
        return `未知命令 /${name}；发送 /help 查看全部命令。`;
    }
  };

  /** 返回 null 表示「不是命令」，应交给模型 */
  const handleCommand = async (text: string, peer?: string): Promise<string | null> => {
    const command = parseGatewayCommand(text);
    if (!command) return null;
    if (command.kind === "help") return commandHelp();
    if (command.kind === "usage") return command.message;

    if (command.kind === "raw") {
      return runRawCommand(command.name, command.arg);
    }

    if (command.kind === "info") {
      const mode = rt().mode;
      if (!mode) {
        return "当前是普通模式；发送 /btc、/btc moni 或 /a 切换模式后，/info 才有右侧面板详情可看。";
      }
      if (mode.name === "btc") {
        const data = await collectBtcPanelData(
          getBtcHome(),
          mode.paper ? "paper" : "live",
        );
        return btcInfoLines(data).join("\n").replace(/^\n+/, "");
      }
      const data = await collectASharePanelData();
      return aInfoLines(data).join("\n").replace(/^\n+/, "");
    }

    if (command.kind === "xzh") {
      const mode = rt().mode;
      if (!mode) return `当前已是 xzh 普通模式（${home}）。`;
      const previous = modeSpec(mode).label;
      applyGatewayMode(null, peer);
      return `✓ 已退出 ${previous}，回到 ${home}。`;
    }

    if (command.kind === "btc") {
      await ensureBtcNetworkOnce();
      const mode = rt().mode;
      if (mode?.name === "btc" && (mode.paper === true) === command.paper) {
        const serviceMessage = await ensureBackend(createBtcMode({ paper: command.paper }));
        return `已在 ${modeSpec(mode).label}。${serviceMessage ? `\n${serviceMessage}` : ""}`;
      }
      const label = applyGatewayMode({ name: "btc", paper: command.paper }, peer);
      const serviceMessage = await ensureBackend(createBtcMode({ paper: command.paper }));
      return `✓ 已切换到 ${label}（工作目录 ${getBtcHome()}）。${serviceMessage ? `\n${serviceMessage}` : ""}`;
    }

    if (rt().mode?.name === "a") {
      const serviceMessage = await ensureBackend(createAShareMode());
      return `已在 A 股分析模式。${serviceMessage ? `\n${serviceMessage}` : ""}`;
    }
    const label = applyGatewayMode({ name: "a" }, peer);
    const serviceMessage = await ensureBackend(createAShareMode());
    return `✓ 已切换到 ${label}（工作目录 ${getAShareHome()}）。${serviceMessage ? `\n${serviceMessage}` : ""}`;
  };

  const ensureAgent = (): Agent => {
    const session = rt();
    if (session.agent) return session.agent;
    const config = loadConfig();
    const active = activeModelEntry(config);
    if (!active) {
      throw new Error("尚未配置任何模型（先运行 xzh model add）");
    }
    const provider = createProvider(config, active);
    modelLabel = `${active.provider}/${active.model}`;

    /**
     * 事件回调**闭包捕获本会话**，而不是调用 `rt()`。
     *
     * `rt()` 在任务上下文里能拿到正确会话，但保险起见这里直接绑定：即使某个回调
     * 在任务结束后（后台任务完成、异步通知）才触发，也只会写回自己这一份，
     * 不会串到别的对端。
     */
    const events: AgentEvents = {
      onText: (delta) => {
        session.replyBuffer += delta;
      },
      onReasoning: () => undefined,
      onToolStart: (call) => log(`工具 ${call.name}`),
      onToolEnd: (call, result) => {
        const brief = (result.content ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
        if (brief) session.lastToolNote = `${call.name} → ${brief}`;
      },
      onStatus: () => undefined,
      onNotice: (message) => log(`提示 ${message}`),
      // gateway 目前没有交互式确认通道；未来接微信时可以把这里换成「发消息问用户」
      confirm: async (request) => {
        session.deniedNote = `需要确认的操作（${request.tool}）已拒绝：gateway 当前没有交互式确认通道`;
        log(session.deniedNote);
        return false;
      },
      onRoundLimit: async () => false,
    };

    const spec = modeSpec(session.mode);
    try {
      spec.mode?.bootstrap?.(spec.cwd);
    } catch {
      // 资产释放失败不阻断；工具会自行报环境未就绪
    }
    // 会话持久化：重启后把该对端（当前模式）的历史接回来，而不是从空白开始
    const sessionFile = ensureSessionFile(
      sessionFileFor(session.key, session.mode),
      spec.cwd,
    );
    const created = new Agent(provider, config, spec.cwd, events, active, {
      mode: spec.mode,
      autoMemory: true,
      taskLedger: false,
      backgroundJobs: false,
      maxToolRounds: 60,
      sessionFile,
    });
    session.agent = created;
    try {
      const restored = loadSessionMessages(sessionFile);
      if (restored.length > 0) {
        created.restoreSession(restored, sessionFile);
        log(`会话已恢复（${session.key.slice(-6)} / ${restored.length} 条）`);
      }
    } catch (err) {
      log(`会话恢复失败：${err instanceof Error ? err.message : String(err)}`);
    }
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
    return created;
  };

  /**
   * 单条消息的墙钟上限。
   *
   * 以前固定 5 分钟：本地模型 + `btc_sync` 这类慢工具很容易跑过，超时后 `run` 回滚、
   * 一个字都没留下，gateway 便输出「本轮没有文本输出，但工具已执行」——
   * 用户看到的是「只查了个价就没了」（2026-11-13 实测）。默认放宽到 15 分钟，
   * 并让超时明确说自己超时（可设 `XZH_GATEWAY_MESSAGE_TIMEOUT_MS` 覆盖）。
   */
  const MESSAGE_TIMEOUT_MS = (() => {
    const raw = Number(process.env.XZH_GATEWAY_MESSAGE_TIMEOUT_MS);
    return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 15 * 60_000;
  })();
  const timeoutMinutes = Math.max(1, Math.round(MESSAGE_TIMEOUT_MS / 60_000));

  /**
   * 命令执行的硬上限。
   *
   * `/info` 要拉行情、读后台状态；接口无响应时（或模式刚切完、缓存正在重建）可能拖很久。
   * 以前这条链没有上限也没有兜底：命令一卡，微信端就是**彻底没有回复**，
   * 连「处理失败」都看不到。现在超时与异常都转成一条可读回复。
   */
  const COMMAND_TIMEOUT_MS = 25_000;
  const runCommandGuarded = async (text: string, peer?: string): Promise<string | null> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), COMMAND_TIMEOUT_MS);
        timer.unref?.();
      });
      const raced = await Promise.race([
        handleCommand(text, peer).then((reply) => ({ reply })),
        timeout,
      ]);
      if ("timedOut" in raced) {
        log(`命令超时：${text.slice(0, 40)}`);
        return (
          `⏱ 这条命令超过 ${Math.round(COMMAND_TIMEOUT_MS / 1000)} 秒还没完成` +
          `（多半是行情/后台接口无响应），请稍后重试。`
        );
      }
      return raced.reply;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`命令失败：${text.slice(0, 40)} → ${message}`);
      return `命令执行失败：${message}`;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /**
   * 「能拉的不推」的出口：窗口关闭期间巡检结论进了摘要箱，用户下次说话时
   * 在回复尾部给一句提示 —— 不占推送额度，也不打断对话。
   *
   * `/digest` 自身不加（它就是把摘要取出来）；HTTP `/message` 没有对端概念，也不加。
   */
  const withDigestHint = (reply: string, request: string, target?: string): string => {
    if (!target) return reply;
    if (/^[／/]\s*digest\b/i.test(request.trim())) return reply;
    const hint = digestHint(home);
    return hint ? `${reply}\n\n${hint}` : reply;
  };

  /**
   * 消息处理：**按对端串行、不同对端并发**。
   *
   * - 同一对端的第二条消息必须等第一条跑完：Agent 历史是线性的，交错会互相污染；
   * - 不同对端没有共享状态（Agent / 模式 / 缓冲都在各自的 GatewaySession 上），
   *   所以可以同时跑 —— 一条 15 分钟的 BTC 巡检不该把另一个人的 `/info` 堵住。
   *
   * 两个任务级上下文：
   * - `taskStore`：这条消息属于哪个会话（命令与事件回调都用 `rt()` 取）；
   * - `withBtcRole`：这条消息是实盘还是模拟盘。btc 工具读任务上下文而不是进程环境变量，
   *   否则两个角色并发时账本会串（这是并发的硬前提）。
   */
  const queues = createPeerQueues();
  const handleMessage = (text: string, peer?: string): Promise<string> => {
    const session = sessionFor(peer);
    return queues.run(session.key, () =>
      taskStore.run(session, async () => {
        activeSession = session; // 仅用于 /health、状态展示等任务外只读场景
        const role: BtcRole =
          session.mode?.name === "btc" ? (session.mode.paper ? "paper" : "live") : "live";
        // env 只是兼容兜底（feed 标签等）；正确性由任务上下文保证。
        // 非 btc 会话不要写它 —— 否则会在别人跑 btc 巡检时把角色改成 live。
        if (session.mode?.name === "btc") applyRoleEnv(session.mode);
        return withBtcRole(role, () => runMessage(text, peer, session));
      }),
    );
  };

  /** 单条消息的实际处理（在会话 + 角色上下文里执行） */
  const runMessage = async (
    text: string,
    peer: string | undefined,
    session: GatewaySession,
  ): Promise<string> => {
    // 每轮都从空白开始：上一轮的兜底文案（尤其 lastToolNote）不能串到这一轮
    rt().replyBuffer = "";
    rt().deniedNote = "";
    rt().lastToolNote = "";

    // btc 模式：先确保网络引导跑完（首次会探直连 / 找本机代理，之后立即返回）
    if (session.mode?.name === "btc") await ensureBtcNetworkOnce();

    // 微信：恢复该对端上次使用的模式；没有记录时沿用当前模式并记住
    if (peer) {
      const saved = readPeerModes(home).modes[peer];
      if (saved && !sameGatewayMode(saved, session.mode)) applyGatewayMode(saved, peer);
      else writePeerMode(peer, session.mode, home);
    }

    // `/btc` / `/a` / `/xzh` 这类命令不进入对话历史，也不调用模型
    const commandReply = await runCommandGuarded(text, peer);
    if (commandReply !== null) {
      log(`命令回复 ${text.slice(0, 40)}：${commandReply.length} 字`);
      return withDigestHint(commandReply, text, peer);
    }

    const runner = ensureAgent();
    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MESSAGE_TIMEOUT_MS);
    try {
      await runner.run(text, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      const partial = rt().replyBuffer.trim();
      const done = rt().lastToolNote ? `已完成的最后一步：${rt().lastToolNote}` : "";
      return partial
        ? `${partial}\n\n[⏱ 本轮超过 ${timeoutMinutes} 分钟，已中断${done ? `；${done}` : ""}]`
        : `⏱ 本轮超过 ${timeoutMinutes} 分钟，已中断。${done ? `${done}。` : ""}` +
            `可以让我只做其中一步（例如「只查价格」「只跑一次巡检」），或把任务拆小。`;
    }
    const reply =
      rt().replyBuffer.trim() ||
      (rt().lastToolNote
        ? `（本轮没有文本输出，但工具已执行：${rt().lastToolNote}）`
        : "（本轮没有文本输出；可能是模型超时或工具轮数用尽，请重试一次）");
    return withDigestHint(
      rt().deniedNote ? `${reply}\n\n[${rt().deniedNote}]` : reply,
      text,
      peer,
    );
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
          mode: rt().mode?.name ?? "xzh",
          cwd: modeSpec(rt().mode).cwd,
          lastError: lastError ?? null,
          pushBlocked: state.pushBlocked ?? null,
        });
        return;
      }

      if (req.method === "POST" && url === "/message") {
        if (!authorizeRequest(req, httpToken)) {
          json(res, 401, {
            ok: false,
            error: "缺少或错误的令牌：请带 Authorization: Bearer <run/http-token>",
          });
          return;
        }
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
        // 能关服务就等于能让用户失联，同样要令牌
        if (!authorizeRequest(req, httpToken)) {
          json(res, 401, { ok: false, error: "缺少或错误的令牌" });
          return;
        }
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
  let feed: FeedForwarder | null = null;
  let outbox: Outbox | null = null;

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
      // 出站队列先建：send 通过闭包调用 channel（channel 要在拿到 outbox 之后才能注入 deliver）
      outbox = startOutbox({
        gatewayHome: home,
        capabilities: WEIXIN_CAPABILITIES,
        log,
        // 巡检推送不带 peer：入队时就落到「最近对话的对端」，否则窗口判定会错位
        defaultPeer: () => weixin?.lastPeer,
        send: async (peer, text) =>
          weixin ? await weixin.sendTo(peer, text) : { ok: false, error: "微信频道未启动" },
        // 窗口关闭时巡检结论不进队列硬撞，转进摘要箱（`/digest` 拉取）
        onDigest: ({ kind, text }) => {
          appendDigest(home, { source: kind === "notice" ? "通知" : "巡检", text });
        },
        // 推送通道被服务端拒收 / 恢复时写进状态文件：`xzh gateway status` 直接可见
        onBlocked: (reason) => {
          if (reason) state.pushBlocked = reason;
          else delete state.pushBlocked;
          try {
            writeGatewayState(state, home);
          } catch {
            // 状态写失败不影响推送本身
          }
        },
      });
      weixin = startWeixinChannel({
        home,
        account,
        log,
        allowedUsers: allowed,
        // 与 HTTP /message 共用同一条串行队列：同一个 Agent 实例不能并发
        onMessage: (text, peer) => handleMessage(text, peer),
        // 回复也走同一个出口：与巡检推送共享排序、窗口与退避策略
        deliver: (peer, text) => outbox!.enqueueReply(peer, text),
        // 入站消息 = 会话窗口刷新：放开该对端的退避并补发积压
        onInbound: (peer) => outbox!.markInbound(peer),
      });
      log(`微信频道已启动 account=${account.accountId}`);
      // 巡检内容转发：btc 后端结论 / 错误、A 股选股 / 买卖
      feed = startFeedForwarder({
        gatewayHome: home,
        log,
        send: async (text, kind) => {
          outbox!.enqueue({ text, kind: kind ?? "inspect" });
          return true;
        },
      });

      // 历史兜底摘要自动补发：旧逻辑会把「窗口关闭」的巡检结论塞进 digest 箱，
      // 用户抱怨「老是要 /digest 查看」。现在启动时把它们并成几条转入出站队列，
      // 按正常推送节奏（用户开口即补发）送达，然后清空摘要箱。
      const pendingDigest = readDigest(home);
      if (pendingDigest.length > 0) {
        const batches = batchDigestEntries(pendingDigest);
        batches.forEach((body, index) => {
          outbox!.enqueue({
            text: `[补发·未推送巡检 ${index + 1}/${batches.length}]\n${body}`,
            kind: "inspect",
          });
        });
        clearDigest(home);
        log(
          `已把 ${pendingDigest.length} 条兜底摘要转入出站队列（${batches.length} 条消息，自动补发）`,
        );
      }
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
    feed?.stop();
    outbox?.stop();
    weixin?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup();
    process.exit(code);
  };

  /**
   * 兜底异常：**先落盘再退出**。
   *
   * 出站队列与会话都是增量落盘的，退出不会丢已确认的内容；而带着未知状态继续跑
   * 可能把同一轮巡检推两遍、或让会话状态错乱。systemd（`Restart=always`）会拉起，
   * 手工启动时用户能看到日志。
   */
  process.on("unhandledRejection", (reason) => {
    log(`未处理的 Promise 拒绝：${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    log(`未捕获异常：${err.stack ?? err.message}`);
    void shutdown(1);
  });

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

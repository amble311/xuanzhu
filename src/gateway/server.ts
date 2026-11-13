import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import { resetPaperLedger } from "../btc/paper-reset";
import { expandHome, getDataSubdir } from "../utils/paths";
import { readRules, describeRule } from "../a/rules";
import { readRuleAudits } from "../a/rule-audit";
import { readScheduleQueue } from "../a/schedule";
import { loadWatchlist } from "../a/watchlist";
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
   * 队列仍是串行的，同一时刻只有一个会话被「激活」（见 activateSession）。
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

  /** btc 工具靠进程环境变量区分实盘 / 模拟盘，必须按「当前会话」而不是切换时设置 */
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
   * 当前正在处理的会话（队列串行，所以同一时刻只有一个）。
   *
   * 下面的 `agent` / `modeState` / `replyBuffer` 都是**这个会话的视图**：
   * 处理消息前 activateSession()，处理完 saveSession() 写回，命令与工具代码不需要
   * 到处传对端参数，也就不会漏掉某条路径。
   */
  let currentSession: GatewaySession = initialSession;
  let agent: Agent | null = null;
  let modeState: GatewayModeState | null = bootMode;
  /** 当前这轮回复的累积文本（Agent.run 的产出通过事件回调给） */
  let replyBuffer = "";
  /** 需要确认的工具：无人在场时拒绝，并把原因带回给调用方 */
  let deniedNote = "";
  let lastToolNote = "";
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

  /** 激活某个对端的会话（只切视图，不创建 Agent） */
  const activateSession = (session: GatewaySession): void => {
    currentSession = session;
    agent = session.agent;
    modeState = session.mode;
    replyBuffer = session.replyBuffer;
    deniedNote = session.deniedNote;
    lastToolNote = session.lastToolNote;
    applyRoleEnv(session.mode);
  };

  const saveSession = (): void => {
    currentSession.agent = agent;
    currentSession.mode = modeState;
    currentSession.replyBuffer = replyBuffer;
    currentSession.deniedNote = deniedNote;
    currentSession.lastToolNote = lastToolNote;
  };

  /**
   * 切换模式：先清旧模式再切目录（否则 cwdLocked 会拒绝），然后重新注入提示词/工具。
   * 不启动 btc 常驻后端 —— 与 TUI 的 `/btc` 语义一致，避免切个模式就触发自主巡检。
   *
   * 必须在 activateSession() 之后调用：它只改**当前会话**的 Agent 与模式，
   * 其他对端的历史与模式不受影响（这就是那道「墙」）。
   */
  const applyGatewayMode = (next: GatewayModeState | null, peer?: string): string => {
    const spec = modeSpec(next);
    applyRoleEnv(next);

    if (agent) {
      // setMode 检测到模式真的变了会清空该会话历史（见 core/agent.ts）
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
    currentSession.mode = next;
    currentSession.agent = agent;
    writeGatewayMode(next, home);
    if (peer) writePeerMode(peer, next, home);
    state.cwd = spec.cwd;
    writeGatewayState(state, home);
    log(`模式切换：${spec.label}（cwd=${spec.cwd}，会话=${currentSession.key}）`);
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
        return `工作目录：${runner.getCwd()}\n模式：${modeState ? modeSpec(modeState).label : "xzh 普通模式"}`;
      }
      case "switch": {
        if (!arg) return "用法：/switch <目录>";
        if (modeState) return `当前为 ${modeSpec(modeState).label}，目录已锁定，不能 /switch；先 /xzh 退出模式。`;
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
        ensureAgent().reset();
        return "✓ 已重置对话上下文";
      }
      case "compact": {
        const result = await ensureAgent().compactHistory();
        return result.compacted
          ? `✓ 已压缩上下文：${result.before} 条 → ${result.after} 条`
          : `未压缩：${result.reason ?? "历史较短"}`;
      }
      case "tr": {
        if (!modeState) {
          return "当前是普通模式；发送 /btc、/btc moni 或 /a 切换模式后，/tr 才有交易记录可看。";
        }
        const limit = Number(arg) || 20;
        const lines =
          modeState.name === "btc"
            ? await btcTradeHistoryLines(
                getBtcHome(),
                modeState.paper ? "paper" : "live",
                limit,
              )
            : aTradeLines(limit);
        return lines.join("\n");
      }
      case "tools": {
        const modeName = modeState?.name;
        const visible = TOOLS.filter((tool) => toolVisibleInMode(tool, modeName));
        return `当前可用工具 ${visible.length} 个：\n` + visible.map((tool) => `- ${tool.name}`).join("\n");
      }
      case "context": {
        const runner = ensureAgent();
        const chars = runner.messages.reduce((sum, message) => sum + message.content.length, 0);
        return `历史 ${runner.messages.length} 条 · 约 ${chars} 字\n工具 ${TOOLS.length} 个（当前模式可见 ${
          TOOLS.filter((tool) => toolVisibleInMode(tool, modeState?.name)).length
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
        if (!modeState) return `/${name} 仅在 btc / btc moni / a 模式下可用。`;
        const isBtc = modeState.name === "btc";
        const role = modeState.paper ? "paper" : "live";
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
        if (modeState?.name === "a") {
          if (arg.trim().toLowerCase() === "status") {
            const pause = readAPause();
            return pause.paused
              ? `A 股巡检已暂停（${pause.at ?? "?"}，/pause resume 恢复）`
              : "A 股巡检运行中（/pause 可暂停，进程仍在）";
          }
          setAPaused(!resume, "/pause");
          return resume ? "✓ 已恢复 A 股巡检与交易" : "✓ 已暂停 A 股巡检与交易（/pause resume 恢复）";
        }
        if (modeState?.name !== "btc") return "/pause 仅在 btc / btc moni / a 模式下有效";
        setPaused(getBtcHome(), !resume, "/pause");
        return resume ? "✓ 已恢复 btc 后端巡检" : "✓ 已暂停 btc 后端巡检（/pause resume 恢复）";
      }
      case "watch":
      case "watchlist": {
        if (modeState?.name !== "a") return "/watch 仅在 a 模式下显示自选股；btc 叫醒条件请用 /wakeup。";
        const data = await collectASharePanelData();
        const lines = [`A 股自选股 ${data.watch.length}/10（★=持仓）`];
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
        if (modeState?.name === "btc") {
          const triggers = readTriggers(
            getBtcHome(),
            modeState.paper ? "paper" : "live",
          );
          if (triggers.length === 0) return "当前没有叫醒条件（btc_trigger 可添加）";
          return `叫醒条件 ${triggers.length} 条：\n` + triggers.map((trigger) => `- ${describeTrigger(trigger)}`).join("\n");
        }
        if (modeState?.name === "a") {
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
      if (!modeState) {
        return "当前是普通模式；发送 /btc、/btc moni 或 /a 切换模式后，/info 才有右侧面板详情可看。";
      }
      if (modeState.name === "btc") {
        const data = await collectBtcPanelData(
          getBtcHome(),
          modeState.paper ? "paper" : "live",
        );
        return btcInfoLines(data).join("\n").replace(/^\n+/, "");
      }
      const data = await collectASharePanelData();
      return aInfoLines(data).join("\n").replace(/^\n+/, "");
    }

    if (command.kind === "xzh") {
      if (!modeState) return `当前已是 xzh 普通模式（${home}）。`;
      const previous = modeSpec(modeState).label;
      applyGatewayMode(null, peer);
      return `✓ 已退出 ${previous}，回到 ${home}。`;
    }

    if (command.kind === "btc") {
      if (modeState?.name === "btc" && (modeState.paper === true) === command.paper) {
        const serviceMessage = await ensureBackend(createBtcMode({ paper: command.paper }));
        return `已在 ${modeSpec(modeState).label}。${serviceMessage ? `\n${serviceMessage}` : ""}`;
      }
      const label = applyGatewayMode({ name: "btc", paper: command.paper }, peer);
      const serviceMessage = await ensureBackend(createBtcMode({ paper: command.paper }));
      return `✓ 已切换到 ${label}（工作目录 ${getBtcHome()}）。${serviceMessage ? `\n${serviceMessage}` : ""}`;
    }

    if (modeState?.name === "a") {
      const serviceMessage = await ensureBackend(createAShareMode());
      return `已在 A 股分析模式。${serviceMessage ? `\n${serviceMessage}` : ""}`;
    }
    const label = applyGatewayMode({ name: "a" }, peer);
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
      onToolEnd: (call, result) => {
        const brief = (result.content ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
        if (brief) lastToolNote = `${call.name} → ${brief}`;
      },
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
    // 每个对端各持有一个 Agent，创建后立刻记到自己名下
    currentSession.agent = agent;
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

  /** 串行处理：Agent 实例不是并发安全的，同时两条消息会把上下文搅在一起 */
  let queue: Promise<unknown> = Promise.resolve();
  const handleMessage = (text: string, peer?: string): Promise<string> => {
    const task = queue.then(async () => {
      // 切到该对端自己的会话：历史、模式、Agent 全都分开（见 GatewaySession）
      const session = sessionFor(peer);
      activateSession(session);
      // 每轮都从空白开始：上一轮的兜底文案（尤其 lastToolNote）不能串到这一轮
      replyBuffer = "";
      deniedNote = "";
      lastToolNote = "";
      try {
        // 微信：恢复该对端上次使用的模式；没有记录时沿用当前模式并记住
        if (peer) {
          const saved = readPeerModes(home).modes[peer];
          if (saved && !sameGatewayMode(saved, session.mode)) applyGatewayMode(saved, peer);
          else writePeerMode(peer, session.mode, home);
        }

        // `/btc` / `/a` / `/xzh` 这类命令不进入对话历史，也不调用模型
        const commandReply = await handleCommand(text, peer);
        if (commandReply !== null) return commandReply;

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
          const partial = replyBuffer.trim();
          const done = lastToolNote ? `已完成的最后一步：${lastToolNote}` : "";
          return partial
            ? `${partial}\n\n[⏱ 本轮超过 ${timeoutMinutes} 分钟，已中断${done ? `；${done}` : ""}]`
            : `⏱ 本轮超过 ${timeoutMinutes} 分钟，已中断。${done ? `${done}。` : ""}` +
                `可以让我只做其中一步（例如「只查价格」「只跑一次巡检」），或把任务拆小。`;
        }
        const reply =
          replyBuffer.trim() ||
          (lastToolNote
            ? `（本轮没有文本输出，但工具已执行：${lastToolNote}）`
            : "（本轮没有文本输出；可能是模型超时或工具轮数用尽，请重试一次）");
        return deniedNote ? `${reply}\n\n[${deniedNote}]` : reply;
      } finally {
        // 不管成功、命令还是异常，都要把该会话的 Agent / 模式写回，
        // 否则下一个对端会拿到上一个对端的实例（回到「串台」）
        saveSession();
      }
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
      weixin = startWeixinChannel({
        home,
        account,
        log,
        allowedUsers: allowed,
        // 与 HTTP /message 共用同一条串行队列：同一个 Agent 实例不能并发
        onMessage: (text, peer) => handleMessage(text, peer),
      });
      log(`微信频道已启动 account=${account.accountId}`);
      // 出站队列：先落盘再串行发送，失败退避重试，gateway 重启不丢
      outbox = startOutbox({
        gatewayHome: home,
        log,
        send: (text) => (weixin ? weixin.sendToLastPeer(text) : Promise.resolve(false)),
      });
      // 巡检内容转发：btc 后端结论 / 错误、A 股选股 / 买卖，推给最近对话的对端
      feed = startFeedForwarder({
        gatewayHome: home,
        log,
        send: async (text) => {
          outbox?.enqueue(text);
          return true;
        },
      });
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

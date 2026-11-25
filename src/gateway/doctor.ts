import { spawnSync } from "child_process";
import * as fs from "fs";
import { currentAInspectOffset } from "../a/inspect-stream";
import { aActionsPath } from "../a/monitor";
import { inspectStreamPath } from "../btc/inspect-stream";
import { getBtcHome } from "../utils/paths";
import { httpTokenPath, readHttpToken } from "./auth";
import { digestCount } from "./digest";
import { feedOffsetsPath, readFeedOffsets } from "./feed";
import { BLOCK_AFTER_REFUSALS, readOutboxState } from "./outbox";
import { gatewayHome, gatewayPaths } from "./paths";
import { gatewayStatus } from "./service";
import { healthFile, type ChannelHealth } from "./weixin/channel";
import { loadAccount } from "./weixin/paths";

/**
 * `xzh gateway doctor`：一条命令回答「为什么没收到消息」。
 *
 * 2026-11-24 排查那次故障时，结论是靠 `journalctl | grep` + 手工对比文件偏移拼出来的。
 * 这些信息本来都是确定的、可计算的，不该让用户（或未来的自己）再拼一次。
 *
 * 输出三段：**结论**（一句话）、**关键状态**、**最近日志**。
 */

export type DoctorLevel = "ok" | "warn" | "bad" | "info";

export interface DoctorLine {
  level: DoctorLevel;
  text: string;
}

export interface DoctorReport {
  ok: boolean;
  /** 一句话结论（给不看细节的人） */
  verdict: string;
  lines: DoctorLine[];
  /** 最近日志（systemd 环境下才取得到） */
  log: string;
}

const MINUTE = 60_000;

function age(from?: string): number | null {
  const at = Date.parse(from ?? "");
  return Number.isFinite(at) ? Date.now() - at : null;
}

function humanAge(ms: number | null): string {
  if (ms === null) return "从未";
  if (ms < MINUTE) return `${Math.max(0, Math.round(ms / 1000))} 秒前`;
  if (ms < 60 * MINUTE) return `${Math.round(ms / MINUTE)} 分钟前`;
  return `${Math.round(ms / (60 * MINUTE))} 小时前`;
}

/** 将来时（`nextProbeAt` 这类）：还有多久 */
function humanUntil(at?: string): string {
  const ms = age(at);
  if (ms === null) return "未安排";
  if (ms <= 0) return "已到期";
  const left = -ms;
  if (left < MINUTE) return `${Math.max(1, Math.round(left / 1000))} 秒后`;
  return `${Math.round(left / MINUTE)} 分钟后`;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function fileSize(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

/** systemd 用户的日志尾部（非 Linux / 无 systemd 时返回空串） */
function journalTail(lines = 12): string {
  if (process.platform !== "linux") return "";
  const result = spawnSync(
    "journalctl",
    ["--user", "-u", "xzh-gateway.service", "-n", String(lines), "--no-pager", "-o", "cat"],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) return "";
  return (result.stdout ?? "").trimEnd();
}

export function collectDoctor(home = gatewayHome()): DoctorReport {
  const lines: DoctorLine[] = [];
  const paths = gatewayPaths(home);
  const status = gatewayStatus(home);
  const outbox = readOutboxState(home);
  const pending = digestCount(home);
  const account = loadAccount(home);
  const health = readJson<ChannelHealth>(healthFile(home));
  const token = readHttpToken(home);
  const offsets = readFeedOffsets(feedOffsetsPath(home));

  const push = (level: DoctorLevel, text: string): void => {
    lines.push({ level, text });
  };

  // ── 进程 ──
  if (!status.running) {
    push("bad", "gateway：未运行（`xzh gateway` 启动；已装 systemd 的话 systemctl --user start xzh-gateway）");
  } else {
    const state = status.state!;
    push(
      "ok",
      `gateway：运行中 pid ${state.pid} · v${state.version} · 心跳 ${humanAge(age(state.updatedAt))}` +
        ` · 端口 ${state.port}`,
    );
    if (state.lastError) push("warn", `最近错误：${state.lastError}`);
    if (state.pushBlocked) push("warn", `推送：${state.pushBlocked}`);
  }

  // ── 入站 ──
  if (!account) {
    push("bad", "微信：未登录（`xzh gateway weixin login` 扫码）");
  } else {
    push("info", `微信：已登录 ${account.accountId}（凭证保存于 ${humanAge(age(account.savedAt))}）`);
  }
  if (health) {
    const okAge = age(health.lastOkAt);
    const stale = okAge === null || okAge > 3 * MINUTE;
    push(
      stale ? "bad" : "ok",
      `长轮询：最近成功 ${humanAge(okAge)}（累计 ${health.polls} 次，失败 ${health.errors} 次` +
        `${health.lastError ? `，最近错误：${health.lastError}` : ""}）`,
    );
  } else if (status.running) {
    push("warn", "长轮询：没有健康记录（刚启动，或微信未登录）");
  }

  // ── 出站 ──
  const oldestCreatedAt = outbox.items
    .map((item) => item.createdAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const oldest = age(oldestCreatedAt);
  const depth = outbox.items.length;
  if (depth === 0) {
    push("ok", `出站队列：空（累计送达 ${outbox.stats.delivered}，丢弃 ${outbox.stats.dropped}）`);
  } else {
    const stalled = oldest !== null && oldest > 10 * MINUTE;
    push(
      stalled ? "warn" : "info",
      `出站队列：${depth} 条待发，最早 ${humanAge(oldest)}` +
        `（累计送达 ${outbox.stats.delivered}，丢弃 ${outbox.stats.dropped}）`,
    );
  }
  if (outbox.stats.lastError) {
    push("warn", `最近发送错误（${humanAge(age(outbox.stats.lastErrorAt))}）：${outbox.stats.lastError}`);
  }
  const blockedPeers = Object.entries(outbox.peers).filter(
    ([, peer]) => peer.rejectStreak >= BLOCK_AFTER_REFUSALS,
  );
  for (const [peer, state] of blockedPeers) {
    push(
      "bad",
      `对端 ${peer.slice(-6)}：连续被拒收 ${state.rejectStreak} 次，` +
        `下次探测 ${humanUntil(state.nextProbeAt)} → ` +
        "给 bot 发一条消息可立即恢复",
    );
  }
  if (pending > 0) {
    push(
      "warn",
      `摘要箱：${pending} 条兜底消息（只应在队列超限时出现；网关下次启动会自动补发，也可 /digest 取回）`,
    );
  }

  // ── 转发进度 ──
  const btcSize = fileSize(inspectStreamPath(getBtcHome()));
  const aStreamNow = currentAInspectOffset();
  const aActionsSize = fileSize(aActionsPath());
  const lag = (cursor: number | undefined, size: number | null): string => {
    if (cursor === undefined) return "未接入";
    if (size === null) return "无数据";
    const diff = size - cursor;
    return diff <= 0 ? "已跟上" : `落后 ${diff} 字节`;
  };
  push(
    "info",
    `巡检转发：btc ${lag(offsets.btc, btcSize)} · A 股结论 ${lag(offsets["a-stream"], aStreamNow)}` +
      ` · A 股动作 ${lag(offsets.a, aActionsSize)}`,
  );

  // ── 本地接口 ──
  push(
    token ? "ok" : "warn",
    token
      ? `本地接口：/message 需要令牌（${httpTokenPath(home)}）`
      : "本地接口：令牌文件不存在，/message 目前不校验（本机任意进程都能驱动 agent）",
  );

  // ── 结论 ──
  let verdict: string;
  let ok = true;
  if (!status.running) {
    verdict = "gateway 没在运行 —— 微信不会有任何回复，也不会有巡检推送。";
    ok = false;
  } else if (!account) {
    verdict = "微信未登录 —— 收不到也发不出。运行 `xzh gateway weixin login`。";
    ok = false;
  } else if (!health && status.state && (age(status.state.startedAt) ?? Infinity) < 90_000) {
    verdict = "gateway 刚启动，长轮询还没返回第一轮（长轮询最长 35 秒，稍后再看一次）。";
  } else if (health && (age(health.lastOkAt) ?? Infinity) > 3 * MINUTE) {
    verdict = "长轮询已失联 —— 收到的消息会延迟到恢复为止；先看下面的最近错误（网络 / 登录态）。";
    ok = false;
  } else if (blockedPeers.length > 0) {
    verdict =
      "推送通道被 iLink 拒收（ret=-2）—— 在微信里给 bot 发任意消息即可恢复，" +
      "期间消息全部排队，按 10/20/30 分钟探测重试；你发一条消息即立即补发。";
    ok = false;
  } else if (depth > 0 && oldest !== null && oldest > 10 * MINUTE) {
    verdict = `出站队列堵住了 ${depth} 条（最早 ${humanAge(oldest)}）—— 看「最近发送错误」。`;
    ok = false;
  } else {
    verdict =
      depth > 0
        ? `一切正常，队列里 ${depth} 条正在发。`
        : pending > 0
          ? `通道正常；有 ${pending} 条兜底消息待补发（重启网关或 /digest 可取回）。`
          : "一切正常：进程、登录态、长轮询、出站队列都健康。";
  }

  return { ok, verdict, lines, log: journalTail() };
}

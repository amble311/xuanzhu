import * as fs from "fs";
import * as path from "path";
import { getBtcHome } from "../utils/paths";
import type { Trigger } from "./triggers";

/**
 * btc 叫醒条件审计：写入/删除/命中的旁路日志。
 *
 * 审计失败不影响规则本身；只记录，不拦截 AI 的创建/删除。
 */

export interface TriggerAuditEntry {
  ts: string;
  action: "add" | "remove" | "clear" | "hit" | "reject";
  actor: "inspect" | "manual" | "system";
  role: "live" | "paper";
  ok: boolean;
  triggerId?: string;
  kind?: string;
  expression?: string;
  reason?: string;
  observed?: number;
  duplicate?: boolean;
  error?: string;
}

function auditPath(home = getBtcHome()): string {
  return path.join(home, "run", "trigger-audit.jsonl");
}

export function appendTriggerAudit(
  entry: Omit<TriggerAuditEntry, "ts">,
  home = getBtcHome(),
): void {
  try {
    const file = auditPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      // 文件不存在
    }
    fs.appendFileSync(
      file,
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch {
    // 审计失败不阻断规则写入
  }
}

export function readTriggerAudits(limit = 30, home = getBtcHome()): TriggerAuditEntry[] {
  try {
    return fs
      .readFileSync(auditPath(home), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-Math.max(1, limit))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as TriggerAuditEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function auditTrigger(
  action: TriggerAuditEntry["action"],
  role: "live" | "paper",
  trigger: Trigger | { id: string; kind?: string; expression?: string; note?: string },
  options: { actor?: TriggerAuditEntry["actor"]; ok?: boolean; error?: string; observed?: number; duplicate?: boolean } = {},
): void {
  appendTriggerAudit({
    action,
    actor: options.actor ?? (process.env.XZH_BTC_INSPECT === "1" ? "inspect" : "manual"),
    role,
    ok: options.ok ?? true,
    triggerId: trigger.id,
    kind: trigger.kind,
    expression: trigger.expression,
    reason: trigger.note,
    observed: options.observed,
    duplicate: options.duplicate,
    error: options.error,
  });
}

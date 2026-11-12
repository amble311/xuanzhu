import * as fs from "fs";
import * as path from "path";
import { monitorDir } from "./watchlist";

/**
 * 监控规则写入审计。
 *
 * 监控进程本身不交易，只评估规则并唤醒巡检；因此规则写入必须有审计：
 * 谁写的（巡检/手动）、写了什么、表达式是否通过白名单、是否在持仓/自选范围内。
 */

export interface RuleAuditEntry {
  ts: string;
  actor: "inspect" | "manual" | "cli";
  action: "add" | "remove" | "reject";
  ok: boolean;
  code?: string;
  kind?: string;
  ruleId?: string;
  detail?: string;
  error?: string;
}

function auditPath(): string {
  return path.join(monitorDir(), "logs", "rule-audit.jsonl");
}

export function appendRuleAudit(entry: Omit<RuleAuditEntry, "ts">): void {
  try {
    const file = auditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch {
    // 审计失败不影响规则写入；日志会暴露问题
  }
}

export function readRuleAudits(limit = 20): RuleAuditEntry[] {
  try {
    const lines = fs
      .readFileSync(auditPath(), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-Math.max(1, limit));
    return lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as RuleAuditEntry];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

import * as fs from "fs";
import * as path from "path";
import { monitorDir } from "./watchlist";

/**
 * 持仓级风险告警（只落盘 + 唤醒巡检，不自动交易）。
 *
 * 与 btc 的硬风控对齐：
 * - 止损/移动止盈/30m 走弱/ T+1 锁定只写告警；
 * - 巡检看到告警后自己决定 a_order；
 * - 监控进程不替巡检下单。
 */

export interface PositionRiskAlert {
  code: string;
  name: string;
  reason: string;
  sellable: boolean;
  qty: number;
  at: string;
}

export interface PositionRiskFile {
  version: 1;
  updatedAt: string;
  delivered: boolean;
  alerts: PositionRiskAlert[];
}

function alertsPath(): string {
  return path.join(monitorDir(), "run", "risk-alerts.json");
}

export function readPositionRisks(): PositionRiskFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(alertsPath(), "utf8")) as PositionRiskFile;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      delivered: parsed.delivered === true,
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
    };
  } catch {
    return { version: 1, updatedAt: "", delivered: true, alerts: [] };
  }
}

export function writePositionRisks(alerts: PositionRiskAlert[]): void {
  const file = alertsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const previous = readPositionRisks();
  // 同一批告警已送达过就不再重复唤醒；内容变化则重新置为未送达
  const signature = alerts.map((item) => `${item.code}:${item.reason}`).join("|");
  const previousSignature = previous.alerts
    .map((item) => `${item.code}:${item.reason}`)
    .join("|");
  const next: PositionRiskFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    delivered: alerts.length > 0 && previous.delivered && signature === previousSignature,
    alerts,
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function markPositionRisksDelivered(): void {
  const current = readPositionRisks();
  if (current.alerts.length === 0) return;
  const file = alertsPath();
  const next: PositionRiskFile = { ...current, delivered: true };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

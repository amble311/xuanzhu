import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fetchBars } from "../exchange/ashare";
import { ensureDir, getAShareHome } from "../utils/paths";
import { loadWatchlist } from "./watchlist";

/**
 * Python 离线研究（不参与盘中实时链路）。
 *
 * Node 负责取数（同花顺）与展示；Python 只做回测/参数扫描。
 * 这是刻意的分层：实时监控/巡检保持 TS，研究用 pandas/numpy。
 */

export interface ResearchResult {
  params: { stop_atr: number; trail_trigger: number; max_positions: number };
  returnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  trades: number;
  avgHoldDays: number;
}

export interface ResearchOutput {
  ok: boolean;
  error?: string;
  results?: ResearchResult[];
  best?: ResearchResult | null;
  report?: string;
}

function pythonScript(): string {
  const candidates = [
    path.join(__dirname, "..", "..", "assets", "a", "research.py"),
    path.join(__dirname, "..", "assets", "a", "research.py"),
    path.join(process.cwd(), "assets", "a", "research.py"),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? candidates[0];
}

function pythonBin(): string {
  return process.env.XZH_PYTHON?.trim() || (process.platform === "win32" ? "python" : "python3");
}

export async function runResearch(input: {
  codes: string[];
  days: number;
  stopAtr: number[];
  trail: number[];
  maxPositions: number;
}): Promise<ResearchOutput> {
  const codes = [...new Set(input.codes.map((code) => code.trim()).filter(Boolean))];
  if (codes.length === 0) return { ok: false, error: "没有可回测的股票（自选股为空，或未传 --codes）" };

  // 指数 all 端点不稳定（502），只能用 last 端点（最多 140 根）
  const days = Math.max(60, Math.min(120, input.days));
  const history = Math.max(400, days + 120);
  const stockBars = await Promise.all(
    codes.map(async (code) => {
      const bars = await fetchBars(code, {
        period: "day",
        adjust: "backward",
        limit: history,
      }).catch(() => []);
      return {
        code,
        bars: bars.map((bar) => ({
          date: bar.time.slice(0, 10),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          amount: bar.amount ?? bar.close * bar.volume,
        })),
      };
    }),
  );
  const indexBars = await fetchBars("1B0300", {
    period: "day",
    adjust: "none",
    limit: 140,
  }).catch(() => []);
  if (indexBars.length === 0) return { ok: false, error: "沪深300 历史数据为空" };

  const payload = JSON.stringify({
    codes: stockBars.filter((item) => item.bars.length > 0),
    index: indexBars.map((bar) => ({ date: bar.time.slice(0, 10), close: bar.close })),
    grid: {
      stop_atr: input.stopAtr,
      trail_trigger: input.trail,
      max_positions: [input.maxPositions],
    },
  });

  const output = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(pythonBin(), [pythonScript()], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += "\nPython 回测超时（120 秒）";
    }, 120_000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.write(payload);
    child.stdin.end();
  });

  if (output.code !== 0) {
    return {
      ok: false,
      error: `Python 执行失败：${output.stderr.trim().slice(0, 300) || `退出码 ${output.code}`}`,
    };
  }
  const lastLine = output.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    const parsed = JSON.parse(lastLine) as ResearchOutput;
    if (!parsed.ok) return parsed;
    const dir = path.join(getAShareHome(), "reports");
    ensureDir(dir);
    const file = path.join(dir, `research-${Date.now()}.json`);
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return { ...parsed, report: file };
  } catch (err) {
    return {
      ok: false,
      error: `Python 输出无法解析：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function defaultResearchCodes(): string[] {
  return loadWatchlist().items.map((item) => item.code);
}

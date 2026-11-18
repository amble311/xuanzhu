import * as fs from "fs";
import * as path from "path";

/**
 * 持仓基线：**清仓检测**的唯一依据。
 *
 * 为什么不用「成交记录」判断：三条链路的成交写法各不相同（A 股写 `paper.json` 的 trades、
 * btc 实盘写 `run/actions.jsonl`、btc 模拟盘只写 Python 账本、工具也不记动作），
 * 想覆盖「模型下单 / 用户手动下单 / 挂单成交」三种情况，最可靠的是**对比持仓本身**：
 * 上一轮有、这一轮没了 = 清仓。
 *
 * 文件放在各自 home 的 `run/` 下（A 股 `~/.xzh_a/monitor/run/`，btc `~/.xzh_btc/run/`），
 * 名字带角色，实盘与模拟盘互不干扰；进程重启后仍能接上（停机期间清掉的仓也会被识别）。
 */

export interface PositionBaseline {
  /** 持仓代码 / 交易对，升序 */
  codes: string[];
  updatedAt: string;
}

export function baselinePath(dir: string, name = "positions-baseline"): string {
  return path.join(dir, "run", `${name}.json`);
}

/** 读基线；文件缺失 / 损坏返回 null（= 首次运行，没有可比对的历史） */
export function readBaseline(dir: string, name?: string): PositionBaseline | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePath(dir, name), "utf8")) as Partial<
      PositionBaseline
    >;
    if (!Array.isArray(parsed.codes)) return null;
    return {
      codes: parsed.codes.filter((code): code is string => typeof code === "string"),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

export function writeBaseline(
  dir: string,
  codes: string[],
  now = new Date(),
  name?: string,
): void {
  const file = baselinePath(dir, name);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload: PositionBaseline = {
      codes: [...new Set(codes)].sort(),
      updatedAt: now.toISOString(),
    };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // 基线写不进去最多漏一次清仓复盘，不该让 tick 退出
  }
}

/** 两份代码列表是否相同（已排序 / 未排序都行） */
export function sameCodes(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((code, index) => code === right[index]);
}

/**
 * 与上一轮基线对比，返回**消失**的代码（= 已清仓）。
 *
 * `previous === null`（首次运行 / 文件损坏）时返回空数组：没有历史就无从判断，
 * 不能把「当前所有持仓」当成刚清仓 —— 否则每次重启都会误跑一轮复盘。
 */
export function closedSince(previous: PositionBaseline | null, codes: string[]): string[] {
  if (!previous) return [];
  const current = new Set(codes);
  return previous.codes.filter((code) => !current.has(code));
}

/** 清仓复盘的叫醒说明（A 股与 btc 共用，policy 工具名不同） */
export function liquidationNote(codes: string[], policyTool: string): string {
  return (
    `清仓复盘：${codes.join("、")} 已清仓（持仓归零）。\n` +
    "按顺序做三件事：\n" +
    "1. 复盘：入场依据、出场原因（止盈 / 止损 / 趋势反转 / 风控）、实际盈亏、与当时计划的偏差；\n" +
    `2. 自我学习：把可复用的经验用 \`${policyTool}\` 追加 1–3 条（不重复已有条目，` +
    "不写「保持谨慎」这类空话；写清「什么形态该进、什么信号是误判、仓位/止损该松还是紧」）；\n" +
    "3. 记录：结论开头写「【清仓复盘】」，说明这次教训与下次如何执行。"
  );
}

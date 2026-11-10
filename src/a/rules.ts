import * as fs from "fs";
import * as path from "path";
import type { Quote } from "../exchange/ashare";
import type { Indicators } from "./indicators";
import { monitorDir } from "./watchlist";

/**
 * 监控规则（对齐 btc triggers 的“只叫醒、不下单”）。
 *
 * 规则由巡检 Agent 通过 `a_trigger` 写入；监控循环只做确定性评估，
 * 命中后把 reason 交给巡检，由巡检决定操作。
 */

export type RuleKind =
  | "price_above"
  | "price_below"
  | "pct_above"
  | "pct_below"
  | "ma20_break"
  | "ma20_above"
  | "ret20_above"
  | "chain"
  | "formula";

export interface RuleStep {
  kind: Exclude<RuleKind, "chain" | "formula">;
  value?: number;
}

export interface MonitorRule {
  id: string;
  code: string;
  kind: RuleKind;
  /** price/pct 规则的目标值；ma20_break 不需要 */
  value?: number;
  note: string;
  once: boolean;
  cooldownMin: number;
  lastFiredAt?: string;
  createdAt: string;
  expiresAt?: string;
  /** 只在交易日的这个小时窗口内评估（UTC+8） */
  windowStartHour?: number;
  windowEndHour?: number;
  /** formula 规则的表达式（只允许价格/均线/涨幅变量） */
  expression?: string;
  /** 链式规则的步骤；只有最后一步满足才唤醒 */
  steps?: RuleStep[];
  /** 当前已满足到第几步（0 起） */
  step?: number;
  armedAt?: string;
  chainExpireMin?: number;
}

interface RuleFile {
  version: number;
  rules: MonitorRule[];
}

const RULES_FILE = "run/rules.json";
const MAX_RULES = 20;
const DEFAULT_COOLDOWN_MIN = 30;
const DEFAULT_TTL_HOURS = 72;

function rulesPath(): string {
  return path.join(monitorDir(), RULES_FILE);
}

function readFile(): RuleFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(rulesPath(), "utf8")) as RuleFile;
    return { version: parsed.version ?? 1, rules: Array.isArray(parsed.rules) ? parsed.rules : [] };
  } catch {
    return { version: 1, rules: [] };
  }
}

function writeFile(file: RuleFile): void {
  const target = rulesPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
}

export function readRules(): MonitorRule[] {
  const now = Date.now();
  const file = readFile();
  const alive = file.rules.filter(
    (rule) => !rule.expiresAt || Date.parse(rule.expiresAt) > now,
  );
  if (alive.length !== file.rules.length) {
    file.rules = alive;
    writeFile(file);
  }
  return alive;
}

export function addRule(input: {
  code: string;
  kind: RuleKind;
  value?: number;
  note: string;
  once?: boolean;
  cooldownMin?: number;
  ttlHours?: number;
  windowStartHour?: number;
  windowEndHour?: number;
  steps?: RuleStep[];
  chainExpireMin?: number;
  expression?: string;
}): { ok: true; rule: MonitorRule } | { ok: false; error: string } {
  const code = input.code.trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "股票代码必须是 6 位数字" };
  if (
    input.kind !== "ma20_break" &&
    input.kind !== "ma20_above" &&
    input.kind !== "chain" &&
    input.kind !== "formula" &&
    (!Number.isFinite(input.value) || (input.value ?? 0) <= 0)
  ) {
    return { ok: false, error: "price/pct/ret20 规则需要正数 value" };
  }
  if (input.kind === "formula") {
    if (!input.expression || !validateFormula(input.expression)) {
      return { ok: false, error: "formula 表达式非法（只允许 price/pct/ma5/ma20/ma60/ret5/ret20/ret60/atr_pct/amount 与运算符）" };
    }
  }
  if (input.kind === "chain") {
    if (!Array.isArray(input.steps) || input.steps.length < 2) {
      return { ok: false, error: "链式规则至少需要 2 个步骤" };
    }
    if (input.steps.some((step) => !step || !step.kind)) {
      return { ok: false, error: "链式步骤缺少条件" };
    }
  }
  const rules = readRules();
  if (rules.length >= MAX_RULES) return { ok: false, error: `最多 ${MAX_RULES} 条规则` };
  const now = new Date();
  const rule: MonitorRule = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    code,
    kind: input.kind,
    value:
      input.kind === "ma20_break" ||
      input.kind === "ma20_above" ||
      input.kind === "chain" ||
      input.kind === "formula"
        ? undefined
        : input.value,
    ...(input.kind === "formula" ? { expression: input.expression } : {}),
    ...(input.kind === "chain"
      ? { steps: input.steps, step: 0, chainExpireMin: Math.max(5, input.chainExpireMin ?? 240) }
      : {}),
    note: input.note.trim() || describeRuleInput(input),
    once: input.once === true,
    cooldownMin: Math.max(1, input.cooldownMin ?? DEFAULT_COOLDOWN_MIN),
    createdAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + Math.max(1, input.ttlHours ?? DEFAULT_TTL_HOURS) * 3_600_000,
    ).toISOString(),
    ...(input.windowStartHour !== undefined ? { windowStartHour: input.windowStartHour } : {}),
    ...(input.windowEndHour !== undefined ? { windowEndHour: input.windowEndHour } : {}),
  };
  rules.push(rule);
  writeFile({ version: 1, rules });
  return { ok: true, rule };
}

function describeRuleInput(input: { kind: RuleKind; value?: number }): string {
  switch (input.kind) {
    case "price_above":
      return `价格 ≥ ${input.value}`;
    case "price_below":
      return `价格 ≤ ${input.value}`;
    case "pct_above":
      return `涨幅 ≥ ${input.value}%`;
    case "pct_below":
      return `跌幅 ≤ -${input.value}%`;
    case "ma20_above":
      return "站上日线 MA20";
    case "ret20_above":
      return `20 日涨幅 ≥ ${input.value}%`;
    default:
      return "跌破日线 MA20";
  }
}

export function removeRules(input: { id?: string; code?: string }): number {
  const file = readFile();
  const before = file.rules.length;
  file.rules = file.rules.filter((rule) => {
    if (input.id) return rule.id !== input.id;
    if (input.code) return rule.code !== input.code;
    return false;
  });
  writeFile(file);
  return before - file.rules.length;
}

export function describeRule(rule: MonitorRule): string {
  if (rule.kind === "formula") return `${rule.code} 公式：${rule.expression ?? ""}`;
  if (rule.kind === "chain") {
    return `${rule.code} 链式 ${rule.step ?? 0}/${rule.steps?.length ?? 0}`;
  }
  const target =
    rule.kind === "price_above"
      ? "价格 ≥"
      : rule.kind === "price_below"
        ? "价格 ≤"
        : rule.kind === "pct_above"
          ? "涨幅 ≥"
          : rule.kind === "pct_below"
            ? "跌幅 ≤ -"
            : rule.kind === "ma20_above"
              ? "站上日线 MA20"
              : rule.kind === "ret20_above"
                ? "20 日涨幅 ≥"
                : "跌破日线 MA20";
  if (rule.kind === "ma20_break" || rule.kind === "ma20_above") {
    return `${rule.code} ${target}`;
  }
  const unit = rule.kind.startsWith("pct") ? "%" : "";
  return `${rule.code} ${target} ${rule.value}${unit}`;
}

/** 评估规则：返回命中的第一条（持仓优先由调用方排序） */
function inWindow(rule: MonitorRule, now: Date): boolean {
  if (rule.windowStartHour === undefined && rule.windowEndHour === undefined) return true;
  const hour = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" })).getHours();
  const start = rule.windowStartHour ?? 0;
  const end = rule.windowEndHour ?? 24;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

const FORMULA_VARS = new Set([
  "price",
  "pct",
  "ma5",
  "ma20",
  "ma60",
  "ret5",
  "ret20",
  "ret60",
  "atr_pct",
  "amount",
]);

/** 白名单表达式：变量替换为数字后，只允许算术/比较/逻辑运算 */
export function validateFormula(expression: string): boolean {
  if (!/^[0-9a-zA-Z_+\-*/().<>=!&| ]+$/.test(expression)) return false;
  const names = expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return names.every((name) => FORMULA_VARS.has(name));
}

export function evaluateFormula(
  expression: string,
  vars: Record<string, number | undefined>,
): boolean | null {
  if (!validateFormula(expression)) return null;
  let replaced = expression;
  for (const name of [...FORMULA_VARS].sort((a, b) => b.length - a.length)) {
    if (!new RegExp(`\\b${name}\\b`).test(replaced)) continue;
    const value = vars[name];
    if (value === undefined || !Number.isFinite(value)) return null;
    replaced = replaced.replace(new RegExp(`\\b${name}\\b`, "g"), `(${value})`);
  }
  if (!/^[0-9+\-*/().<>=!&| ]+$/.test(replaced)) return null;
  try {
    return Boolean(new Function(`return (${replaced})`)());
  } catch {
    return null;
  }
}

function stepHit(
  step: RuleStep,
  quote: Quote,
  indicators: Map<string, Indicators>,
): boolean {
  switch (step.kind) {
    case "price_above":
      return quote.price >= (step.value ?? 0);
    case "price_below":
      return quote.price <= (step.value ?? 0);
    case "pct_above":
      return quote.changePct >= (step.value ?? 0);
    case "pct_below":
      return quote.changePct <= -(step.value ?? 0);
    case "ma20_break": {
      const ma20 = indicators.get(quote.code)?.ma20;
      return ma20 !== undefined && quote.price < ma20;
    }
    case "ma20_above": {
      const ma20 = indicators.get(quote.code)?.ma20;
      return ma20 !== undefined && quote.price >= ma20;
    }
    case "ret20_above":
      return (indicators.get(quote.code)?.ret20 ?? -Infinity) >= (step.value ?? 0);
    default:
      return false;
  }
}

function markChainStep(id: string, step: number): void {
  const file = readFile();
  const target = file.rules.find((rule) => rule.id === id);
  if (!target) return;
  target.step = step;
  target.armedAt = new Date().toISOString();
  writeFile(file);
}

export function evaluateRules(
  rules: MonitorRule[],
  quotes: Map<string, Quote>,
  indicators: Map<string, Indicators>,
  now = new Date(),
): { rule: MonitorRule; reason: string } | null {
  for (const rule of rules) {
    if (rule.expiresAt && Date.parse(rule.expiresAt) <= now.getTime()) continue;
    if (!inWindow(rule, now)) continue;
    if (
      rule.lastFiredAt &&
      now.getTime() - Date.parse(rule.lastFiredAt) < rule.cooldownMin * 60_000
    ) {
      continue;
    }
    const quote = quotes.get(rule.code);
    if (!quote || quote.price <= 0) continue;

    if (rule.kind === "chain") {
      const steps = rule.steps ?? [];
      if (steps.length === 0) continue;
      let index = rule.step ?? 0;
      if (rule.armedAt && now.getTime() - Date.parse(rule.armedAt) > (rule.chainExpireMin ?? 240) * 60_000) {
        index = 0;
      }
      while (index < steps.length) {
        if (!stepHit(steps[index], quote, indicators)) break;
        if (index === steps.length - 1) {
          return { rule, reason: `${rule.code} 链式触发（${steps.length}/${steps.length}）：${rule.note}` };
        }
        index += 1;
      }
      if (index !== (rule.step ?? 0)) {
        markChainStep(rule.id, index);
      }
      continue;
    }

    let hit = false;
    switch (rule.kind) {
      case "price_above":
        hit = quote.price >= (rule.value ?? 0);
        break;
      case "price_below":
        hit = quote.price <= (rule.value ?? 0);
        break;
      case "pct_above":
        hit = quote.changePct >= (rule.value ?? 0);
        break;
      case "pct_below":
        hit = quote.changePct <= -(rule.value ?? 0);
        break;
      case "ma20_break": {
        const ma20 = indicators.get(rule.code)?.ma20;
        hit = ma20 !== undefined && quote.price < ma20;
        break;
      }
      case "ma20_above": {
        const ma20 = indicators.get(rule.code)?.ma20;
        hit = ma20 !== undefined && quote.price >= ma20;
        break;
      }
      case "ret20_above":
        hit = (indicators.get(rule.code)?.ret20 ?? -Infinity) >= (rule.value ?? 0);
        break;
      case "formula": {
        const ind = indicators.get(rule.code);
        hit =
          evaluateFormula(rule.expression ?? "", {
            price: quote.price,
            pct: quote.changePct,
            ma5: ind?.ma5,
            ma20: ind?.ma20,
            ma60: ind?.ma60,
            ret5: ind?.ret5,
            ret20: ind?.ret20,
            ret60: ind?.ret60,
            atr_pct: ind?.atr20 && ind.close ? (ind.atr20 / ind.close) * 100 : undefined,
            amount: quote.amount,
          }) === true;
        break;
      }
    }
    if (!hit) continue;
    const detail =
      rule.kind === "ma20_break"
        ? "跌破日线 MA20"
        : rule.kind === "ma20_above"
          ? "站上日线 MA20"
          : rule.kind === "ret20_above"
            ? `20 日涨幅达标（${indicators.get(rule.code)?.ret20?.toFixed(1) ?? "—"}%）`
            : `${describeRule(rule)}（现价 ${quote.price}）`;
    return { rule, reason: `${rule.code} ${detail}：${rule.note}` };
  }
  return null;
}

/** 巡检成功后回写：一次性删除，持续型更新 lastFiredAt */
export function commitRuleHit(rule: MonitorRule): void {
  const file = readFile();
  if (rule.once) {
    file.rules = file.rules.filter((item) => item.id !== rule.id);
  } else {
    const target = file.rules.find((item) => item.id === rule.id);
    if (target) {
      target.lastFiredAt = new Date().toISOString();
      if (target.kind === "chain") {
        target.step = 0;
        delete target.armedAt;
      }
    }
  }
  writeFile(file);
}

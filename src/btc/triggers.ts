import * as fs from "fs";
import * as path from "path";
import { getBtcHome } from "../utils/paths";
import type { ScheduleRole } from "./schedule";

/**
 * 用户的「叫醒条件」（`~/.btc/run/triggers.json`）。
 *
 * 解决的问题：模型只能通过 `btc_schedule` 决定「什么时候看」，而用户真正关心的是
 * 「到了某个价位 / 某个指标值再看」。若把「跌破 80000 提醒我」写成一次排期，
 * 到点时价格可能还没到 —— 那一轮就白烧了。
 *
 * 所以把条件本身落盘，由常驻后端每 5 分钟评估一次（纯计算，不调模型），
 * 命中才跑一轮巡检。**触发器只能叫醒，不能下单** —— 下单仍由模型带着
 * 三周期打分与风控判断，且后台的 `confirm` 恒为 false。
 *
 * 与「市场事件」的区别：市场事件是**确定性的时点**（日线收盘/资金费/波动），
 * 由代码自己决定；这里是**用户/模型给的条件**，只在条件成立时生效。
 */

export type TriggerOp = ">=" | "<=" | ">" | "<";
/**
 * `price` = 实时标记价；`indicator` = 单个指标阈值；
 * `formula` = **受限公式**（多指标组合，如 `rsi_1h * 0.6 + adx_1h * 0.4`）。
 */
export type TriggerKind = "price" | "indicator" | "formula";
/** 可监控的指标：与 `runner.py probe` 的输出字段一一对应 */
export type IndicatorName = "rsi" | "adx" | "ma_gap_pct" | "macd_hist";
export type IndicatorTimeframe = "1h" | "4h" | "1d";

export interface TriggerWindow {
  /** 起（含），北京时间整点 0–23 */
  startHour: number;
  /** 止（不含），北京时间整点 1–23 或 0（= 24:00）；小于起表示跨午夜 */
  endHour: number;
}

export interface Trigger {
  id: string;
  kind: TriggerKind;
  op: TriggerOp;
  /** 阈值 */
  value: number;
  /** kind=indicator 时必填 */
  name?: IndicatorName;
  timeframe?: IndicatorTimeframe;
  /**
   * kind=formula 时必填：受限表达式（只允许白名单变量 + 四则运算 + abs/min/max）。
   * 求值在计算层（`market.py::eval_formula`，AST 白名单），**不是**在本进程 eval 任意代码。
   */
  expression?: string;
  /** 最近一次求值失败的原因（`btc_trigger list` 会显示） */
  lastError?: string;
  /** 命中时的方向倾向（只是给模型的上下文，不是指令） */
  sideHint?: "long" | "short";
  /** 用户为什么设这条（原话，注入巡检提示词） */
  note?: string;
  /** 只在指定时段（北京时间）评估；不设 = 全天 */
  window?: TriggerWindow;
  createdAt: string;
  /** 一次性（默认）：命中后自动失效；false = 持续监控，受 cooldown 约束 */
  once: boolean;
  cooldownMin: number;
  lastFiredAt?: string;
  /** 失效时间（ISO）；过点自动清理 */
  expiresAt?: string;
  /** 最近一次观测到的值（供 list / status 展示） */
  lastSeenValue?: number;
  lastSeenAt?: string;
}

interface TriggerFile {
  version: 1;
  triggers: Trigger[];
}

/** 上限：条件太多说明该收敛成一条策略（也防止反复写入把文件撑大） */
export const MAX_TRIGGERS = 10;
/** 持续型默认冷却：30 分钟，避免同一条件反复叫醒烧模型 */
export const DEFAULT_TRIGGER_COOLDOWN_MIN = 30;
export const MAX_TRIGGER_COOLDOWN_MIN = 24 * 60;
/** 默认 72 小时失效：三天没触发的条件通常已经过期（价格早就换了一个区间） */
export const DEFAULT_TRIGGER_EXPIRE_HOURS = 72;
export const MAX_TRIGGER_EXPIRE_HOURS = 7 * 24;
/** 后台评估触发器的节拍：5 分钟（纯本地计算 + 一次 ticker） */
export const TRIGGER_EVAL_INTERVAL_MS = 5 * 60_000;

export const TRIGGER_OPS: TriggerOp[] = [">=", "<=", ">", "<"];
export const INDICATOR_NAMES: IndicatorName[] = [
  "rsi",
  "adx",
  "ma_gap_pct",
  "macd_hist",
];
export const INDICATOR_TIMEFRAMES: IndicatorTimeframe[] = ["1h", "4h", "1d"];

/** 公式最大长度（与 `market.py::FORMULA_MAX_LEN` 对齐） */
export const FORMULA_MAX_LEN = 200;
/** 公式里允许调用的函数（与计算层一致） */
export const FORMULA_FUNCTIONS = ["abs", "min", "max"] as const;

/**
 * 公式可用的变量：`字段_周期`（如 `rsi_1h`）+ `price`（实时标记价）。
 *
 * 刻意用 `rsi_1h` 而不是 `1h.rsi`：点号在表达式里是属性访问，
 * 那正是要禁掉的语法。这份清单与 `market.py::PROBE_FIELDS` 一一对应，加字段两边一起改。
 */
export const FORMULA_VARIABLES = [
  "price",
  ...["close", "rsi", "adx", "macd_hist", "ma_gap_pct", "atr", "ma20", "ma50", "vol_ratio"].flatMap(
    (field) => ["1h", "4h", "1d"].map((tf) => `${field}_${tf}`),
  ),
];

/**
 * 写入时的轻量校验（真正的 AST 白名单在计算层）。
 *
 * 这里只做「明显写错」的拦截：长度、非法字符、未知变量、括号不配平。
 * 这样用户拿到的是「变量名拼错了」，而不是等 5 分钟后一条静默不命中的条件。
 */
export function validateFormula(expression: string): string | null {
  const expr = expression.trim();
  if (!expr) return "公式为空。";
  if (expr.length > FORMULA_MAX_LEN) {
    return `公式太长（超过 ${FORMULA_MAX_LEN} 字符），请拆成多条或用指标条件。`;
  }
  if (/[[\]{}'";`]/.test(expr)) {
    return "公式不允许下标、字符串或引号（只支持数字、变量与四则运算）。";
  }
  if (!/^[A-Za-z0-9_+\-*/%().,<>=!&|\s]+$/.test(expr)) {
    return "公式含非法字符。允许：变量、数字、+ - * / % ( ) , 以及比较与 and/or/not。";
  }
  const identifiers = expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const allowed = new Set<string>([...FORMULA_VARIABLES, ...FORMULA_FUNCTIONS]);
  const unknown = identifiers.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    return `未知变量：${[...new Set(unknown)].join(", ")}。可用：${
      FORMULA_VARIABLES.join(" / ")
    }；函数只有 abs / min / max。`;
  }

  let depth = 0;
  for (const char of expr) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth < 0) return "括号不配平。";
  }
  if (depth !== 0) return "括号不配平。";
  return null;
}

/** `live` → triggers.json；`paper` → triggers-paper.json（两个后端互不影响） */
export function triggerFilePath(
  home = getBtcHome(),
  role: ScheduleRole = "live",
): string {
  const name = role === "paper" ? "triggers-paper.json" : "triggers.json";
  return path.join(home, "run", name);
}

function isOp(value: unknown): value is TriggerOp {
  return typeof value === "string" && (TRIGGER_OPS as string[]).includes(value);
}

function isIndicatorName(value: unknown): value is IndicatorName {
  return typeof value === "string" && (INDICATOR_NAMES as string[]).includes(value);
}

function isTimeframe(value: unknown): value is IndicatorTimeframe {
  return (
    typeof value === "string" &&
    (INDICATOR_TIMEFRAMES as string[]).includes(value)
  );
}

function isHour(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 23;
}

function normalizeWindow(raw: unknown): TriggerWindow | undefined {
  const input = raw as Partial<TriggerWindow> | undefined;
  if (!isHour(input?.startHour) || !isHour(input?.endHour)) return undefined;
  if (input.startHour === input.endHour) return undefined;
  return { startHour: input.startHour, endHour: input.endHour };
}

/**
 * 当前是否落在条件的时段窗口内（北京时间）。
 *
 * 用「UTC+8 再取小时」而不是 `getHours()`：后者的结果取决于运行机器的时区，
 * 同一份配置换台机器就换了含义。加密 7×24 交易，用户说的「晚上 11 点」
 * 一定是北京时间。
 */
export function inWindow(now: number, window?: TriggerWindow): boolean {
  if (!window) return true;
  const hour = new Date(now + 8 * 3_600_000).getUTCHours();
  const { startHour, endHour } = window;
  if (startHour === endHour) return true; // 防御：坏数据当全天
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** 兼容读取：坏条目直接丢弃，不让一个手改坏的文件把后端拖住 */
function normalize(entry: unknown): Trigger | null {
  const raw = entry as Partial<Trigger>;
  if (typeof raw?.id !== "string" || !isOp(raw?.op)) return null;
  if (typeof raw?.value !== "number" || !Number.isFinite(raw.value)) return null;
  if (raw.kind !== "price" && raw.kind !== "indicator" && raw.kind !== "formula") {
    return null;
  }
  if (raw.kind === "indicator" && !isIndicatorName(raw.name)) return null;
  if (
    raw.kind === "formula" &&
    (typeof raw.expression !== "string" || validateFormula(raw.expression) !== null)
  ) {
    return null;
  }
  return {
    id: raw.id,
    kind: raw.kind,
    op: raw.op,
    value: raw.value,
    name: raw.kind === "indicator" ? raw.name : undefined,
    timeframe: raw.kind === "indicator" ? raw.timeframe ?? "1h" : undefined,
    expression:
      raw.kind === "formula" && typeof raw.expression === "string"
        ? raw.expression.trim()
        : undefined,
    lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
    sideHint: raw.sideHint === "long" || raw.sideHint === "short" ? raw.sideHint : undefined,
    note: typeof raw.note === "string" ? raw.note : undefined,
    window: normalizeWindow(raw.window),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
    once: raw.once !== false,
    cooldownMin:
      typeof raw.cooldownMin === "number" && Number.isFinite(raw.cooldownMin)
        ? Math.min(MAX_TRIGGER_COOLDOWN_MIN, Math.max(1, Math.round(raw.cooldownMin)))
        : DEFAULT_TRIGGER_COOLDOWN_MIN,
    lastFiredAt: typeof raw.lastFiredAt === "string" ? raw.lastFiredAt : undefined,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : undefined,
    lastSeenValue:
      typeof raw.lastSeenValue === "number" && Number.isFinite(raw.lastSeenValue)
        ? raw.lastSeenValue
        : undefined,
    lastSeenAt: typeof raw.lastSeenAt === "string" ? raw.lastSeenAt : undefined,
  };
}

export function readTriggers(
  home = getBtcHome(),
  role: ScheduleRole = "live",
): Trigger[] {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(triggerFilePath(home, role), "utf8"),
    ) as Partial<TriggerFile>;
    const list = Array.isArray(parsed.triggers) ? parsed.triggers : [];
    return list
      .map(normalize)
      .filter((item): item is Trigger => item !== null);
  } catch {
    return [];
  }
}

function writeTriggers(
  home: string,
  triggers: Trigger[],
  role: ScheduleRole,
): void {
  const file = triggerFilePath(home, role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: TriggerFile = { version: 1, triggers };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export interface AddTriggerInput {
  kind: TriggerKind;
  op: TriggerOp;
  value: number;
  name?: string;
  timeframe?: string;
  /** kind=formula 时必填：受限表达式 */
  expression?: string;
  sideHint?: string;
  note?: string;
  once?: boolean;
  cooldownMin?: number;
  expiresHours?: number;
  /** 时段窗口（北京时间整点）；两个都给才生效 */
  windowStartHour?: number;
  windowEndHour?: number;
}

export type AddTriggerResult =
  | { ok: true; trigger: Trigger; duplicate: boolean; size: number }
  | { ok: false; error: string };

/** 数值范围校验：防止「RSI > 500」这种永远不会命中的条件静默躺着 */
function validateValue(kind: TriggerKind, name: IndicatorName | undefined, value: number): string | null {
  if (!Number.isFinite(value)) return "阈值必须是有限数字。";
  // 公式的值域由表达式决定（可能是任意数量级），不做范围校验
  if (kind === "formula") return null;
  if (kind === "price") {
    if (value <= 0) return "价格阈值必须大于 0。";
    return null;
  }
  switch (name) {
    case "rsi":
      if (value < 0 || value > 100) return "RSI 阈值必须在 0–100 之间。";
      return null;
    case "adx":
      if (value < 0 || value > 100) return "ADX 阈值必须在 0–100 之间。";
      return null;
    case "ma_gap_pct":
      if (value < -100 || value > 100) return "MA 偏离阈值必须在 -100%–100% 之间。";
      return null;
    case "macd_hist":
      if (Math.abs(value) > 1e6) return "MACD 柱阈值过大，请确认单位（它通常是个很小的数）。";
      return null;
    default:
      return "指标名不受支持。";
  }
}

export function addTrigger(
  home: string,
  input: AddTriggerInput,
  role: ScheduleRole = "live",
  now = Date.now(),
): AddTriggerResult {
  const kind: TriggerKind = input.kind;
  const op = input.op;
  const name = input.name?.trim().toLowerCase();
  const timeframe = (input.timeframe?.trim().toLowerCase() ?? "1h") as IndicatorTimeframe;

  if (!isOp(op)) return { ok: false, error: "op 只能是 >= / <= / > / <。" };
  if (kind !== "price" && kind !== "indicator" && kind !== "formula") {
    return { ok: false, error: "kind 只能是 price / indicator / formula。" };
  }
  const expression = input.expression?.trim();
  if (kind === "formula") {
    if (!expression) {
      return { ok: false, error: "kind=formula 时必须给 expression（如 rsi_1h * 0.6 + adx_1h * 0.4）。" };
    }
    const invalid = validateFormula(expression);
    if (invalid) return { ok: false, error: invalid };
  }
  if (kind === "indicator") {
    if (!isIndicatorName(name)) {
      return {
        ok: false,
        error: `指标 name 只能是 ${INDICATOR_NAMES.join(" / ")}。`,
      };
    }
    if (!isTimeframe(timeframe)) {
      return {
        ok: false,
        error: `timeframe 只能是 ${INDICATOR_TIMEFRAMES.join(" / ")}。`,
      };
    }
  }
  const invalid = validateValue(kind, name as IndicatorName | undefined, input.value);
  if (invalid) return { ok: false, error: invalid };

  // 时段窗口：要么两个都给，要么都不给 —— 只给一半会被静默忽略，属于「看起来生效了」
  const windowGiven =
    input.windowStartHour !== undefined || input.windowEndHour !== undefined;
  let window: TriggerWindow | undefined;
  if (windowGiven) {
    const start = input.windowStartHour;
    const end = input.windowEndHour;
    if (!isHour(start) || !isHour(end)) {
      return {
        ok: false,
        error: "时段窗口需要 window_start_hour 与 window_end_hour 两个整点（0–23）。",
      };
    }
    if (start === end) {
      return {
        ok: false,
        error:
          "窗口起止小时相同会变成全天；不设窗口就是全天，不需要指定。要「21–24 点」请给 21 与 0。",
      };
    }
    window = { startHour: start, endHour: end };
  }

  const existing = readTriggers(home, role);
  // 完全相同的条件不重复添加：模型被用户重复叮嘱时很容易写两条一样的
  const duplicate = existing.find(
    (item) =>
      item.kind === kind &&
      item.op === op &&
      item.value === input.value &&
      (kind === "indicator"
        ? item.name === name && item.timeframe === timeframe
        : kind === "formula"
          ? item.expression === expression
          : true),
  );
  if (duplicate) {
    return { ok: true, trigger: duplicate, duplicate: true, size: existing.length };
  }
  if (existing.length >= MAX_TRIGGERS) {
    return {
      ok: false,
      error: `最多同时监控 ${MAX_TRIGGERS} 条条件，先删掉不再需要的（btc_trigger remove）。`,
    };
  }

  const once = input.once !== false;
  const cooldownMin = Math.min(
    MAX_TRIGGER_COOLDOWN_MIN,
    Math.max(1, Math.round(input.cooldownMin ?? DEFAULT_TRIGGER_COOLDOWN_MIN)),
  );
  const hours = Math.min(
    MAX_TRIGGER_EXPIRE_HOURS,
    Math.max(1, Math.round(input.expiresHours ?? DEFAULT_TRIGGER_EXPIRE_HOURS)),
  );

  const trigger: Trigger = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    op,
    value: input.value,
    name: kind === "indicator" ? (name as IndicatorName) : undefined,
    timeframe: kind === "indicator" ? timeframe : undefined,
    expression: kind === "formula" ? expression : undefined,
    sideHint:
      input.sideHint === "long" || input.sideHint === "short"
        ? input.sideHint
        : undefined,
    note: input.note?.trim() || undefined,
    window,
    createdAt: new Date(now).toISOString(),
    once,
    cooldownMin,
    expiresAt: new Date(now + hours * 3_600_000).toISOString(),
  };

  writeTriggers(home, [...existing, trigger], role);
  return { ok: true, trigger, duplicate: false, size: existing.length + 1 };
}

export interface RemoveTriggerResult {
  removed: Trigger[];
  remaining: number;
}

export function removeTriggers(
  home: string,
  options: { id?: string; all?: boolean } = {},
  role: ScheduleRole = "live",
): RemoveTriggerResult {
  const existing = readTriggers(home, role);
  const id = options.id?.trim();
  const removed: Trigger[] = [];
  const kept = existing.filter((item) => {
    const match = id ? item.id === id : options.all === true;
    if (match) removed.push(item);
    return !match;
  });
  if (removed.length > 0) writeTriggers(home, kept, role);
  return { removed, remaining: kept.length };
}

/**
 * 回写公式求值错误（计算层返回的 `error`）。
 *
 * 没有它的话，「变量拼错 / 除零」只会表现为条件永远不命中 ——
 * 用户在 list 里看到一条正常条件，实际上它从未被成功评估过。
 */
export function markTriggerErrors(
  home: string,
  errors: Record<string, string>,
  role: ScheduleRole = "live",
): void {
  const triggers = readTriggers(home, role);
  let changed = false;
  for (const trigger of triggers) {
    const next = errors[trigger.id];
    if (next !== undefined) {
      if (trigger.lastError !== next) {
        trigger.lastError = next;
        changed = true;
      }
    } else if (trigger.lastError !== undefined) {
      delete trigger.lastError;
      changed = true;
    }
  }
  if (changed) writeTriggers(home, triggers, role);
}

// ─────────────────────────── 评估 ───────────────────────────

export interface TriggerObservation {
  /** 实时标记价（价格条件用） */
  price?: number;
  /** 指标快照，键为 `${timeframe}.${name}`（如 `1h.rsi`） */
  indicators?: Record<string, number | null | undefined>;
  /** 公式求值结果，键为条件 id（计算层算完回传） */
  formulas?: Record<string, number | null | undefined>;
  now: number;
}

export interface TriggerHit {
  trigger: Trigger;
  actual: number;
}

export function indicatorKey(timeframe: string, name: string): string {
  return `${timeframe}.${name}`;
}

function compare(actual: number, op: TriggerOp, value: number): boolean {
  switch (op) {
    case ">=":
      return actual >= value;
    case "<=":
      return actual <= value;
    case ">":
      return actual > value;
    case "<":
      return actual < value;
    default:
      return false;
  }
}

/** 取这条条件当前的观测值；缺数据 / 已过期 / 冷却中返回 null */
export function currentValue(
  trigger: Trigger,
  observation: TriggerObservation,
): number | null {
  if (trigger.expiresAt && Date.parse(trigger.expiresAt) <= observation.now) {
    return null;
  }
  // 时段外不评估，但条件本身保留（下一轮进入窗口还会生效）
  if (!inWindow(observation.now, trigger.window)) return null;
  if (trigger.kind === "price") {
    return typeof observation.price === "number" && observation.price > 0
      ? observation.price
      : null;
  }
  if (trigger.kind === "formula") {
    const value = observation.formulas?.[trigger.id];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  const key = indicatorKey(trigger.timeframe ?? "1h", trigger.name ?? "");
  const value = observation.indicators?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 持续型是否还在冷却期内 */
export function inCooldown(trigger: Trigger, now: number): boolean {
  if (!trigger.lastFiredAt) return false;
  const last = Date.parse(trigger.lastFiredAt);
  if (Number.isNaN(last)) return false;
  return now - last < trigger.cooldownMin * 60_000;
}

/** 判断一条条件是否命中（不做冷却判断，冷却由 `evaluateTriggers` 统一处理） */
export function triggerHit(
  trigger: Trigger,
  observation: TriggerObservation,
): number | null {
  const actual = currentValue(trigger, observation);
  if (actual === null) return null;
  return compare(actual, trigger.op, trigger.value) ? actual : null;
}

/** 命中的条件列表（按文件顺序，先设置先触发） */
export function evaluateTriggers(
  triggers: Trigger[],
  observation: TriggerObservation,
): TriggerHit[] {
  const hits: TriggerHit[] = [];
  for (const trigger of triggers) {
    if (!trigger.once && inCooldown(trigger, observation.now)) continue;
    const actual = triggerHit(trigger, observation);
    if (actual !== null) hits.push({ trigger, actual });
  }
  return hits;
}

/**
 * 记录一次评估结果：
 * - 一次性条件命中即删除（避免下一轮同一条件再叫一次）；
 * - 持续型只更新 `lastFiredAt` 与 `lastSeenValue`；
 * - 顺手清理过期条目 —— 否则文件里会积一堆永远不会命中的死条件。
 */
export function recordEvaluation(
  home: string,
  triggers: Trigger[],
  observation: TriggerObservation,
  hits: TriggerHit[],
  role: ScheduleRole = "live",
): Trigger[] {
  const hitIds = new Set(hits.map((hit) => hit.trigger.id));
  const seen = new Map<string, number | null>();
  for (const trigger of triggers) {
    const value = currentValue(trigger, observation);
    seen.set(trigger.id, value);
  }

  const next: Trigger[] = [];
  for (const trigger of triggers) {
    const expired =
      trigger.expiresAt !== undefined &&
      Date.parse(trigger.expiresAt) <= observation.now;
    if (hitIds.has(trigger.id) && trigger.once) continue;
    if (expired) continue;

    const value = seen.get(trigger.id);
    const updated: Trigger = { ...trigger };
    if (typeof value === "number") {
      updated.lastSeenValue = value;
      updated.lastSeenAt = new Date(observation.now).toISOString();
    }
    if (hitIds.has(trigger.id)) {
      updated.lastFiredAt = new Date(observation.now).toISOString();
    }
    next.push(updated);
  }

  writeTriggers(home, next, role);
  return next;
}

/** 人类可读的一行（list / 日志 / 提示词共用） */
export function describeTrigger(trigger: Trigger): string {
  const target =
    trigger.kind === "price"
      ? `价格 ${trigger.op} ${trigger.value}`
      : trigger.kind === "formula"
        ? `公式 ${trigger.expression} ${trigger.op} ${trigger.value}`
        : `${trigger.timeframe ?? "1h"} ${trigger.name} ${trigger.op} ${trigger.value}`;
  const extra = [
    trigger.once ? "一次性" : `持续（冷却 ${trigger.cooldownMin} 分钟）`,
    trigger.lastError ? `⚠ 求值失败：${trigger.lastError}` : "",
    trigger.sideHint ? `偏向 ${trigger.sideHint}` : "",
    trigger.window
      ? `仅 ${formatHour(trigger.window.startHour)}–${formatHour(
          trigger.window.endHour === 0 ? 24 : trigger.window.endHour,
        )}（北京）`
      : "",
    trigger.expiresAt ? `至 ${trigger.expiresAt.slice(0, 16).replace("T", " ")}` : "",
  ]
    .filter(Boolean)
    .join("，");
  return `${target}（${extra}）${trigger.note ? `：${trigger.note}` : ""}`;
}

/** 命中的一句话说明，注入巡检提示词 */
export function describeHit(hit: TriggerHit): string {
  const { trigger, actual } = hit;
  const target =
    trigger.kind === "price"
      ? `价格 ${actual} ${trigger.op} ${trigger.value}`
      : trigger.kind === "formula"
        ? `公式 ${trigger.expression} = ${actual} ${trigger.op} ${trigger.value}`
        : `${trigger.timeframe ?? "1h"} ${trigger.name} = ${actual} ${trigger.op} ${trigger.value}`;
  return `${target}${trigger.note ? `；用户原话：${trigger.note}` : ""}`;
}

import {
  INDICATORS_CACHE,
  SNAPSHOT_CACHE,
  buildIndicators,
  formatBars,
  formatQuoteTable,
  formatScreen,
  formatSnapshot,
  addWatchItem,
  aServiceStatus,
  heldCodes,
  loadIndicators,
  loadPaperAccount,
  loadSnapshot,
  loadWatchlist,
  mergeWatchlist,
  readPause,
  readRiskSettings,
  readRiskState,
  riskSummaryLines,
  writeRiskSettings,
  clearRiskTrigger,
  readRules,
  readScheduleQueue,
  setPaused,
  monitorLogPath,
  removeWatchItem,
  runAServe,
  defaultResearchCodes,
  runBacktest,
  runResearch,
  runManualInspection,
  saveWatchlist,
  screenConditionFromInput,
  selectTopWatchlist,
  startAService,
  stopAService,
  screenNeedsIndicators,
  screenStocks,
  summarizeSnapshot,
  type Indicators,
  type RankField,
  type ScreenCondition,
} from "../../a";
import { formatLocalTime } from "../../utils/time";
import {
  BOARDS_CACHE,
  CALENDAR_CACHE,
  UNIVERSE_CACHE,
  boardsByType,
  fetchBars,
  fetchBoardQuotes,
  fetchIntraday,
  fetchQuote,
  loadBoards,
  loadTradingCalendar,
  readCache,
  scanUniverse,
  statCache,
  universeSummary,
  writeCache,
  type Adjust,
  type BarPeriod,
  type BoardKind,
  type BoardType,
  type TradingCalendar,
  type UniverseStock,
} from "../../exchange/ashare";
import { ansi, padEnd } from "../../utils/ansi";
import { getAShareHome } from "../../utils/paths";

/**
 * `xzh a` —— A 股命令入口。
 *
 * 数据类子命令（quote / bars / intraday / market / boards / sync / status /
 * snapshot / screen）在 CLI 与模式内工具之间共用同一套核心（`src/a` 与
 * `src/exchange/ashare`）；模式本体（`xzh a` 直接进入分析 + 模拟交易）后续接入。
 */

const INDEX_LIST: Array<{ code: string; label: string }> = [
  { code: "1A0001", label: "上证指数" },
  { code: "399001", label: "深证成指" },
  { code: "399006", label: "创业板指" },
  { code: "1B0300", label: "沪深300" },
  { code: "1B0905", label: "中证500" },
  { code: "1B0016", label: "上证50" },
];

const PERIODS: BarPeriod[] = ["1m", "5m", "30m", "60m", "day", "week", "month", "quarter", "year"];
const ADJUSTS: Adjust[] = ["none", "forward", "backward"];
const BOARDS: BoardKind[] = ["sh-main", "sz-main", "gem", "star", "bse"];
const RANKS: RankField[] = [
  "pct",
  "amount",
  "turnover",
  "marketCap",
  "ret5",
  "ret20",
  "ma20Distance",
  "high20Distance",
];

interface ParsedArgs {
  positional: string[];
  options: Map<string, string | true>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    if (equal > 0) {
      options.set(arg.slice(2, equal), arg.slice(equal + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, true);
    }
  }
  return { positional, options };
}

function jsonMode(options: Map<string, string | true>): boolean {
  return options.has("json") || options.has("J");
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function optionNumber(
  options: Map<string, string | true>,
  key: string,
): number | undefined {
  const raw = options.get(key);
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error(`--${key} 需要一个数值`);
  const value = parseAmount(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} 不是有效数值：${raw}`);
  return value;
}

/** 支持 `200000000` / `2亿` / `5000万` */
function parseAmount(raw: string): number {
  const text = raw.trim().replace(/,/g, "");
  const match = /^(-?\d+(?:\.\d+)?)(亿|万)?$/.exec(text);
  if (!match) return Number(text);
  const base = Number(match[1]);
  if (match[2] === "亿") return base * 100_000_000;
  if (match[2] === "万") return base * 10_000;
  return base;
}

function periodOf(value: string | true | undefined): BarPeriod {
  if (typeof value !== "string") return "day";
  if ((PERIODS as string[]).includes(value)) return value as BarPeriod;
  throw new Error(`未知周期：${value}（可选：${PERIODS.join(" / ")}）`);
}

function adjustOf(value: string | true | undefined): Adjust {
  if (typeof value !== "string") return "backward";
  if ((ADJUSTS as string[]).includes(value)) return value as Adjust;
  throw new Error(`未知复权方式：${value}（可选：${ADJUSTS.join(" / ")}）`);
}

function boardTypeOf(value: string | true | undefined): BoardType | undefined {
  if (value === undefined || value === true) return undefined;
  if (value === "industry" || value === "concept") return value;
  throw new Error(`未知板块类型：${value}（可选：industry / concept）`);
}

function limitOf(value: string | true | undefined, fallback: number, max: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--limit 需要正整数：${value}`);
  return Math.min(Math.floor(parsed), max);
}

function progressPrinter(label: string, step = 2000): (done: number, total: number) => void {
  let last = 0;
  const tty = process.stdout.isTTY;
  return (done, total) => {
    if (done !== total && done - last < (tty ? 200 : step)) return;
    last = done;
    if (tty) process.stdout.write(`\r${ansi.gray}${label} ${done}/${total}${ansi.reset}`);
    else process.stdout.write(`${ansi.gray}${label} ${done}/${total}${ansi.reset}\n`);
  };
}

function printHelp(): void {
  process.stdout.write(`
${ansi.bold}xzh a${ansi.reset} ${ansi.gray}—— A 股数据与分析（同花顺免鉴权行情域）${ansi.reset}

${ansi.bold}数据${ansi.reset}
  ${ansi.green}xzh a quote <代码...>${ansi.reset}            实时快照（指数写 1A0001）
  ${ansi.green}xzh a bars <代码>${ansi.reset}                 K 线（--period / --adjust / --limit / --from）
  ${ansi.green}xzh a intraday <代码>${ansi.reset}            当日分时
  ${ansi.green}xzh a market${ansi.reset}                     主要指数

${ansi.bold}横截面（全市场）${ansi.reset}
  ${ansi.green}xzh a snapshot${ansi.reset}                   市场温度：涨跌家数 / 涨跌停 / 成交额 / 分布
      ${ansi.gray}--refresh 立即重抓（交易时段默认缓存 2 分钟）${ansi.reset}
  ${ansi.green}xzh a screen${ansi.reset}                     条件筛选 + 排序（只分析个股，不做板块分析）
      ${ansi.gray}--pct-min 3 --pct-max 9.5 --amount-min 2亿 --turnover-min 3${ansi.reset}
      ${ansi.gray}--above-ma20 --near-high20 5 --ret20-min 10 --rank amount --limit 20${ansi.reset}
      ${ansi.gray}--where '{"boards":["sh-main"],"pctMin":3}' 直接给完整 JSON 条件${ansi.reset}

${ansi.bold}监控（独立进程）${ansi.reset}
  ${ansi.green}xzh a serve${ansi.reset}                     启动 A 股巡检与监控（工作日 09:00–15:30）
  ${ansi.green}xzh a serve status|stop${ansi.reset}         查看 / 停止巡检进程
  ${ansi.green}xzh a start|stop${ansi.reset}                 启停巡检（与 btc 的 xzh btc serve|stop 对齐）
  ${ansi.green}xzh a pause [resume|status]${ansi.reset}       暂停/恢复巡检（进程仍在）
  ${ansi.green}xzh a fk [当日% 单票% 连亏]${ansi.reset}        查看 / 修改硬风控（fk reset [代码] 解除；单票锁只锁该股）
  ${ansi.green}xzh a watch${ansi.reset}                     查看自选股（监控池）
  ${ansi.green}xzh a watch add|remove <代码>${ansi.reset}   手工增删（持仓不可删除）
  ${ansi.green}xzh a watch refresh${ansi.reset}             立即全市场重选前 10
  ${ansi.green}xzh a monitor once${ansi.reset}              手动跑一轮巡检（不常驻）
  ${ansi.green}xzh a backtest${ansi.reset}                  日线回测（默认自选股；--codes / --days / --top）
  ${ansi.green}xzh a research${ansi.reset}                  Python 离线参数扫描（--stop / --trail / --days）

${ansi.bold}缓存${ansi.reset}
  ${ansi.green}xzh a sync${ansi.reset}                       建股票池 + 预计算全市场指标 + 交易日历（约 1-2 分钟）
      ${ansi.gray}--fast 只建股票池与日历，不算指标${ansi.reset}
  ${ansi.green}xzh a status${ansi.reset}                     查看数据目录与缓存状态
  ${ansi.green}xzh a boards${ansi.reset}                     板块清单（保留的旧命令，不参与个股筛选）

${ansi.bold}说明${ansi.reset}
  · 数据目录：${ansi.gray}${getAShareHome()}${ansi.reset}（${ansi.gray}XZH_A_HOME${ansi.reset} 可重定向）；
  · 全市场 = 5000+ 请求，首次筛选用 ${ansi.gray}xzh a sync${ansi.reset} 预热，之后读缓存；
  · 复权口径：指标用后复权（前复权在高分红股上早年可能为负）；
  · 排行榜 / 板块成分 / 问财在需要 hexin-v 的域，未接入；筛选只看个股；
  · 所有命令支持 ${ansi.gray}--json${ansi.reset}。
`);
}

async function quoteCommand(parsed: ParsedArgs): Promise<void> {
  if (parsed.positional.length === 0) throw new Error("用法：xzh a quote <代码...>");
  const quotes = await Promise.all(parsed.positional.map((code) => fetchQuote(code)));
  if (jsonMode(parsed.options)) return printJson(quotes);
  process.stdout.write(`${formatQuoteTable(quotes, { color: true })}\n`);
}

async function barsCommand(parsed: ParsedArgs): Promise<void> {
  const code = parsed.positional[0];
  if (!code) throw new Error("用法：xzh a bars <代码> [--period day] [--adjust backward]");
  const limit = limitOf(parsed.options.get("limit"), 120, 200);
  const bars = await fetchBars(code, {
    period: periodOf(parsed.options.get("period")),
    adjust: adjustOf(parsed.options.get("adjust")),
    limit,
    from:
      typeof parsed.options.get("from") === "string"
        ? String(parsed.options.get("from"))
        : undefined,
  });
  if (jsonMode(parsed.options)) return printJson(bars);
  if (bars.length === 0) {
    process.stdout.write(`${ansi.gray}没有取到 K 线。${ansi.reset}\n`);
    return;
  }
  process.stdout.write(
    `${ansi.gray}${code} · ${bars.length} 根 · ${parsed.options.get("period") ?? "day"}` +
      ` · ${parsed.options.get("adjust") ?? "backward"}${ansi.reset}\n`,
  );
  process.stdout.write(`${formatBars(bars, { color: true, limit })}\n`);
}

async function intradayCommand(parsed: ParsedArgs): Promise<void> {
  const code = parsed.positional[0];
  if (!code) throw new Error("用法：xzh a intraday <代码>");
  const series = await fetchIntraday(code);
  if (jsonMode(parsed.options)) return printJson(series);
  process.stdout.write(
    `${ansi.bold}${series.name ?? code}${ansi.reset} ` +
      `${ansi.gray}昨收 ${series.preClose?.toFixed(2) ?? "-"} · ${series.date ?? "-"} · ` +
      `${series.trading ? "交易中" : "非交易时段"}${ansi.reset}\n`,
  );
  for (const point of series.points.slice(-30)) {
    const scale = Math.round((point.price / (series.preClose || point.price)) * 10);
    const bar = "█".repeat(Math.max(1, Math.min(60, scale)));
    process.stdout.write(
      `${padEnd(point.time, 7)} ${padEnd(point.price.toFixed(2), 10)}${ansi.gray}${bar}${ansi.reset}\n`,
    );
  }
  if (series.points.length > 30) {
    process.stdout.write(`${ansi.gray}… 共 ${series.points.length} 个点（--json 查看全部）${ansi.reset}\n`);
  }
}

async function marketCommand(parsed: ParsedArgs): Promise<void> {
  const quotes = await Promise.all(INDEX_LIST.map((item) => fetchQuote(item.code)));
  if (jsonMode(parsed.options)) return printJson(quotes);
  process.stdout.write(`${ansi.bold}主要指数${ansi.reset}\n${formatQuoteTable(quotes, { color: true })}\n`);
  process.stdout.write(`${ansi.gray}更新时间：${quotes[0]?.updatedAt ?? "-"} · 数据源：同花顺${ansi.reset}\n`);
}

async function snapshotCommand(parsed: ParsedArgs): Promise<void> {
  const loaded = await loadSnapshot({
    refresh: parsed.options.has("refresh"),
    onProgress: progressPrinter("已抓取", 1000),
  });
  if (process.stdout.isTTY) process.stdout.write("\r");
  const summary = summarizeSnapshot(loaded.snapshot.rows);
  if (jsonMode(parsed.options)) {
    printJson({ snapshot: loaded.snapshot, summary });
    return;
  }
  process.stdout.write(`${formatSnapshot(loaded.snapshot, summary, { color: true })}\n`);
  if (loaded.ageMs > 5 * 60 * 1000) {
    process.stdout.write(
      `${ansi.gray}（缓存于 ${Math.round(loaded.ageMs / 60000)} 分钟前，--refresh 可重抓）${ansi.reset}\n`,
    );
  }
}

function conditionFrom(parsed: ParsedArgs): ScreenCondition {
  const raw = parsed.options.get("where");
  let condition: ScreenCondition = {};
  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("--where 需要合法的 JSON 条件");
    }
    // 与工具走同一个归一函数：`--where` 里 snake_case / camelCase 都认
    condition = screenConditionFromInput(parsed as Record<string, unknown>);
  }

  const board = parsed.options.get("board");
  if (typeof board === "string") {
    const boards = board.split(",").map((item) => item.trim()) as BoardKind[];
    for (const item of boards) {
      if (!BOARDS.includes(item)) throw new Error(`未知板块：${item}（可选：${BOARDS.join("/")}）`);
    }
    condition.boards = boards;
  }

  const numeric: Array<[keyof ScreenCondition, string]> = [
    ["pctMin", "pct-min"],
    ["pctMax", "pct-max"],
    ["priceMin", "price-min"],
    ["priceMax", "price-max"],
    ["amountMin", "amount-min"],
    ["turnoverMin", "turnover-min"],
    ["marketCapMin", "market-cap-min"],
    ["marketCapMax", "market-cap-max"],
    ["ret5Min", "ret5-min"],
    ["ret20Min", "ret20-min"],
    ["ret20Max", "ret20-max"],
    ["nearHigh20Pct", "near-high20"],
  ];
  for (const [field, flag] of numeric) {
    const value = optionNumber(parsed.options, flag);
    if (value !== undefined) (condition as Record<string, unknown>)[field] = value;
  }

  for (const flag of ["above-ma5", "above-ma10", "above-ma20", "above-ma60"] as const) {
    if (parsed.options.has(flag)) {
      const field = flag.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
      (condition as Record<string, unknown>)[field] = true;
    }
  }

  if (parsed.options.has("include-st")) condition.excludeSt = false;

  const rank = parsed.options.get("rank");
  if (typeof rank === "string") {
    if (!(RANKS as string[]).includes(rank)) {
      throw new Error(`未知排序字段：${rank}（可选：${RANKS.join(" / ")}）`);
    }
    condition.rankBy = rank as RankField;
  }
  const order = parsed.options.get("order");
  if (typeof order === "string") {
    if (order !== "asc" && order !== "desc") throw new Error("--order 只能是 asc 或 desc");
    condition.order = order;
  }
  condition.limit = limitOf(parsed.options.get("limit"), 20, 50);
  const offset = optionNumber(parsed.options, "offset");
  if (offset !== undefined) condition.offset = Math.max(0, Math.floor(offset));
  return condition;
}

async function screenCommand(parsed: ParsedArgs): Promise<void> {
  const condition = conditionFrom(parsed);
  const loaded = await loadSnapshot({
    refresh: parsed.options.has("refresh"),
    onProgress: progressPrinter("已抓取", 1000),
  });
  if (process.stdout.isTTY) process.stdout.write("\r");

  const needsIndicators = screenNeedsIndicators(condition);
  const indicators = needsIndicators
    ? await loadIndicators({
        refresh: parsed.options.has("rebuild"),
        onProgress: progressPrinter("已计算指标", 500),
      })
    : new Map<string, Indicators>();
  if (needsIndicators && process.stdout.isTTY) process.stdout.write("\r");

  const result = screenStocks(loaded.snapshot, indicators, condition);
  if (jsonMode(parsed.options)) return printJson(result);
  process.stdout.write(`${formatScreen(result, { color: true })}\n`);
  process.stdout.write(
    `${ansi.gray}快照时间 ${loaded.snapshot.asOf.replace("T", " ").slice(0, 19)}` +
      ` · ${loaded.snapshot.session}${ansi.reset}\n`,
  );
}

async function boardsCommand(parsed: ParsedArgs): Promise<void> {
  const type = boardTypeOf(parsed.options.get("type"));
  const cached = readCache(BOARDS_CACHE, 7 * 24 * 60 * 60 * 1000);
  if (!cached) {
    process.stdout.write(`${ansi.gray}首次扫描板块清单（约 2000 个候选）…${ansi.reset}\n`);
  }
  const all = await loadBoards();
  const boards = type ? boardsByType(all, type) : all;

  if (parsed.options.has("quotes")) {
    const rows = await fetchBoardQuotes(boards);
    rows.sort((a, b) => b.quote.changePct - a.quote.changePct);
    const top = limitOf(parsed.options.get("top"), 10, 100);
    if (jsonMode(parsed.options)) return printJson(rows);
    process.stdout.write(
      `${ansi.bold}板块涨幅前 ${top}${ansi.reset} ${ansi.gray}（共 ${rows.length} 个板块）${ansi.reset}\n`,
    );
    for (const row of rows.slice(0, top)) {
      const sign = row.quote.changePct >= 0 ? ansi.red : ansi.green;
      process.stdout.write(
        `${padEnd(row.board.code, 8)}${padEnd(row.board.name, 16)}` +
          `${sign}${row.quote.changePct >= 0 ? "+" : ""}${row.quote.changePct.toFixed(2)}%${ansi.reset}\n`,
      );
    }
    return;
  }

  if (jsonMode(parsed.options)) return printJson(boards);
  process.stdout.write(
    `${ansi.bold}板块清单${ansi.reset} ${ansi.gray}（${boards.length} 个；--quotes 看涨跌幅）${ansi.reset}\n`,
  );
  for (const board of boards) {
    process.stdout.write(`${padEnd(board.code, 8)}${padEnd(board.name, 16)}${board.type}\n`);
  }
}

async function syncCommand(parsed: ParsedArgs): Promise<void> {
  const fast = parsed.options.has("fast");
  process.stdout.write(`${ansi.gray}扫描股票池（约 1.4 万个代码候选）…${ansi.reset}\n`);
  const stocks = await scanUniverse({ onProgress: progressPrinter("已探测") });
  if (stocks.length === 0) throw new Error("股票池扫描没有拿到任何数据。");
  writeCache(UNIVERSE_CACHE, stocks);
  if (process.stdout.isTTY) process.stdout.write("\r");

  let indicatorCount = 0;
  let failed = 0;
  if (!fast) {
    process.stdout.write(
      `${ansi.gray}预计算全市场指标（${stocks.length} 只 × 140 根日线，约 1-2 分钟）…${ansi.reset}\n`,

    );
    const built = await buildIndicators(
      stocks.map((stock) => stock.code),
      { onProgress: progressPrinter("已计算", 500) },
    );
    indicatorCount = built.items.length;
    failed = built.failed;
    writeCache(INDICATORS_CACHE, built.items);
    if (process.stdout.isTTY) process.stdout.write("\r");
  }

  const calendar = await loadTradingCalendar({ refresh: true });
  const summary = universeSummary(stocks);
  process.stdout.write(
    `${ansi.green}✓ 股票池${ansi.reset} ${stocks.length} 只（` +
      Object.entries(summary)
        .map(([board, count]) => `${board} ${count}`)
        .join(" · ") +
      `）· ST ${stocks.filter((stock) => stock.st).length} 只\n`,
  );
  if (!fast) {
    process.stdout.write(`${ansi.green}✓ 指标${ansi.reset} ${indicatorCount} 只（失败 ${failed}）\n`);
  }
  process.stdout.write(
    `${ansi.green}✓ 交易日历${ansi.reset} ${calendar.days.length} 天（${calendar.days[0]} ~ ` +
      `${calendar.days[calendar.days.length - 1]}）\n`,
  );
  process.stdout.write(`${ansi.gray}缓存目录：${getAShareHome()}/cache${ansi.reset}\n`);
}

async function statusCommand(parsed: ParsedArgs): Promise<void> {
  const universe = statCache(UNIVERSE_CACHE);
  const indicators = statCache(INDICATORS_CACHE);
  const snapshot = statCache(SNAPSHOT_CACHE);
  const calendar = statCache(CALENDAR_CACHE);
  const cachedUniverse = readCache<UniverseStock[]>(UNIVERSE_CACHE, Number.POSITIVE_INFINITY);
  const cachedIndicators = readCache<Indicators[]>(INDICATORS_CACHE, Number.POSITIVE_INFINITY);
  const cachedCalendar = readCache<TradingCalendar>(CALENDAR_CACHE, Number.POSITIVE_INFINITY);

  const service = aServiceStatus();
  const watch = loadWatchlist();
  const status = {
    home: getAShareHome(),
    service: {
      running: service.running,
      pid: service.state?.pid ?? null,
      paused: readPause().paused,
      nextRunAt: service.state?.nextRunAt ?? null,
      nextCheckAt: service.state?.nextCheckAt ?? null,
      queueSize: readScheduleQueue().length,
      rules: readRules().length,
      riskTriggered: readRiskState()?.triggered === true,
      riskLocks: readRiskState()?.locks.map((lock) => lock.code) ?? [],
      lastInspectAt: service.state?.lastInspectAt ?? null,
      lastInspectSummary: service.state?.lastInspectSummary ?? null,
      lastAction: service.state?.lastAction ?? null,
    },
    watchlist: watch.items.map((item) => ({
      code: item.code,
      name: item.name,
      score: item.score,
      source: item.source,
    })),
    universe: {
      ...universe,
      count: cachedUniverse?.value.length ?? 0,
      st: cachedUniverse?.value.filter((stock) => stock.st).length ?? 0,
    },
    indicators: { ...indicators, count: cachedIndicators?.value.length ?? 0 },
    snapshot,
    calendar: { ...calendar, days: cachedCalendar?.value.days.length ?? 0 },
    source: "d.10jqka.com.cn（免鉴权行情域）",
  };

  if (jsonMode(parsed.options)) return printJson(status);

  process.stdout.write(`${ansi.bold}A 股数据状态${ansi.reset}\n`);
  process.stdout.write(`  数据目录：${status.home}\n`);
  const line = (
    label: string,
    cache: { exists: boolean; updatedAt?: string },
    detail: string,
  ): void => {
    process.stdout.write(
      `  ${padEnd(label, 10)}${cache.exists ? `${ansi.green}已缓存${ansi.reset}` : `${ansi.yellow}未生成${ansi.reset}`}` +
        ` ${detail}` +
        `${cache.updatedAt ? `${ansi.gray}（更新于 ${cache.updatedAt}）${ansi.reset}` : ""}\n`,
    );
  };
  line("股票池", universe, `${status.universe.count} 只 · ST ${status.universe.st} 只`);
  line("指标", indicators, `${status.indicators.count} 只`);
  line("快照", snapshot, "");
  line("交易日历", calendar, `${status.calendar.days} 个交易日`);
  process.stdout.write(
    `  ${padEnd("巡检", 10)}${
      service.running
        ? `${ansi.green}运行中${ansi.reset}${ansi.gray} pid ${service.state?.pid} · 下一轮 ${formatLocalTime(service.state?.nextCheckAt, "monthday") !== "—" ? formatLocalTime(service.state?.nextCheckAt, "monthday") : "未排期"}${ansi.reset}`
        : `${ansi.yellow}未运行${ansi.reset}${ansi.gray}（xzh a serve）${ansi.reset}`
    }\n`,
  );
  process.stdout.write(
    `  ${padEnd("收盘选股", 10)}每交易日 16:00${service.state?.lastSelectDay ? ` · 上次 ${service.state.lastSelectDay}` : ""}\n`,
  );
  process.stdout.write(
    `  ${padEnd("监控规则", 10)}${readRules().length} 条` +
      `${ansi.gray} · 排期 ${readScheduleQueue().length} 条` +
      `${readPause().paused ? " · 已暂停" : ""}${ansi.reset}\n`,
  );
  process.stdout.write(
    `  ${padEnd("硬风控", 10)}${riskSummaryLines().join("；")}\n`,
  );
  process.stdout.write(
    `  ${padEnd("自选股", 10)}${watch.items.length}/10` +
      `${ansi.gray}${watch.items.length > 0 ? `：${watch.items.slice(0, 5).map((item) => `${item.code}(${item.score})`).join("、")}${watch.items.length > 5 ? " …" : ""}` : ""}${ansi.reset}\n`,
  );
  if (!universe.exists || !indicators.exists || !calendar.exists) {
    process.stdout.write(`${ansi.gray}缺失的缓存可运行 xzh a sync 建立。${ansi.reset}\n`);
  }
}

async function fkCommand(parsed: ParsedArgs): Promise<void> {
  const action = (parsed.positional[1] ?? "").toLowerCase();
  if (action === "reset") {
    const code = parsed.positional[2];
    const cleared = clearRiskTrigger(code);
    process.stdout.write(
      code
        ? cleared > 0
          ? `${ansi.green}✓ 已解除 ${code} 的单票硬风控${ansi.reset}（其他股票不受影响）\n`
          : `${ansi.yellow}${code} 当前没有单票锁${ansi.reset}\n`
        : `${ansi.green}✓ 已解除当日硬风控${ansi.reset}（账户级 + 全部单票锁）\n`,
    );
    return;
  }
  const settings = readRiskSettings();
  if (action === "") {
    const state = readRiskState();
    const lines = riskSummaryLines(state);
    process.stdout.write(
      `${ansi.bold}A 股硬风控${ansi.reset}\n` +
        `  当日亏损上限 ${settings.maxDailyLossPct}%\n` +
        `  单票亏损上限 ${settings.maxPositionLossPct}%（只锁触发的那只股票）\n` +
        `  连亏上限 ${settings.maxConsecutiveLosses} 笔\n` +
        `  状态：${lines
          .map((line) =>
            line === "正常" ? `${ansi.green}${line}${ansi.reset}` : `${ansi.red}${line}${ansi.reset}`,
          )
          .join("\n        ")}\n` +
        `${ansi.gray}修改：xzh a fk <当日> <单票> <连亏>；解除：xzh a fk reset [股票代码]${ansi.reset}\n`,
    );
    return;
  }
  const values = parsed.positional.slice(1).map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("用法：xzh a fk <当日亏损%> <单票亏损%> <连亏笔数>，或 xzh a fk reset");
  }
  writeRiskSettings({
    maxDailyLossPct: values[0],
    maxPositionLossPct: values[1],
    maxConsecutiveLosses: Math.round(values[2]),
  });
  process.stdout.write(
    `${ansi.green}✓ 已更新硬风控${ansi.reset}：当日 ${values[0]}% · 单票 ${values[1]}% · 连亏 ${Math.round(values[2])} 笔\n`,
  );
}

async function researchCommand(parsed: ParsedArgs): Promise<void> {
  const rawCodes = parsed.options.get("codes");
  const codes =
    typeof rawCodes === "string"
      ? rawCodes.split(",").map((code) => code.trim()).filter(Boolean)
      : defaultResearchCodes();
  const days = Number(parsed.options.get("days") ?? 120);
  const stop = String(parsed.options.get("stop") ?? "1.0,1.5,2.0")
    .split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const trail = String(parsed.options.get("trail") ?? "0.06,0.08,0.10")
    .split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const top = Number(parsed.options.get("top") ?? 5);
  const result = await runResearch({
    codes,
    days: Number.isFinite(days) ? days : 250,
    stopAtr: stop.length > 0 ? stop : [1.5],
    trail: trail.length > 0 ? trail : [0.08],
    maxPositions: Number.isFinite(top) ? top : 5,
  });
  if (jsonMode(parsed.options)) return printJson(result);
  if (!result.ok) {
    process.stdout.write(`${ansi.red}✗ 研究失败：${result.error}${ansi.reset}\n`);
    return;
  }
  process.stdout.write(
    `${ansi.bold}A 股离线研究${ansi.reset}${ansi.gray} 参数扫描 ${result.results?.length ?? 0} 组${ansi.reset}\n`,
  );
  for (const row of result.results ?? []) {
    process.stdout.write(
      `  ATR×${row.params.stop_atr} · 移动止盈 ${(row.params.trail_trigger * 100).toFixed(0)}%` +
        ` → 收益 ${row.returnPct >= 0 ? "+" : ""}${row.returnPct}% · 回撤 ${row.maxDrawdownPct}%` +
        ` · 胜率 ${row.winRatePct}% · ${row.trades} 笔\n`,
    );
  }
  if (result.best) {
    process.stdout.write(
      `${ansi.green}最佳：ATR×${result.best.params.stop_atr} / 移动止盈 ${(result.best.params.trail_trigger * 100).toFixed(0)}%` +
        ` → ${result.best.returnPct >= 0 ? "+" : ""}${result.best.returnPct}%${ansi.reset}\n`,
    );
  }
  if (result.report) process.stdout.write(`${ansi.gray}报告：${result.report}${ansi.reset}\n`);
  process.stdout.write(
    `${ansi.gray}说明：Python 离线回测只用于研究，不改变盘中巡检参数。${ansi.reset}\n`,
  );
}

async function serveCommand(parsed: ParsedArgs): Promise<void> {
  const action = (parsed.positional[1] ?? "start").toLowerCase();
  if (action === "run") {
    await runAServe();
    return;
  }
  if (action === "stop") {
    const result = await stopAService();
    process.stdout.write(
      result.ok
        ? `${ansi.green}✓ ${result.stopped ? "A 股巡检与监控已停止" : "A 股巡检与监控本来就没在运行"}${ansi.reset}\n`
        : `${ansi.red}✗ 停止失败：${result.error}${ansi.reset}\n`,
    );
    return;
  }

  const status = aServiceStatus();
  if (action === "status") {
    if (!status.running) {
      process.stdout.write(`${ansi.yellow}A 股巡检与监控未运行${ansi.reset}\n`);
      if (status.stale) process.stdout.write(`${ansi.gray}  有残留状态，下次启动会清理${ansi.reset}\n`);
      return;
    }
    const state = status.state!;
    process.stdout.write(
      `${ansi.green}A 股巡检与监控运行中${ansi.reset}${ansi.gray} pid ${state.pid} · ${state.version}` +
        ` · 自选 ${state.watchlist} 只 · 持仓 ${state.holdings} 只${ansi.reset}\n` +
        `${ansi.gray}  下一轮 ${formatLocalTime(state.nextRunAt, "monthday")}${state.lastAction ? ` · 最近：${state.lastAction}` : ""}${ansi.reset}\n` +
        `${ansi.gray}  日志 ${monitorLogPath()}${ansi.reset}\n`,
    );
    if (state.lastError) process.stdout.write(`${ansi.yellow}  最近错误：${state.lastError}${ansi.reset}\n`);
    return;
  }

  if (action !== "start" && action !== "") {
    process.stdout.write(`${ansi.red}未知操作：serve ${action}${ansi.reset}\n`);
    process.exitCode = 1;
    return;
  }
  if (status.running) {
    process.stdout.write(
      `${ansi.gray}A 股巡检与监控已在运行（pid ${status.state?.pid}）${ansi.reset}\n`,
    );
    return;
  }
  const result = await startAService();
  process.stdout.write(
    result.ok
      ? `${ansi.green}✓ A 股巡检与监控已启动${ansi.reset}${ansi.gray} pid ${result.state?.pid} · 工作日 09:00–15:30 · 监控 60 秒 / 巡检按排期 / 16:00 选股${ansi.reset}\n`
      : `${ansi.red}✗ 启动失败：${result.error}${ansi.reset}\n`,
  );
}

function printWatchlist(): void {
  const list = loadWatchlist();
  process.stdout.write(
    `${ansi.bold}A 股自选股${ansi.reset} ${ansi.gray}（${list.items.length}/10 · 全部纳入监控）${ansi.reset}\n`,
  );
  if (list.items.length === 0) {
    process.stdout.write(`${ansi.gray}  空；运行 xzh a serve 或 xzh a watch refresh 选股${ansi.reset}\n`);
    return;
  }
  for (const item of list.items) {
    process.stdout.write(
      `  ${item.code} ${padEnd(item.name, 10)} ${String(item.score).padStart(3)} 分` +
        `${ansi.gray}  ${item.source === "held" ? "持仓" : item.source === "manual" ? "手工" : "选股"} · ${item.reason}${ansi.reset}\n`,
    );
  }
}

async function watchCommand(parsed: ParsedArgs): Promise<void> {
  const action = (parsed.positional[1] ?? "list").toLowerCase();
  const code = parsed.positional[2];
  if (action === "list") {
    printWatchlist();
    return;
  }
  if (action === "add") {
    if (!code) throw new Error("用法：xzh a watch add <代码>");
    const quote = await fetchQuote(code);
    const result = addWatchItem({
      code: quote.code,
      name: quote.name,
      score: 0,
      reason: "手工添加",
      source: "manual",
      addedAt: new Date().toISOString(),
    });
    if (!result.ok) throw new Error(result.error);
    process.stdout.write(`${ansi.green}✓ 已加入自选股：${quote.code} ${quote.name}${ansi.reset}\n`);
    printWatchlist();
    return;
  }
  if (action === "remove") {
    if (!code) throw new Error("用法：xzh a watch remove <代码>");
    const result = removeWatchItem(code, heldCodes());
    if (!result.ok) throw new Error(result.error);
    process.stdout.write(`${ansi.green}✓ 已移除 ${code}${ansi.reset}\n`);
    printWatchlist();
    return;
  }
  if (action === "refresh") {
    const picks = await selectTopWatchlist(10, (message) =>
      process.stdout.write(`${ansi.gray}${message}${ansi.reset}\n`),
    );
    const held = loadPaperAccount().positions.map((position) => ({
      code: position.code,
      name: position.name,
    }));
    const merged = mergeWatchlist(picks, held);
    saveWatchlist(merged);
    process.stdout.write(`${ansi.green}✓ 已重选自选股${ansi.reset}\n`);
    printWatchlist();
    return;
  }
  throw new Error("用法：xzh a watch [list|add <代码>|remove <代码>|refresh]");
}

async function backtestCommand(parsed: ParsedArgs): Promise<void> {
  const rawCodes = parsed.options.get("codes");
  const codes =
    typeof rawCodes === "string"
      ? rawCodes
          .split(",")
          .map((code) => code.trim())
          .filter(Boolean)
      : loadWatchlist().items.map((item) => item.code);
  if (codes.length === 0) {
    throw new Error("自选股为空；先运行 xzh a watch refresh，或用 --codes 600519,300750 指定");
  }
  const days = Number(parsed.options.get("days") ?? 250);
  const top = Number(parsed.options.get("top") ?? 5);
  const pct = Number(parsed.options.get("pct") ?? 0.2);
  const result = await runBacktest({
    codes,
    days: Number.isFinite(days) ? days : 250,
    maxPositions: Number.isFinite(top) ? top : 5,
    positionPct: Number.isFinite(pct) ? pct : 0.2,
    marketGate: parsed.options.get("no-gate") === undefined,
    trailing: parsed.options.get("no-trail") === undefined,
    partialTake: parsed.options.get("partial") !== undefined,
  });
  if (jsonMode(parsed.options)) return printJson(result);
  process.stdout.write(
    `${ansi.bold}A 股日线回测${ansi.reset} ${result.start} ~ ${result.end}` +
      `${ansi.gray} · ${result.codes} 只 · ${result.days} 日${ansi.reset}\n`,
  );
  const pctText = (value: number): string =>
    `${value >= 0 ? ansi.red : ansi.green}${value >= 0 ? "+" : ""}${value.toFixed(2)}%${ansi.reset}`;
  process.stdout.write(
    `  收益 ${pctText(result.returnPct)} · 沪深300 ${pctText(result.benchmarkPct)}` +
      ` · 超额 ${pctText(result.returnPct - result.benchmarkPct)}\n`,
  );
  const closed = result.trades.filter((trade) => trade.side === "sell").length;
  process.stdout.write(
    `  最大回撤 ${ansi.green}${result.maxDrawdownPct.toFixed(2)}%${ansi.reset}` +
      ` · 胜率 ${closed > 0 ? `${result.winRatePct.toFixed(1)}%` : "—（无平仓）"}` +
      ` · 平均持有 ${result.avgHoldDays.toFixed(1)} 天` +
      ` · 交易 ${result.trades.length} 笔\n`,
  );
  process.stdout.write(
    `${ansi.gray}  说明：日线回测不含 30 分钟触发；用于比较门控 / ATR 止损 / 移动止盈 / 仓位参数。${ansi.reset}\n`,
  );
}

async function monitorCommand(parsed: ParsedArgs): Promise<void> {
  const action = (parsed.positional[1] ?? "once").toLowerCase();
  if (action !== "once") throw new Error("用法：xzh a monitor once");
  const result = await runManualInspection();
  if (result.actions.length === 0) {
    process.stdout.write(`${ansi.gray}巡检完成：无动作${ansi.reset}\n`);
    return;
  }
  for (const action of result.actions) {
    process.stdout.write(`  ${action}\n`);
  }
}

export async function aCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const [sub] = parsed.positional;
  try {
    switch (sub) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return;
      case "quote":
        await quoteCommand({ ...parsed, positional: parsed.positional.slice(1) });
        return;
      case "bars":
        await barsCommand({ ...parsed, positional: parsed.positional.slice(1) });
        return;
      case "intraday":
        await intradayCommand({ ...parsed, positional: parsed.positional.slice(1) });
        return;
      case "market":
        await marketCommand(parsed);
        return;
      case "snapshot":
        await snapshotCommand(parsed);
        return;
      case "screen":
        await screenCommand(parsed);
        return;
      case "boards":
        await boardsCommand(parsed);
        return;
      case "sync":
        await syncCommand(parsed);
        return;
      case "status":
        await statusCommand(parsed);
        return;
      case "serve":
        await serveCommand(parsed);
        return;
      // 与 btc 对齐的简写：xzh a stop / xzh a start
      case "stop":
        await serveCommand({ ...parsed, positional: ["a", "stop"] });
        return;
      case "start":
        await serveCommand({ ...parsed, positional: ["a", "start"] });
        return;
      case "pause": {
        const action = (parsed.positional[1] ?? "").toLowerCase();
        if (action === "status") {
          const pause = readPause();
          process.stdout.write(
            pause.paused
              ? `${ansi.yellow}⏸ A 股巡检已暂停${ansi.reset}（${pause.at ?? "?"}，/pause resume 恢复；进程仍在）\n`
              : `${ansi.green}A 股巡检运行中${ansi.reset}（/pause 暂停巡检与交易，进程仍在）\n`,
          );
          return;
        }
        if (action === "resume" || action === "on") {
          setPaused(false, "cli");
          process.stdout.write(`${ansi.green}✓ 已恢复 A 股巡检${ansi.reset}\n`);
          return;
        }
        setPaused(true, "cli");
        process.stdout.write(
          `${ansi.yellow}⏸ 已暂停 A 股巡检与交易${ansi.reset}${ansi.gray}（进程仍在；xzh a pause resume 恢复）${ansi.reset}\n`,
        );
        return;
      }
      case "fk":
        await fkCommand(parsed);
        return;
      case "watch":
        await watchCommand(parsed);
        return;
      case "monitor":
        await monitorCommand(parsed);
        return;
      case "backtest":
        await backtestCommand(parsed);
        return;
      case "research":
        await researchCommand(parsed);
        return;
      default:
        process.stdout.write(
          `${ansi.red}未知子命令：a ${sub}${ansi.reset}\n` +
            `${ansi.gray}可用：quote / bars / intraday / market / snapshot / screen / boards / sync / status / serve / watch / monitor${ansi.reset}\n`,
        );
        process.exitCode = 1;
    }
  } catch (err) {
    process.stdout.write(
      `${ansi.red}A 股数据获取失败：${err instanceof Error ? err.message : String(err)}${ansi.reset}\n`,
    );
    process.exitCode = 1;
  }
}

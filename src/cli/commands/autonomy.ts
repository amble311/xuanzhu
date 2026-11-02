import { loadConfig, saveConfig } from "../../config/store";
import {
  AUTONOMY_MODES,
  autonomyModeOf,
  observeLogPath,
  readObservedActions,
  type AutonomyMode,
} from "../../core/autonomy";
import { ansi } from "../../utils/ansi";
import { getConfigPath } from "../../utils/paths";

/**
 * `xzh autonomy` —— 查看 / 切换自治等级，以及读观察日志。
 *
 * 为什么要有命令行入口：`/autonomy` 只在 TUI 里可用，而 `observe` 恰恰是
 * **在非交互或自动化场景下最该用的一档**（脚本里跑 Agent、CI 里做回归），
 * 这些场景没有人能按下 `/autonomy`。另外观察日志也需要一个不进 TUI 就能看的地方。
 */

const LABEL: Record<AutonomyMode, string> = {
  auto: "全自动（写文件 / 执行命令直接执行）",
  ask: "逐项确认（危险操作先问）",
  observe: "观察（危险操作一律拦截并记录，只做只读调研）",
};

const BLOCKED = "write_file / edit_file / bash / bash_kill / device_run / device_push / device_stop";

function usage(): void {
  console.log(
    `${ansi.bold}用法${ansi.reset}
  ${ansi.green}xzh autonomy${ansi.reset}                 查看当前档位与最近拦截记录
  ${ansi.green}xzh autonomy ask|observe|auto${ansi.reset}  切换自治等级（写入配置 ${ansi.gray}autonomy${ansi.reset}）
  ${ansi.green}xzh autonomy log [N]${ansi.reset}           打印观察日志最近 N 条（默认 20）
  ${ansi.green}xzh autonomy path${ansi.reset}              打印观察日志路径

${ansi.gray}observe 档拦住的是：${BLOCKED}
读文件 / 搜索 / 读后台输出不受影响。${ansi.reset}`,
  );
}

export function autonomyCommand(args: string[] = []): void {
  const sub = (args[0] ?? "").trim();
  const cwd = process.cwd();
  const config = loadConfig();

  if (sub === "log") {
    const count = Number.parseInt(args[1] ?? "", 10);
    const limit = Number.isFinite(count) && count > 0 ? count : 20;
    const file = observeLogPath(cwd);
    const lines = readObservedActions(cwd, limit);
    if (lines.length === 0) {
      console.log(`${ansi.gray}还没有拦截记录（${file}）${ansi.reset}`);
      return;
    }
    console.log(
      `${ansi.bold}最近 ${lines.length} 条拦截记录${ansi.reset} ${ansi.gray}${file}${ansi.reset}`,
    );
    for (const line of lines) console.log(`  ${line}`);
    return;
  }

  if (sub === "path") {
    console.log(observeLogPath(cwd));
    return;
  }

  if (sub) {
    const mode = sub as AutonomyMode;
    if (!AUTONOMY_MODES.includes(mode)) {
      console.error(`${ansi.yellow}未知的自治等级：${sub}${ansi.reset}`);
      usage();
      process.exitCode = 1;
      return;
    }
    config.autonomy = mode;
    // 两个字段必须同步：`/auto on|off` 与旧配置读的是 autoApprove，
    // 各写一套会出现「界面说 auto、实际按 ask 跑」的分裂
    config.autoApprove = mode === "auto";
    saveConfig(config);
    console.log(`${ansi.green}✓ 自治等级：${mode}${ansi.reset} — ${LABEL[mode]}`);
    console.log(`${ansi.gray}  写入 ${getConfigPath()}${ansi.reset}`);
    if (mode === "observe") {
      console.log(
        `${ansi.gray}  拦截记录：${observeLogPath(cwd)}（xzh autonomy log 查看）${ansi.reset}`,
      );
    }
    return;
  }

  const mode = autonomyModeOf(config);
  console.log(`${ansi.bold}自治等级${ansi.reset}：${mode} — ${LABEL[mode]}`);
  for (const item of AUTONOMY_MODES) {
    const mark = item === mode ? `${ansi.green}→${ansi.reset}` : " ";
    console.log(`  ${mark} ${item.padEnd(8)} ${ansi.gray}${LABEL[item]}${ansi.reset}`);
  }
  console.log(`${ansi.gray}  · observe 拦截：${BLOCKED}${ansi.reset}`);
  console.log(`${ansi.gray}  · 观察日志：${observeLogPath(cwd)}${ansi.reset}`);

  if (mode === "observe") {
    const recent = readObservedActions(cwd, 5);
    if (recent.length > 0) {
      console.log(`\n${ansi.bold}最近被拦截的操作${ansi.reset}`);
      for (const line of recent) console.log(`${ansi.gray}  · ${line}${ansi.reset}`);
    }
  }
}

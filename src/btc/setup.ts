import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ansi } from "../utils/ansi";
import { getBtcHome } from "../utils/paths";
import {
  btcPythonPath,
  btcVenvMarkPath,
  ensureBtcAssets,
} from "./bootstrap";

/**
 * btc 计算环境的准备（建 venv + 装 numpy / pandas）。
 *
 * 两处调用、同一套实现：
 * - 首次进入 `xzh btc` 时**自动**执行（新手不该先读一段「请手动运行 setup」）；
 * - `xzh btc setup` 手动重跑（修环境 / `--force` 重装）。
 *
 * 必须在 TUI 接管终端**之前**调用：pip 的进度要能正常显示，进了备用屏就看不见了。
 */

const REQUIREMENTS = ["numpy>=2.0", "pandas>=2.2"];

export interface BtcSetupResult {
  ok: boolean;
  /** 已经就绪、本次没有做任何事 */
  skipped?: boolean;
  error?: string;
}

function run(
  command: string,
  args: string[],
  cwd: string,
): { ok: boolean; error?: string } {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: `${command} 退出码 ${result.status ?? "?"}` };
  }
  return { ok: true };
}

/** venv 里的 numpy / pandas 是否真能导入（venv 存在 ≠ 依赖装好） */
function venvImportable(python: string): boolean {
  const check = spawnSync(python, ["-c", "import numpy, pandas"], {
    encoding: "utf8",
  });
  return check.status === 0;
}

/** 写「环境就绪」标记：启动路径据此跳过整套检查（见 btcSetupNeeded） */
function markReady(home: string): void {
  try {
    fs.writeFileSync(btcVenvMarkPath(home), `${new Date().toISOString()}\n`, "utf8");
  } catch {
    // 标记写不了不影响使用，下次启动会再检查一遍
  }
}

export interface BtcSetupOptions {
  /** 删掉 venv 重装 */
  force?: boolean;
}

export async function setupBtcEnv(
  options: BtcSetupOptions = {},
): Promise<BtcSetupResult> {
  const home = getBtcHome();

  process.stdout.write(`\n${ansi.bold}btc 模式环境准备${ansi.reset}\n`);
  process.stdout.write(`${ansi.gray}工作目录：${home}${ansi.reset}\n\n`);

  // --force 时连同脚本一起强制重新释放（默认只按内容指纹增量同步）
  const assets = ensureBtcAssets(home, { force: options.force });
  if (!assets.available) {
    return {
      ok: false,
      error:
        `找不到 btc 计算资产：${assets.assetsDir}\n` +
        "  通常表示安装包不完整，请重新安装 xuanzhu。",
    };
  }
  process.stdout.write(
    assets.copied
      ? `${ansi.green}✓${ansi.reset} 计算脚本已释放到 ${home}\n`
      : `${ansi.green}✓${ansi.reset} 计算脚本已是最新（${home}）\n`,
  );

  const python = btcPythonPath(home);
  // 显式指定解释器时不碰 venv：那是用户在管的环境（测试 / 容器 / 已有环境）
  if (process.env.XZH_BTC_PYTHON?.trim()) {
    process.stdout.write(
      `${ansi.green}✓${ansi.reset} 使用 XZH_BTC_PYTHON 指定的解释器（跳过 venv）\n\n`,
    );
    return { ok: true, skipped: true };
  }

  if (fs.existsSync(python) && !options.force) {
    if (venvImportable(python)) {
      markReady(home);
      process.stdout.write(
        `${ansi.green}✓${ansi.reset} 计算环境已就绪（重装请运行 xzh btc setup --force）\n\n`,
      );
      return { ok: true, skipped: true };
    }
    process.stdout.write(
      `${ansi.yellow}⚠ venv 存在但缺少 numpy / pandas，继续安装${ansi.reset}\n`,
    );
  }

  const basePython =
    process.env.XZH_PYTHON?.trim() ||
    (spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0
      ? "python3"
      : "");
  if (!basePython) {
    return {
      ok: false,
      error:
        "找不到 python3。请先安装 Python 3.10+，或用 XZH_PYTHON 指定解释器路径。",
    };
  }

  if (!fs.existsSync(python) || options.force) {
    process.stdout.write(`${ansi.gray}创建 venv：${home}/venv${ansi.reset}\n`);
    if (options.force) {
      fs.rmSync(path.join(home, "venv"), { recursive: true, force: true });
    }
    const created = run(basePython, ["-m", "venv", path.join(home, "venv")], home);
    if (!created.ok) {
      return {
        ok: false,
        error:
          `创建 venv 失败：${created.error}\n` +
          "  Debian/Ubuntu 可能需要先装 python3-venv。",
      };
    }
  }

  process.stdout.write(
    `${ansi.gray}安装依赖：${REQUIREMENTS.join(" ")}（一次性，约 30MB）${ansi.reset}\n`,
  );
  const installed = run(python, ["-m", "pip", "install", ...REQUIREMENTS], home);
  if (!installed.ok) {
    return {
      ok: false,
      error:
        `安装失败：${installed.error}\n` +
        `  大陆网络可先 \`xzh vpn\` 配代理，或手动：${python} -m pip install ${REQUIREMENTS.join(" ")}`,
    };
  }

  const verify = spawnSync(
    python,
    [
      "-c",
      "import numpy, pandas; print(f'numpy {numpy.__version__} · pandas {pandas.__version__}')",
    ],
    { encoding: "utf8" },
  );
  if (verify.status !== 0) {
    return {
      ok: false,
      error: `依赖已安装但导入失败：${(verify.stderr || "").trim()}`,
    };
  }

  markReady(home);
  process.stdout.write(
    `${ansi.green}✓ 计算环境就绪${ansi.reset} ${ansi.gray}(${verify.stdout.trim()})${ansi.reset}\n\n`,
  );
  return { ok: true };
}

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getBtcHome, getBuiltinAssetsDir } from "../utils/paths";
import { VERSION } from "../utils/version";

/**
 * btc 模式的 Python 计算层落盘（bootstrap）。
 *
 * 为什么不在 `dist` 里直接跑：计算层要读写 `~/.btc/data/btc.db`、加载 `~/.btc/.env`，
 * 而 `core/config.py` 是按**自身位置**推项目根的（`parent.parent`）。把它放到
 * `<home>/core/` 之后，所有路径自动对齐到用户数据目录，一份代码只服务一处数据。
 *
 * ## 同步依据是**内容指纹**，不是版本号
 *
 * 早期按 `VERSION` 判断：「版本号没变就跳过复制」。这在开发期直接踩坑 ——
 * 一个版本里加了 `paper.py`、给 `runner.py` 添了 `paper-status` 命令，
 * 但 `package.json` 还没升版本，于是 `~/.btc` 里永远是旧脚本，
 * 面板报「未知命令：paper-status」，看起来像「模拟盘没初始化」。
 *
 * 现在改为遍历资产算 SHA-1 指纹（十几个小文件，耗时 < 5ms），
 * 指纹一致才跳过。复制只覆盖**资产文件**：`data/`、`logs/`、`.env`、`venv/`、`run/`
 * 都只在用户的 home 里，资产目录里没有，因此不会被覆盖或删除。
 */

const ASSET_SOURCE = "btc";
const STAMP_FILE = ".bootstrap.json";

export interface BtcAssetsResult {
  home: string;
  /** 资产源目录（`dist/assets/btc`，开发态为仓库 `assets/btc`） */
  assetsDir: string;
  /** 本次是否真的复制了 */
  copied: boolean;
  /** 资产是否找到（打包漏了 assets 时为 false） */
  available: boolean;
}

interface Stamp {
  version?: string;
  at?: string;
  /** 上次同步时每个资产文件的指纹（相对路径 → sha1 前缀） */
  files?: Record<string, string>;
}

export interface EnsureAssetsOptions {
  /** 忽略指纹强制重新复制（`xzh btc setup --force`） */
  force?: boolean;
  /** 资产源目录（测试用可注入；默认取打包/仓库里的 assets/btc） */
  assetsDir?: string;
}

function readStamp(file: string): Stamp | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Stamp;
  } catch {
    return null;
  }
}

/**
 * 计算层使用的 python 解释器。
 *
 * 优先 `XZH_BTC_PYTHON`（已有一套装好 numpy/pandas 的环境时不必再建 venv，
 * 测试与容器里也用得上），否则用 `~/.btc/venv`。
 */
export function btcPythonPath(home = getBtcHome()): string {
  const override = process.env.XZH_BTC_PYTHON?.trim();
  if (override) return override;
  return path.join(home, "venv", "bin", "python");
}

export function btcVenvReady(home = getBtcHome()): boolean {
  // 显式指定的解释器可能只是个命令名（PATH 里找），不按路径判断存在性；
  // 真不可用会在 spawn 时给出「无法启动 python」。
  if (process.env.XZH_BTC_PYTHON?.trim()) return true;
  return fs.existsSync(btcPythonPath(home));
}

/** 计算脚本是否已就位（runner.py 在 home 根） */
export function btcScriptsReady(home = getBtcHome()): boolean {
  return fs.existsSync(path.join(home, "runner.py"));
}

/** venv 就绪标记：setup 成功（含「已验证可导入」）后写入，启动路径只查它，不每次都起 python */
export function btcVenvMarkPath(home = getBtcHome()): string {
  return path.join(home, ".venv-ready");
}

/**
 * 进入模式时是否需要跑环境准备。
 *
 * 判断刻意**只看标记文件**而不是每次 `python -c "import numpy"`：
 * 启动路径上多起一个解释器要 100–200ms，而 `xzh btc` 是高频入口。
 * 依赖被手动破坏的情况由工具层报错，用户 `xzh btc setup --force` 即可修好。
 */
export function btcSetupNeeded(home = getBtcHome()): boolean {
  if (process.env.XZH_BTC_PYTHON?.trim()) return false; // 外部环境由用户负责
  if (!btcScriptsReady(home)) return true;
  return !fs.existsSync(btcVenvMarkPath(home));
}

/** 递归列出资产文件（相对路径），跳过 `__pycache__` 与 `.pyc` */
function listAssetFiles(dir: string, base = dir): string[] {
  const result: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listAssetFiles(full, base));
    } else if (entry.isFile()) {
      result.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return result;
}

/** 资产内容指纹：文件名 + 内容哈希 */
function fingerprintAssets(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const relative of listAssetFiles(dir)) {
    try {
      // 按 utf8 读成字符串再哈希：这些资产都是文本（.py），
      // 而新版 @types/node 里 Buffer 传给 hash.update 有 ArrayBufferLike 兼容问题。
      const content = fs.readFileSync(path.join(dir, relative), "utf8");
      files[relative] = crypto
        .createHash("sha1")
        .update(content, "utf8")
        .digest("hex")
        .slice(0, 16);
    } catch {
      // 读不了就跳过：下次同步会补上，不该让整个 bootstrap 失败
    }
  }
  return files;
}

function sameFingerprint(
  a: Record<string, string> | undefined,
  b: Record<string, string>,
): boolean {
  if (!a) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}

/**
 * 确保 `~/.btc` 下是**当前版本**的计算脚本；返回是否可用。
 *
 * 只做本地文件复制（毫秒级），**不建 venv、不联网** —— 因此可以安全地在启动时调用。
 * venv 与依赖安装是显式操作（`xzh btc setup`），因为它要下载几十 MB。
 */
export function ensureBtcAssets(
  home = getBtcHome(),
  options: EnsureAssetsOptions = {},
): BtcAssetsResult {
  const assetsDir =
    options.assetsDir ?? path.join(getBuiltinAssetsDir(), ASSET_SOURCE);
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });

  if (!fs.existsSync(path.join(assetsDir, "runner.py"))) {
    return { home, assetsDir, copied: false, available: false };
  }

  const stampPath = path.join(home, STAMP_FILE);
  const stamp = readStamp(stampPath);
  const current = fingerprintAssets(assetsDir);

  if (!options.force && sameFingerprint(stamp?.files, current) && btcScriptsReady(home)) {
    return { home, assetsDir, copied: false, available: true };
  }

  // 上一版存在、这一版已经删掉的资产文件：清掉。
  // 只删 stamp 里记录过的路径 —— 用户数据（db/日志/.env/venv）从来不在清单里，
  // 所以不会误删；不清理的话，残留的旧模块可能被 import 到。
  for (const relative of Object.keys(stamp?.files ?? {})) {
    if (current[relative]) continue;
    try {
      fs.rmSync(path.join(home, relative), { force: true });
    } catch {
      // 删不掉只影响整洁性，不阻断同步
    }
  }

  fs.cpSync(assetsDir, home, { recursive: true, force: true });
  fs.writeFileSync(
    stampPath,
    `${JSON.stringify(
      { version: VERSION, at: new Date().toISOString(), files: current },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { home, assetsDir, copied: true, available: true };
}

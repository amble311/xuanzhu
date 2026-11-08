import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * 玄猪的全局目录，默认 `~/.xzh`。
 *
 * 内部按**生命周期**分成五类（布局版本 2）：
 *
 * ```text
 * ~/.xzh/
 * ├── config/    config.json、skills.json（可备份 / 可同步）
 * ├── data/      skills/、memory/、sessions/、backups/、apks/（用户内容）
 * ├── state/     errors/、crash.log、keys.log（诊断，可清）
 * ├── cache/     可随时删的缓存（目前未使用，预留给模型下载等）
 * ├── runtime/   session.lock（运行时标记）
 * └── vault/     凭据密文（0700，不参与同步）
 * ```
 *
 * 旧的平铺布局（`~/.xzh/config.json` 等）由 `migrateConfigLayout()` 一次性搬进子目录。
 *
 * 与具体项目相关的数据一律放在项目目录下的 `.xuanzhu/`（见 src/workspace/index.ts）：
 * 项目记忆按天分存于 `<项目>/.xuanzhu/memory/YYYY-MM-DD.md`，长期记忆在 `MEMORY.md`。
 *
 * 可用环境变量 `XZH_HOME` 整体重定向，它指向**该目录本身**（不是家目录）：
 *
 * ```bash
 * XZH_HOME=/tmp/xzh-test xzh config   # 配置落在 /tmp/xzh-test/config/config.json
 * ```
 *
 * 用途：多环境并行（本机 / 远程 / 容器各持一份配置互不干扰），
 * 以及自动化测试时彻底隔离，避免写到用户的真实配置。
 */
export function getConfigDir(): string {
  const override = process.env.XZH_HOME?.trim();
  if (override) return path.resolve(expandHome(override));
  return path.join(os.homedir(), ".xzh");
}

/** 全局目录布局版本；旧布局迁移完成后写入 `config/layout.json` */
export const XZH_LAYOUT_VERSION = 2;

/** 全局目录下的分类子目录（不存在时由调用方按需创建） */
export function getConfigSubdir(): string {
  return path.join(getConfigDir(), "config");
}

export function getDataSubdir(): string {
  return path.join(getConfigDir(), "data");
}

export function getStateSubdir(): string {
  return path.join(getConfigDir(), "state");
}

export function getCacheSubdir(): string {
  return path.join(getConfigDir(), "cache");
}

export function getRuntimeSubdir(): string {
  return path.join(getConfigDir(), "runtime");
}

/** 凭据密文目录：保持在全局根下，权限 0700，明确不参与同步 */
export function getVaultDir(): string {
  return path.join(getConfigDir(), "vault");
}

/** 是否由 `XZH_HOME` 显式指定了全局目录 */
export function isConfigDirOverridden(): boolean {
  return Boolean(process.env.XZH_HOME?.trim());
}

export interface ModeHomeOptions {
  /** 环境变量显式指定的目录（优先于一切） */
  override?: string;
  /** 当前默认目录名（相对 home） */
  current: string;
  /** 旧版默认目录名（相对 home）：存在且新目录不存在时继续沿用 */
  legacy: string;
  /** 目录是否存在（测试注入） */
  exists?: (target: string) => boolean;
}

/**
 * 模式数据目录解析：显式 env > 新默认（已存在）> 旧默认（已存在）> 新默认。
 *
 * 为什么**不自动搬迁**旧目录：btc 的 venv 与行情库里有绝对路径，目录一搬就可能坏；
 * 旧目录原样沿用最安全，用户想换可以手动搬或设环境变量。
 */
export function resolveModeHomeDir(homeRoot: string, options: ModeHomeOptions): string {
  const override = options.override?.trim();
  if (override) return path.resolve(expandHome(override));
  const exists =
    options.exists ??
    ((target: string) => {
      try {
        return fs.existsSync(target);
      } catch {
        return false;
      }
    });
  const current = path.join(homeRoot, options.current);
  if (exists(current)) return current;
  const legacy = path.join(homeRoot, options.legacy);
  if (exists(legacy)) return legacy;
  return current;
}

/**
 * btc 模式的数据目录，默认 `~/.xzh_btc`（旧版 `~/.btc` 存在时自动沿用）。
 *
 * 可用 `XZH_BTC_HOME` 重定向（测试隔离 / 多环境 / 数据放盘）。
 * **刻意不跟随 `XZH_HOME`**：那是玄猪的全局配置（模型、技能开关），
 * 而这里是交易数据（行情库、日志、计算脚本、venv），归属不同。
 */
export function getBtcHome(): string {
  return resolveModeHomeDir(os.homedir(), {
    override: process.env.XZH_BTC_HOME,
    current: ".xzh_btc",
    legacy: ".btc",
  });
}

/**
 * A 股模式的数据目录，默认 `~/.xzh_a`（旧版 `~/.a` 存在时自动沿用）。
 *
 * 与 btc 同理：这里是 A 股行情缓存、股票池与（将来的）模拟账本，
 * **不跟随 `XZH_HOME`**（那是玄猪的全局配置）。
 */
export function getAShareHome(): string {
  return resolveModeHomeDir(os.homedir(), {
    override: process.env.XZH_A_HOME,
    current: ".xzh_a",
    legacy: ".a",
  });
}

/** 旧版全局目录：~/.xuanzhu（v0.1.0 及更早使用，仅供迁移检测） */
export function getLegacyConfigDir(): string {
  return path.join(os.homedir(), ".xuanzhu");
}

/** 主配置文件路径：~/.xzh/config/config.json */
export function getConfigPath(): string {
  return path.join(getConfigSubdir(), "config.json");
}

/** 技能启用状态：~/.xzh/config/skills.json */
export function getSkillStatePath(): string {
  return path.join(getConfigSubdir(), "skills.json");
}

/** 会话历史：~/.xzh/data/sessions */
export function getSessionsDir(): string {
  return path.join(getDataSubdir(), "sessions");
}

/** /undo 快照：~/.xzh/data/backups */
export function getBackupsDir(): string {
  return path.join(getDataSubdir(), "backups");
}

/** 设备桥 APK 缓存：~/.xzh/data/apks */
export function getApksDir(): string {
  return path.join(getDataSubdir(), "apks");
}

/** 全局长期记忆：~/.xzh/data/memory */
export function getGlobalMemoryDir(): string {
  return path.join(getDataSubdir(), "memory");
}

/** 错误报告：~/.xzh/state/errors */
export function getErrorsDir(): string {
  return path.join(getStateSubdir(), "errors");
}

/** 崩溃日志：~/.xzh/state/crash.log */
export function getCrashLogPath(): string {
  return path.join(getStateSubdir(), "crash.log");
}

/** 调试按键日志：~/.xzh/state/keys.log */
export function getKeysLogPath(): string {
  return path.join(getStateSubdir(), "keys.log");
}

/** 会话锁文件：~/.xzh/runtime/session.lock */
export function getSessionLockPath(): string {
  return path.join(getRuntimeSubdir(), "session.lock");
}

/** 内置技能目录（随分发包，打包后位于 dist/skills） */
export function getBuiltinSkillsDir(): string {
  return path.join(__dirname, "skills");
}

/** 用户自定义技能目录：~/.xzh/data/skills */
export function getUserSkillsDir(): string {
  return path.join(getDataSubdir(), "skills");
}

/**
 * 随包分发的**运行资产**目录（打包后为 `dist/assets`）。
 *
 * 与技能不同：技能是给模型看的说明文档，资产是**要被执行/复制出去的东西**
 * （例如 btc 模式的 Python 计算层）。它们不能直接从 `dist` 里跑 —— 计算层要落到
 * 用户的数据目录、连同它的 venv 与数据库一起工作，因此由 bootstrap 复制到
 * `<模式 home>` 下。
 *
 * 开发态（`ts-node` / vitest / 未构建）没有 `dist/assets`，回退到仓库根的 `assets/`，
 * 否则这些代码在测试里会找不到文件。
 */
export function getBuiltinAssetsDir(): string {
  const packaged = path.join(__dirname, "assets");
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "..", "..", "assets");
}

/**
 * 旧全局目录迁移：`~/.xuanzhu` → `~/.xzh`。
 *
 * 只在**新目录不存在且旧目录存在**时执行一次，避免覆盖已有数据。
 * 先尝试 rename（同分区时瞬间完成），失败则退化为「复制 + 删除」。
 * 迁移失败不影响启动，因此这里吞掉异常，仅通过返回值告知调用方用于提示。
 */
export function migrateLegacyConfigDir(): {
  migrated: boolean;
  from?: string;
  to?: string;
} {
  // 用 XZH_HOME 显式指定目录时不做迁移：那是一个「全新」的位置，
  // 把家目录里的旧数据搬进去只会造成困惑（甚至覆盖用户特意隔离的配置）。
  if (isConfigDirOverridden()) return { migrated: false };

  const from = getLegacyConfigDir();
  const to = getConfigDir();
  if (path.resolve(from) === path.resolve(to)) return { migrated: false };

  try {
    if (fs.existsSync(to) || !fs.existsSync(from)) return { migrated: false };
  } catch {
    return { migrated: false };
  }

  try {
    fs.renameSync(from, to);
    return { migrated: true, from, to };
  } catch {
    // 跨设备（EXDEV）等情况退化处理，见下
  }

  // 先复制到**同目录下的临时路径**，成功后原子改名就位。
  // 若直接 cpSync 到最终位置，中途失败（磁盘满 / 权限 / 并发）会留下一个半成品的
  // ~/.xzh，此后 existsSync(to) 恒为真，迁移被永久跳过，而里面的 config.json
  // 可能是缺失或半截的 —— 用户的 provider / API Key 就此静默消失且无法自愈。
  const staging = `${to}.migrating-${process.pid}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(from, staging, { recursive: true });
    fs.renameSync(staging, to);
  } catch {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // 清理失败也不影响后续启动
    }
    return { migrated: false };
  }

  // 复制成功后才删除源目录；删不掉不算失败（数据已在目标位置）
  try {
    fs.rmSync(from, { recursive: true, force: true });
  } catch {
    // 忽略
  }

  return { migrated: true, from, to };
}

/** 旧平铺布局 → 分类子目录的搬迁表（源相对全局根，目标相对全局根） */
const LAYOUT_MOVES: Array<[string, string]> = [
  ["config.json", "config/config.json"],
  ["skills.json", "config/skills.json"],
  ["skills", "data/skills"],
  ["memory", "data/memory"],
  ["sessions", "data/sessions"],
  ["backups", "data/backups"],
  ["apks", "data/apks"],
  ["errors", "state/errors"],
  ["crash.log", "state/crash.log"],
  ["keys.log", "state/keys.log"],
  ["session.lock", "runtime/session.lock"],
];

export interface ConfigLayoutMigration {
  migrated: boolean;
  /** 实际搬动的条目（`旧 → 新`），供启动提示与排查 */
  moved: string[];
}

function movePath(source: string, target: string): boolean {
  try {
    if (!fs.existsSync(source) || fs.existsSync(target)) return false;
  } catch {
    return false;
  }
  ensureDir(path.dirname(target));
  try {
    fs.renameSync(source, target);
    return true;
  } catch {
    // 跨设备（EXDEV）或 Windows 占用：退化为复制 + 删除
    try {
      fs.cpSync(source, target, { recursive: true });
      fs.rmSync(source, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 全局目录布局迁移：把旧平铺条目搬进 `config/ data/ state/ runtime/`。
 *
 * 幂等：源不存在或目标已存在时跳过（不覆盖任何已有数据）。失败只影响那一条，
 * 不会阻止启动；`vault/` 刻意保持在全局根下（权限与同步策略与其它目录不同）。
 */
export function migrateConfigLayout(): ConfigLayoutMigration {
  const root = getConfigDir();
  const moved: string[] = [];
  try {
    if (!fs.existsSync(root)) return { migrated: false, moved };
  } catch {
    return { migrated: false, moved };
  }

  for (const [fromRel, toRel] of LAYOUT_MOVES) {
    if (movePath(path.join(root, fromRel), path.join(root, toRel))) {
      moved.push(`${fromRel} → ${toRel}`);
    }
  }

  // config.json 的历史备份（config.json.bak-<时间戳>）一并收进 config/
  try {
    for (const name of fs.readdirSync(root)) {
      if (!/^config\.json\.bak-/.test(name)) continue;
      if (movePath(path.join(root, name), path.join(getConfigSubdir(), name))) {
        moved.push(`${name} → config/${name}`);
      }
    }
  } catch {
    // 读不了根目录就跳过
  }

  if (moved.length > 0) {
    try {
      ensureDir(getConfigSubdir());
      fs.writeFileSync(
        path.join(getConfigSubdir(), "layout.json"),
        `${JSON.stringify(
          { version: XZH_LAYOUT_VERSION, migratedAt: new Date().toISOString() },
          null,
          2,
        )}\n`,
      );
    } catch {
      // 标记文件写不了不影响使用
    }
  }

  return { migrated: moved.length > 0, moved };
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 将 ~ 展开为 home 目录 */
export function expandHome(input: string): string {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * 玄猪的全局目录，默认 `~/.xzh`。
 *
 * 这里只存**全局通用**的内容：`config.json`（唯一的模型配置）与 `skills/`（用户自定义技能）。
 * 与具体项目相关的数据一律放在项目目录下的 `.xuanzhu/`（见 src/workspace/index.ts）：
 * 项目记忆按天分存于 `<项目>/.xuanzhu/memory/YYYY-MM-DD.md`，长期记忆在 `MEMORY.md`。
 *
 * 全局与项目职责分离，且**目录名不同**（`~/.xzh` vs `<项目>/.xuanzhu`），
 * 因此不存在把 $HOME 当项目路径时两者互相覆盖的问题。
 *
 * 可用环境变量 `XZH_HOME` 整体重定向，它指向**该目录本身**（不是家目录）：
 *
 * ```bash
 * XZH_HOME=/tmp/xzh-test xzh config   # 配置落在 /tmp/xzh-test/config.json
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

/** 是否由 `XZH_HOME` 显式指定了全局目录 */
export function isConfigDirOverridden(): boolean {
  return Boolean(process.env.XZH_HOME?.trim());
}

/** 旧版全局目录：~/.xuanzhu（v0.1.0 及更早使用，仅供迁移检测） */
export function getLegacyConfigDir(): string {
  return path.join(os.homedir(), ".xuanzhu");
}

/** 主配置文件路径：~/.xzh/config.json */
export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

/** 内置技能目录（随分发包，打包后位于 dist/skills） */
export function getBuiltinSkillsDir(): string {
  return path.join(__dirname, "skills");
}

/** 用户自定义技能目录：~/.xzh/skills */
export function getUserSkillsDir(): string {
  return path.join(getConfigDir(), "skills");
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

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ensureDir, getConfigDir } from "./paths";

/**
 * 文件修改的**撤销快照**。
 *
 * write_file / edit_file 在真正写盘前调用 `snapshotForUndo()` 把改动前的内容
 * 拷贝到 `~/.xzh/backups/<项目>-<哈希>/`，并以 JSONL 清单按序记录；
 * `/undo` 弹出最近一条记录恢复原内容。
 *
 * 为什么不用 git：项目可能根本不是 git 仓库，也可能有大量未提交改动 ——
 * 快照只覆盖「玄猪改过的文件」，与用户的版本控制互不干扰。
 *
 * 只保留最近 `MAX_UNDO_STEPS` 条（超出的连同备份文件一起清理），
 * 避免长期使用后 backups 目录无限膨胀。
 */

const MAX_UNDO_STEPS = 50;

/** 快照文件名的单调序号：时间戳只有毫秒精度，同一毫秒内连续快照会同名互相覆盖 */
let snapshotSeq = 0;

interface UndoEntry {
  /** 被修改文件的绝对路径 */
  file: string;
  /** 改动前内容的快照文件名；`null` 表示该文件是**新建**的（撤销 = 删除它） */
  backup: string | null;
  time: string;
}

/** 备份目录按项目隔离：cwd 的 sha1 前 10 位 + 目录名，避免不同项目互相覆盖 */
function backupDirFor(cwd: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(path.resolve(cwd))
    .digest("hex")
    .slice(0, 10);
  const name = path.basename(cwd) || "project";
  return path.join(getConfigDir(), "backups", `${name}-${hash}`);
}

function manifestPath(cwd: string): string {
  return path.join(backupDirFor(cwd), "manifest.jsonl");
}

function readManifest(cwd: string): UndoEntry[] {
  try {
    const raw = fs.readFileSync(manifestPath(cwd), "utf8");
    const entries: UndoEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<UndoEntry>;
        if (typeof parsed.file === "string") {
          entries.push({
            file: parsed.file,
            backup: typeof parsed.backup === "string" ? parsed.backup : null,
            time: typeof parsed.time === "string" ? parsed.time : "",
          });
        }
      } catch {
        // 单行损坏跳过，不影响其余记录
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function writeManifest(cwd: string, entries: UndoEntry[]): void {
  ensureDir(backupDirFor(cwd));
  // 超出保留条数时丢最旧的，并删掉对应的备份文件（清单行没了，快照就是孤儿）
  while (entries.length > MAX_UNDO_STEPS) {
    const oldest = entries.shift();
    if (oldest?.backup) {
      try {
        fs.rmSync(path.join(backupDirFor(cwd), oldest.backup), { force: true });
      } catch {
        // 清理失败不影响主流程
      }
    }
  }
  fs.writeFileSync(
    manifestPath(cwd),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}

/**
 * 在修改文件**之前**调用：把当前内容存为快照并登记到清单。
 * 文件不存在（本次是新建）时登记 `backup: null`，撤销时删除该文件。
 * 任何失败都静默吞掉 —— 备份是锦上添花，绝不能阻断真正的写操作。
 */
export function snapshotForUndo(target: string, cwd: string): void {
  try {
    ensureDir(backupDirFor(cwd));
    const entries = readManifest(cwd);
    let backup: string | null = null;
    if (fs.existsSync(target)) {
      // 只给**普通文件**做快照：对 `/dev/zero`、无写者的 FIFO 调 `copyFileSync`
      // 会永久阻塞，而外层 try/catch 兜不住「挂住」——它根本不抛错。
      let snapshottable = false;
      try {
        snapshottable = fs.statSync(target).isFile();
      } catch {
        snapshottable = false;
      }
      if (snapshottable) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        backup = `${path.basename(target)}.${stamp}-${++snapshotSeq}.bak`;
        fs.copyFileSync(target, path.join(backupDirFor(cwd), backup));
      }
    }
    entries.push({ file: target, backup, time: new Date().toISOString() });
    writeManifest(cwd, entries);
  } catch {
    // 备份失败不阻断主流程
  }
}

/** 撤销最近一次修改；内部单步实现 */
function undoOne(cwd: string): string {
  const entries = readManifest(cwd);
  const last = entries[entries.length - 1];
  if (!last) return "没有可撤销的修改。";

  // 先恢复、成功后才弹出清单条目 —— 恢复失败时记录仍在，可以重试
  try {
    if (last.backup) {
      const snapshot = path.join(backupDirFor(cwd), last.backup);
      if (!fs.existsSync(snapshot)) {
        return `撤销失败：快照文件已不存在（${last.backup}）。`;
      }
      fs.copyFileSync(snapshot, last.file);
    } else if (fs.existsSync(last.file)) {
      // 这条记录代表「该文件是玄猪新建的」，撤销 = 删除它
      fs.rmSync(last.file, { force: true });
    }
  } catch (err) {
    return `撤销失败：${err instanceof Error ? err.message : String(err)}`;
  }

  entries.pop();
  writeManifest(cwd, entries);
  return last.backup
    ? `✓ 已撤销对 ${last.file} 的修改（恢复为修改前的内容）。`
    : `✓ 已撤销：删除了玄猪新建的文件 ${last.file}。`;
}

/**
 * 撤销最近 N 次被玄猪修改的文件（默认 1 次）。
 * 返回给用户看的说明文字（含成功/失败与具体动作）。
 */
export function undoLastChange(cwd: string, count = 1): string {
  const times = Math.max(1, Math.min(20, Math.floor(count) || 1));
  const results: string[] = [];
  for (let i = 0; i < times; i++) {
    const message = undoOne(cwd);
    results.push(message);
    if (message.startsWith("撤销失败") || message === "没有可撤销的修改。") {
      break;
    }
  }
  return results.join("\n");
}

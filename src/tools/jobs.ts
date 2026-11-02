import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * 后台 shell 任务（`bash run_in_background: true`）。
 *
 * 为什么需要：`bash` 是**阻塞**的，跑 `npm test` / 起 dev server 时模型只有两个选择 ——
 * 干等到超时（然后被截断的输出骗过去），或者中断整轮。真实的长任务应当能
 * 「发出去 → 继续做别的事 → 结束时收到通知」。
 *
 * 与「在命令末尾加 &」的区别：`&` 会把进程甩掉，输出与退出码都丢了，模型无法判断成败；
 * 这里把 stdout/stderr 落到文件、记住 pid 与退出码，完成时主动通知。
 *
 * 生命周期：任务随 xzh 进程退出而终止（`killAll`）。刻意不做跨进程续跑 ——
 * 一个已经失去父进程的任务没有归属，用户也无从知道它属于哪一轮对话。
 */

export type JobStatus = "running" | "done";

export interface BackgroundJob {
  /** 形如 `job-1`，在同一 xzh 进程内唯一 */
  id: string;
  command: string;
  cwd: string;
  /** 完整输出落盘的位置（stdout 与 stderr 合并） */
  logFile: string;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  /** 退出码；被信号终止时为 null */
  code: number | null;
  /** 终止信号（如 SIGTERM） */
  signal?: string | null;
  status: JobStatus;
  /** 是否由 xzh 主动终止（`bash_kill` / 退出） */
  killed?: boolean;
  /** 启动 / 结束失败的原因 */
  error?: string;
  /** 结束时的末尾输出（只出现在「未投递结果」的落盘记录里，供日志被删后仍能投递） */
  outputTail?: string;
}

/** 默认最多同时保留几个后台任务：再多用户与模型都盯不过来 */
export const MAX_BACKGROUND_JOBS = 8;
/** 单次读取后台输出的默认字符上限 */
export const DEFAULT_JOB_TAIL_CHARS = 4000;

export interface JobRegistryOptions {
  /**
   * 日志目录（通常 `<项目>/.xuanzhu/jobs`）。
   *
   * 允许传函数：`/switch` 之后项目目录会变，写死的路径会让新任务继续落到旧项目里。
   */
  logDir: string | (() => string);
  /** 任务结束时回调一次（用于唤醒对话 / 刷新界面） */
  onComplete?: (job: BackgroundJob) => void;
  maxJobs?: number;
  /**
   * 「尚未投递的结果」落盘目录（默认 `<logDir>/pending`）。
   *
   * 结果先落盘、投递成功再删：`xzh` 直接退出（任务被终止、或刚跑完就关掉）
   * 也不会丢掉「那条命令到底成功了没有」—— 下次启动时补给模型。
   */
  pendingDir?: string | (() => string);
}
/** 未投递结果里保存的输出长度上限 */
const PENDING_TAIL_CHARS = 2000;
/**
 * 「未投递结果」的默认子目录名（相对日志目录）。
 *
 * 导出是因为 Agent 在**没有注册表时**也要能判断「有没有遗留结果」——
 * 有才创建注册表，否则每次启动都在项目里多建一个空目录。
 */
export const PENDING_DIR_NAME = "pending";

/** 读文件末尾 `maxChars` 个字符，避免把几十 MB 的构建日志整读进内存 */
export function readFileTail(
  file: string,
  maxChars = DEFAULT_JOB_TAIL_CHARS,
): { text: string; truncated: boolean } {
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0) return { text: "", truncated: false };
    const limit = Math.max(0, Math.floor(maxChars));
    if (limit === 0) return { text: "", truncated: stat.size > 0 };
    const start = Math.max(0, stat.size - limit * 4);
    const length = stat.size - start;
    // 用 Uint8Array 而不是 Buffer：@types/node 与 Buffer 的 ArrayBufferLike 泛型
    // 在新版 TS 下与 readSync 的 ArrayBufferView 不兼容
    const buffer = new Uint8Array(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    const raw = Buffer.from(buffer).toString("utf8");
    const text = raw.length > limit ? raw.slice(-limit) : raw;
    return { text, truncated: stat.size > limit * 4 || raw.length > limit };
  } catch (err) {
    return { text: `（读取输出失败：${err instanceof Error ? err.message : String(err)}）`, truncated: false };
  }
}

/** 把任务状态整理成一行，供工具返回与界面复用 */
export function describeJob(job: BackgroundJob): string {
  const seconds = Math.max(
    0,
    Math.round(
      (Date.parse(job.endedAt ?? new Date().toISOString()) -
        Date.parse(job.startedAt)) /
        1000,
    ),
  );
  const state =
    job.status === "running"
      ? `运行中（已 ${seconds}s）`
      : job.killed
        ? "已终止"
        : job.code === 0
          ? `已完成（${seconds}s）`
          : `已结束，退出码 ${job.code ?? job.signal ?? "未知"}（${seconds}s）`;
  return `${job.id} · ${state} · ${job.command}`;
}

export class JobRegistry {
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly children = new Map<string, ChildProcess>();
  /** 已结束但尚未通知给对话的任务，按结束顺序 */
  private readonly completed: BackgroundJob[] = [];
  private seq = 0;
  private closed = false;

  constructor(private readonly options: JobRegistryOptions) {
    try {
      fs.mkdirSync(this.logDir(), { recursive: true });
    } catch {
      // 日志目录创建失败时 start() 会返回明确错误，这里不阻断构造
    }
    // 序号接着历史日志往下排：否则新进程又从 job-1 开始，
    // 会和「上次遗留、尚未投递的 job-1」撞号，模型看到两条同名任务会以为重复了
    try {
      for (const name of fs.readdirSync(this.logDir())) {
        const match = /^job-(\d+)\.log$/.exec(name);
        if (match) this.seq = Math.max(this.seq, Number(match[1]));
      }
    } catch {
      // 读不到历史就从头开始
    }
  }

  private logDir(): string {
    return typeof this.options.logDir === "function"
      ? this.options.logDir()
      : this.options.logDir;
  }

  private pendingDir(): string {
    const custom = this.options.pendingDir;
    const dir = typeof custom === "function" ? custom() : custom;
    return dir ?? path.join(this.logDir(), PENDING_DIR_NAME);
  }

  /** 把「尚未投递」的结果落盘（幂等键就是 job id：文件在 = 未投递，删掉 = 已投递） */
  private writePending(job: BackgroundJob): void {
    try {
      const dir = this.pendingDir();
      fs.mkdirSync(dir, { recursive: true });
      const { text } = readFileTail(job.logFile, PENDING_TAIL_CHARS);
      const record: BackgroundJob = { ...job, outputTail: text };
      fs.writeFileSync(
        path.join(dir, `${job.id}.json`),
        `${JSON.stringify(record)}\n`,
        "utf8",
      );
    } catch {
      // 投递记录写不进去不影响任务本身
    }
  }

  private removePending(id: string): void {
    try {
      fs.rmSync(path.join(this.pendingDir(), `${id}.json`), { force: true });
    } catch {
      // 忽略
    }
  }

  private get maxJobs(): number {
    return Math.max(1, this.options.maxJobs ?? MAX_BACKGROUND_JOBS);
  }

  list(): BackgroundJob[] {
    return [...this.jobs.values()];
  }

  running(): BackgroundJob[] {
    return this.list().filter((job) => job.status === "running");
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * 启动一个后台任务。命令以**独立进程组**启动（`detached`），
   * 这样才能在终止时连同它派生的子进程一起杀掉。
   */
  start(
    command: string,
    cwd: string,
    options: { shell?: string } = {},
  ): { job?: BackgroundJob; error?: string } {
    if (this.closed) {
      return { error: "xzh 正在退出，无法再启动后台任务。" };
    }
    const running = this.running();
    if (running.length >= this.maxJobs) {
      return {
        error:
          `后台任务已达上限（${this.maxJobs} 个）：${running
            .map((job) => job.id)
            .join("、")}。请先 bash_kill 掉不需要的再试。`,
      };
    }

    const id = `job-${++this.seq}`;
    const dir = this.logDir();
    const logFile = path.join(dir, `${id}.log`);
    const header = `$ ${command}\n\n`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(logFile, header, "utf8");
    } catch (err) {
      return {
        error: `无法创建后台任务的日志文件（${logFile}）：${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    const isWindows = process.platform === "win32";
    const shell =
      options.shell || (isWindows ? "cmd.exe" : process.env.SHELL || "bash");
    const args = isWindows ? ["/d", "/s", "/c", command] : ["-lc", command];

    const job: BackgroundJob = {
      id,
      command,
      cwd,
      logFile,
      startedAt: new Date().toISOString(),
      code: null,
      status: "running",
    };

    let fd: number;
    try {
      fd = fs.openSync(logFile, "a");
    } catch (err) {
      return {
        error: `无法打开后台任务的日志文件：${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    let child: ChildProcess;
    try {
      child = spawn(shell, args, {
        cwd,
        env: process.env,
        detached: !isWindows,
        windowsHide: true,
        stdio: ["ignore", fd, fd],
      });
    } catch (err) {
      fs.closeSync(fd);
      job.status = "done";
      job.error = err instanceof Error ? err.message : String(err);
      job.endedAt = new Date().toISOString();
      this.jobs.set(id, job);
      return { job };
    }
    // 子进程已持有该 fd，父进程这边可以关掉
    fs.closeSync(fd);

    job.pid = child.pid;
    this.jobs.set(id, job);
    this.children.set(id, child);

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (job.status === "done") return;
      job.status = "done";
      job.code = code;
      job.signal = signal;
      job.endedAt = new Date().toISOString();
      this.children.delete(id);
      this.completed.push(job);
      // 先落盘再投递：即使立刻退出（或被 killAll 终止）也留得下结论
      this.writePending(job);
      // 退出流程里 killAll 会批量终止任务：此时不再回调界面，
      // 否则用户会在退出前看到一屏「job-N 已终止」
      if (this.closed) return;
      // 回调放在 try 里：界面/对话侧的异常不能影响注册表本身
      try {
        this.options.onComplete?.(job);
      } catch {
        // 忽略
      }
    };

    child.on("error", (err) => {
      try {
        fs.appendFileSync(
          logFile,
          `\n[启动失败] ${err instanceof Error ? err.message : String(err)}\n`,
          "utf8",
        );
      } catch {
        // 日志写不进去不影响状态
      }
      job.error = err instanceof Error ? err.message : String(err);
      finish(null, null);
    });
    child.on("exit", (code, signal) => finish(code, signal));

    return { job };
  }

  /** 取出「已结束且还没通知过」的任务，供对话注入；取走即视为已投递（删掉落盘记录） */
  takeCompleted(): BackgroundJob[] {
    const jobs = this.completed.splice(0, this.completed.length);
    for (const job of jobs) this.removePending(job.id);
    return jobs;
  }

  /**
   * 取出**上一个 xzh 进程**遗留、尚未投递的结果。
   *
   * 与 `takeCompleted()` 一起构成「先落盘再投递」：文件存在即未投递，读走并删掉即已投递，
   * 因此重复调用、重复启动都不会把同一条结果投递两次（幂等键 = job id）。
   */
  takePending(): BackgroundJob[] {
    const dir = this.pendingDir();
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const jobs: BackgroundJob[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as BackgroundJob;
        if (raw && typeof raw.id === "string" && typeof raw.command === "string") {
          jobs.push({ ...raw, status: "done" });
        }
      } catch {
        // 坏文件直接删：留着只会在每次启动时重复报同一个解析错误
      }
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 忽略
      }
    }
    return jobs.sort((a, b) =>
      String(a.endedAt ?? "").localeCompare(String(b.endedAt ?? "")),
    );
  }

  /** 该任务的结果已经交给模型（注入了对话或直接读取），不必再投递一次 */
  markDelivered(id: string): void {
    this.removePending(id);
    const index = this.completed.findIndex((job) => job.id === id);
    if (index >= 0) this.completed.splice(index, 1);
  }

  /** 读取任务输出；`jobId` 未知时返回 undefined */
  read(
    jobId: string,
    maxChars = DEFAULT_JOB_TAIL_CHARS,
  ): { job: BackgroundJob; text: string; truncated: boolean } | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    const { text, truncated } = readFileTail(job.logFile, maxChars);
    return { job, text, truncated };
  }

  /** 终止一个后台任务（整组），返回是否发出了终止信号 */
  kill(jobId: string): { ok: boolean; message: string } {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, message: `未知的后台任务 "${jobId}"` };
    if (job.status === "done") {
      return { ok: false, message: `${job.id} 已经结束，无需终止。` };
    }
    const child = this.children.get(jobId);
    const pid = child?.pid ?? job.pid;
    job.killed = true;
    if (!pid) {
      job.status = "done";
      job.endedAt = new Date().toISOString();
      this.children.delete(jobId);
      this.writePending(job);
      return { ok: true, message: `${job.id} 尚未真正启动，已标记结束。` };
    }
    // 独立进程组：负号表示整组，避免只杀掉 shell 而留下孙进程
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child?.kill("SIGTERM");
      } catch {
        return { ok: false, message: `${job.id} 终止失败：进程可能已经退出。` };
      }
    }
    // 2 秒后仍未退出则强杀（子进程不响应 SIGTERM 的常见情形）
    const timer = setTimeout(() => {
      if (job.status === "done") return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child?.kill("SIGKILL");
        } catch {
          // 已退出
        }
      }
    }, 2000);
    timer.unref?.();
    return { ok: true, message: `已向 ${job.id} 发送终止信号。` };
  }

  /** xzh 退出时调用：终止全部仍在运行的任务 */
  killAll(reason = "xzh 退出"): void {
    this.closed = true;
    for (const job of this.running()) {
      this.kill(job.id);
      job.error = reason;
      // 同步把结论落盘：进程马上就要退出，等 'exit' 事件可能等不到 ——
      // 下次启动时模型仍应知道「上次那条命令是被退出终止的」
      if (job.status === "running") {
        job.status = "done";
        job.killed = true;
        job.endedAt = new Date().toISOString();
      }
      this.writePending(job);
    }
    this.completed.length = 0;
  }
}

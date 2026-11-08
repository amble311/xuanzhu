import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getBtcHome } from "../utils/paths";
import { btcPythonPath, btcVenvReady } from "./bootstrap";

/**
 * 调用 btc 的 Python 计算层（`<home>/runner.py`）。
 *
 * 协议：命令名走 argv，参数走 stdin JSON，结果走 stdout 单行 JSON。
 * 之所以不直接 `bash python ...`：
 * - 工具层能给出**确定的**错误分类（环境没装 / 数据不足 / 计算失败），
 *   而不是把一堆 stderr 丢给模型猜；
 * - 不需要模型自己拼引号与路径，换台机器也不会因为路径不同而失效。
 */

export type RunnerResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; detail?: string };

export interface RunnerOptions {
  home?: string;
  /** 超时（毫秒）；回测在几百根日线上通常 1–3s，给足余量 */
  timeoutMs?: number;
}

interface RawEnvelope {
  ok?: boolean;
  data?: unknown;
  error?: string | null;
}

/** 从 stdout 里取出最后一行 JSON（计算层可能被 pandas 警告污染前面的行） */
function parseEnvelope(stdout: string): RawEnvelope | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      return JSON.parse(lines[i]) as RawEnvelope;
    } catch {
      // 继续往前找
    }
  }
  return null;
}

export async function runRunner<T = unknown>(
  command: string,
  payload: Record<string, unknown> = {},
  options: RunnerOptions = {},
): Promise<RunnerResult<T>> {
  const home = options.home ?? getBtcHome();
  const runner = path.join(home, "runner.py");

  if (!fs.existsSync(runner)) {
    return {
      ok: false,
      error: `btc 计算脚本未就位：${runner}`,
      detail: "重新启动一次 `xzh btc` 会自动释放，或运行 `xzh btc setup`。",
    };
  }
  if (!btcVenvReady(home)) {
    return {
      ok: false,
      error: "btc 计算环境未安装（缺少 venv）",
      detail:
        "运行 `xzh btc setup` 创建 venv 并安装 numpy + pandas（需联网，约 30MB）；" +
        "未安装前行情库为空、回测与信号都不可用。",
    };
  }

  const python = btcPythonPath(home);
  const timeoutMs = options.timeoutMs ?? 120_000;

  return new Promise<RunnerResult<T>>((resolve) => {
    const child = spawn(python, [runner, command], {
      cwd: home,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        ok: false,
        error: `btc 计算超时（${Math.round(timeoutMs / 1000)}s）：${command}`,
        detail: stderr.trim().slice(-800) || undefined,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `无法启动 python：${err.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const envelope = parseEnvelope(stdout);
      if (!envelope) {
        resolve({
          ok: false,
          error: `btc 计算层没有返回结果（退出码 ${code ?? "?"}）`,
          detail: stderr.trim().slice(-800) || stdout.trim().slice(-800) || undefined,
        });
        return;
      }
      if (envelope.ok === false) {
        const detail =
          (envelope.data as { traceback?: string } | undefined)?.traceback ??
          stderr.trim().slice(-800);
        const message = envelope.error ?? "计算失败";
        // 「未知命令」几乎总是同一个原因：`~/.xzh_btc/runner.py` 还是旧版，
        // 而 CLI 已经在调新命令（例如 paper-status）。不点明的话，
        // 用户会以为「模拟盘没初始化」而不是「脚本该更新了」。
        const stale = message.includes("未知命令") || message.includes("unknown command");
        resolve({
          ok: false,
          error: stale
            ? `${message}（本机计算脚本可能过期：重启一次 xzh btc 会自动同步，或运行 xzh btc setup --force）`
            : message,
          detail: detail || undefined,
        });
        return;
      }
      resolve({ ok: true, data: envelope.data as T });
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

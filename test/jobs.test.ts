import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, type AgentEvents } from "../src/core/agent";
import { DEFAULT_CONFIG, type ModelEntry } from "../src/config/store";
import type { ChatOptions, StreamChunk } from "../src/llm/types";
import { bashTool } from "../src/tools/bash";
import { bashKillTool, bashOutputTool } from "../src/tools/job-tools";
import { JobRegistry, readFileTail } from "../src/tools/jobs";
import type { ToolContext } from "../src/tools/types";

/**
 * 后台任务的测试全部跑在临时目录里，并且**每个用例自己收尾**：
 * 注册表里的任务是真实进程，测试失败时若不清掉会留下孤儿进程。
 */

const dirs: string[] = [];
const registries: JobRegistry[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-jobs-"));
  dirs.push(dir);
  return dir;
}

function registry(dir = tempDir()): JobRegistry {
  const created = new JobRegistry({ logDir: dir });
  registries.push(created);
  return created;
}

async function until(
  predicate: () => boolean,
  message = "条件未在超时前成立",
  ms = 8000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

afterEach(() => {
  for (const item of registries.splice(0)) item.killAll("test teardown");
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("JobRegistry", () => {
  it("记录退出码、输出，并在结束时回调一次", async () => {
    const completed: string[] = [];
    const jobs = new JobRegistry({
      logDir: tempDir(),
      onComplete: (job) => completed.push(job.id),
    });
    registries.push(jobs);

    const started = jobs.start("echo hello-job", process.cwd());
    expect(started.error).toBeUndefined();
    const job = started.job!;
    expect(job.status).toBe("running");

    await until(() => jobs.get(job.id)!.status === "done");
    expect(jobs.get(job.id)!.code).toBe(0);
    expect(completed).toEqual([job.id]);

    const read = jobs.read(job.id)!;
    expect(read.text).toContain("hello-job");
    expect(read.job.status).toBe("done");

    // takeCompleted 是「取走」：第二次必须为空，否则对话会被同一结果反复唤醒
    expect(jobs.takeCompleted().map((item) => item.id)).toEqual([job.id]);
    expect(jobs.takeCompleted()).toEqual([]);
  });

  it("kill 会终止整组进程，并标记 killed", async () => {
    const jobs = registry();
    const started = jobs.start("sleep 30", process.cwd());
    const job = started.job!;
    await until(() => job.pid !== undefined);

    const result = jobs.kill(job.id);
    expect(result.ok).toBe(true);
    await until(() => jobs.get(job.id)!.status === "done");
    expect(jobs.get(job.id)!.killed).toBe(true);

    // 已结束的任务再 kill 一次要说清楚，而不是静默成功
    const again = jobs.kill(job.id);
    expect(again.ok).toBe(false);
    expect(again.message).toContain("已经结束");
  });

  it("超过并发上限时拒绝启动并说明怎么办", async () => {
    const jobs = new JobRegistry({ logDir: tempDir(), maxJobs: 1 });
    registries.push(jobs);
    const first = jobs.start("sleep 30", process.cwd());
    expect(first.job).toBeDefined();

    const second = jobs.start("echo second", process.cwd());
    expect(second.job).toBeUndefined();
    expect(second.error).toContain("上限");
  });

  it("未知任务返回 undefined，不抛异常", () => {
    const jobs = registry();
    expect(jobs.read("job-404")).toBeUndefined();
    expect(jobs.kill("job-404").ok).toBe(false);
  });
});

describe("bash 工具的后台模式", () => {
  const ctxWithJobs = (jobs: JobRegistry): ToolContext => ({
    cwd: process.cwd(),
    autoApprove: true,
    jobs,
  });

  it("run_in_background 立刻返回 job id，完成后 bash_output 能读到输出", async () => {
    const jobs = registry();
    const ctx = ctxWithJobs(jobs);

    const started = await bashTool.execute(
      { command: "echo bg-hello", run_in_background: true },
      ctx,
    );
    expect(started.ok).toBe(true);
    expect(started.content).toContain("job-1");
    // 明确要求模型不要轮询 —— 这是这套机制能省轮次的前提
    expect(started.content).toContain("不要轮询");

    await until(() => jobs.get("job-1")?.status === "done");
    const output = await bashOutputTool.execute({ job_id: "job-1" }, ctx);
    expect(output.ok).toBe(true);
    expect(output.content).toContain("bg-hello");
    expect(output.content).toContain("已完成");
  });

  it("没有注册表（子代理）时明确报错，而不是悄悄前台执行", async () => {
    const result = await bashTool.execute(
      { command: "echo x", run_in_background: true },
      { cwd: process.cwd(), autoApprove: true },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("不支持后台任务");
  });

  it("bash_output 不带 job_id 时列出任务；bash_kill 能停掉它", async () => {
    const jobs = registry();
    const ctx = ctxWithJobs(jobs);
    await bashTool.execute(
      { command: "sleep 30", run_in_background: true },
      ctx,
    );
    await until(() => jobs.get("job-1") !== undefined);

    const list = await bashOutputTool.execute({}, ctx);
    expect(list.content).toContain("job-1");

    const killed = await bashKillTool.execute({ job_id: "job-1" }, ctx);
    expect(killed.ok).toBe(true);
    await until(() => jobs.get("job-1")?.status === "done");

    const unknown = await bashOutputTool.execute({ job_id: "job-9" }, ctx);
    expect(unknown.ok).toBe(false);
    expect(unknown.content).toContain("未知的后台任务");
  });
});

describe("后台任务结果进入对话", () => {
  const model: ModelEntry = {
    id: "fake/fake",
    provider: "fake",
    model: "fake",
    contextWindow: 100000,
  };

  const scripted = (script: StreamChunk[][]) => {
    let call = 0;
    const seen: ChatOptions[] = [];
    return {
      seen,
      llm: {
        id: "fake",
        model: "fake",
        async *chat(options: ChatOptions) {
          seen.push(options);
          const chunks = script[Math.min(call, script.length - 1)];
          call += 1;
          for (const chunk of chunks) yield chunk;
        },
      },
    };
  };

  const events = (): AgentEvents => ({
    onText: () => undefined,
    onToolStart: () => undefined,
    onToolEnd: () => undefined,
    onStatus: () => undefined,
    confirm: async () => true,
  });

  const startJobThenQuiet = (): StreamChunk[][] => [
    [
      {
        type: "tool_call",
        toolCall: {
          id: "c1",
          name: "bash",
          arguments: JSON.stringify({
            command: "sleep 0.4; echo late-done",
            run_in_background: true,
          }),
        },
      },
      { type: "done", finishReason: "tool_calls" },
    ],
    [{ type: "text", text: "先起在后台" }, { type: "done", finishReason: "stop" }],
    [{ type: "text", text: "好，先这样" }, { type: "done", finishReason: "stop" }],
  ];

  it("同一个 Agent：空闲期结束的结果在下一轮补上", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-jobs-agent-"));
    dirs.push(cwd);

    const { llm, seen } = scripted([
      ...startJobThenQuiet(),
      [{ type: "text", text: "知道了" }, { type: "done", finishReason: "stop" }],
    ]);
    const agent = new Agent(
      llm,
      { ...DEFAULT_CONFIG, provider: "fake", model: "fake", models: [model] },
      cwd,
      events(),
      model,
    );

    await agent.run("把测试跑起来");
    await new Promise((resolve) => setTimeout(resolve, 900));
    await agent.run("刚才那个任务呢");

    const all = seen
      .flatMap((options) => options.messages)
      .map((message) => String(message.content ?? ""))
      .join("\n");
    expect(all).toContain("late-done");
    expect(all).toContain("后台任务");
  });

  it("换一个 Agent（模拟重启）：结果先落盘，下次启动补上且只补一次", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-jobs-restart-"));
    dirs.push(cwd);

    const first = scripted(startJobThenQuiet());
    const agentA = new Agent(
      first.llm,
      { ...DEFAULT_CONFIG, provider: "fake", model: "fake", models: [model] },
      cwd,
      events(),
      model,
    );
    await agentA.run("把测试跑起来");
    await new Promise((resolve) => setTimeout(resolve, 900));
    // 模拟「直接关掉 xzh」：落盘记录必须留下
    const pendingDir = path.join(cwd, ".xuanzhu", "jobs", "pending");
    expect(fs.readdirSync(pendingDir).length).toBeGreaterThan(0);

    const second = scripted([
      [{ type: "text", text: "知道了" }, { type: "done", finishReason: "stop" }],
    ]);
    const agentB = new Agent(
      second.llm,
      { ...DEFAULT_CONFIG, provider: "fake", model: "fake", models: [model] },
      cwd,
      events(),
      model,
    );
    await agentB.run("上次那个任务呢");

    const seenByB = second.seen
      .flatMap((options) => options.messages)
      .map((message) => String(message.content ?? ""))
      .join("\n");
    expect(seenByB).toContain("late-done");
    // 投递成功即删：换第三个 Agent 时不该再看到
    expect(fs.readdirSync(pendingDir)).toEqual([]);

    const third = scripted([
      [{ type: "text", text: "嗯" }, { type: "done", finishReason: "stop" }],
    ]);
    const agentC = new Agent(
      third.llm,
      { ...DEFAULT_CONFIG, provider: "fake", model: "fake", models: [model] },
      cwd,
      events(),
      model,
    );
    await agentC.run("还有吗");
    const seenByC = third.seen
      .flatMap((options) => options.messages)
      .map((message) => String(message.content ?? ""))
      .join("\n");
    expect(seenByC).not.toContain("late-done");
  });

  it("退出时杀掉的任务也会留下结论，下次启动能知道它没跑完", () => {
    const jobs = registry();
    jobs.start("sleep 30", process.cwd());
    jobs.killAll("xzh 退出");
    const pending = jobs.takePending();
    expect(pending.length).toBe(1);
    expect(pending[0].killed).toBe(true);
    // 幂等：取走即已投递
    expect(jobs.takePending()).toEqual([]);
  });
});

describe("readFileTail", () => {
  it("只读末尾，并标记截断", () => {
    const dir = tempDir();
    const file = path.join(dir, "tail.log");
    fs.writeFileSync(file, "a".repeat(100) + "TAIL", "utf8");
    const result = readFileTail(file, 10);
    expect(result.text.endsWith("TAIL")).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
  });

  it("空文件与不存在的文件都返回可读文本", () => {
    const dir = tempDir();
    const empty = path.join(dir, "empty.log");
    fs.writeFileSync(empty, "");
    expect(readFileTail(empty, 100)).toEqual({ text: "", truncated: false });
    expect(readFileTail(path.join(dir, "missing.log"), 100).text).toContain(
      "读取输出失败",
    );
  });
});

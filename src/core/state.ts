import type { RunStatus, TodoItem } from "../tools/types";

/**
 * 「只读状态块」—— 由代码根据**确定事实**生成，每轮请求随系统提示词一起发给模型。
 *
 * 为什么不是让模型自己「反思」：模型的自我报告是事后叙事，容易漂移、表演，
 * 还会白烧 token。这里只汇总代码已经知道的事实（目标、任务清单、最近动作、
 * 本次会话改过哪些文件、上下文占用），模型只读、不复述。
 *
 * 为什么需要它：这些事实此前散落在各个局部机制里 —— `todo_write` 只在工具描述里提、
 * 重复检测只在工具层生效、上下文裁剪只有一条独立提醒。模型在一次长任务中很容易
 * 「忘记自己做到哪了」，于是重复劳动或提前收尾。把现状集中摆到它眼前，成本只有几百 token。
 *
 * 块本身有长度上限（见下方常量），内容为空时返回 `null`，不占额外 token。
 */

export interface SelfStateInput {
  /** 当前目标（目标模式） */
  goal?: { text: string; startedAt: string; completed: boolean };
  /** 当前任务列表（todo_write） */
  todos: TodoItem[];
  /** 最近执行过的工具（名称 + 是否成功），新的在后 */
  recentActions: Array<{ name: string; ok: boolean }>;
  /** 本次会话改动过的文件（write_file / edit_file 的 path） */
  changedFiles: string[];
  /** 上一次请求的上下文占用比例（0–1），未知时不传 */
  contextUsage?: number;
  /** 本轮模型主动上报的状态（`report_status`） */
  status?: RunStatus;
}

const STATUS_LABEL: Record<RunStatus["kind"], string> = {
  blocked: "受阻",
  needs_input: "等待用户决定",
  low_confidence: "置信度低",
};

/** 目标正文最多展示多少字符 */
const MAX_GOAL_CHARS = 120;
/** 任务清单最多展开几项待办 */
const MAX_TODO_ITEMS = 3;
/** 最近动作最多展示几条 */
const MAX_ACTIONS = 5;
/** 改动文件最多列出几个 */
const MAX_FILES = 4;
/** 上下文占用低于该比例时不占用状态块（未到需要关注的程度） */
const CONTEXT_USAGE_THRESHOLD = 0.5;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 目标已运行时长（从 startedAt 起算） */
function elapsedText(startedAt: string): string | null {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** 生成只读状态块；没有可写内容时返回 `null` */
export function buildSelfState(input: SelfStateInput): string | null {
  const lines: string[] = [];

  if (input.goal) {
    const state = input.goal.completed ? "已完成" : "进行中";
    const elapsed = elapsedText(input.goal.startedAt);
    lines.push(
      `- 目标：${clip(input.goal.text, MAX_GOAL_CHARS)}` +
        `（${state}${elapsed ? ` · 已用 ${elapsed}` : ""}）`,
    );
  }

  if (input.status) {
    lines.push(
      `- 状态：${STATUS_LABEL[input.status.kind]} —— ${clip(input.status.summary, 100)}`,
    );
  }

  const active = input.todos.filter((item) => item.status !== "cancelled");
  if (active.length > 0) {
    const done = active.filter((item) => item.status === "completed").length;
    const running = active.find((item) => item.status === "in_progress");
    const pending = active
      .filter((item) => item.status === "pending")
      .slice(0, MAX_TODO_ITEMS);
    let line = `- 任务：${done}/${active.length} 完成`;
    if (running) line += `；进行中：${clip(running.content, 60)}`;
    if (pending.length > 0) {
      line += `；待办：${pending.map((item) => clip(item.content, 40)).join("、")}`;
      const rest = active.filter((item) => item.status === "pending").length - pending.length;
      if (rest > 0) line += ` 等 ${rest + pending.length} 项`;
    }
    lines.push(line);
  }

  if (input.recentActions.length > 0) {
    lines.push(
      `- 最近动作：${input.recentActions
        .slice(-MAX_ACTIONS)
        .map((action) => `${action.name} ${action.ok ? "✓" : "✗"}`)
        .join("、")}`,
    );
  }

  if (input.changedFiles.length > 0) {
    const shown = input.changedFiles.slice(-MAX_FILES).map((file) => clip(file, 48));
    const more =
      input.changedFiles.length > MAX_FILES
        ? ` 等 ${input.changedFiles.length} 个文件`
        : "";
    lines.push(`- 本次会话已改动：${shown.join("、")}${more}`);
  }

  if (
    typeof input.contextUsage === "number" &&
    input.contextUsage >= CONTEXT_USAGE_THRESHOLD
  ) {
    const percent = Math.min(100, Math.round(input.contextUsage * 100));
    lines.push(`- 上下文：约 ${percent}%（较早内容可能已被裁剪）`);
  }

  if (lines.length === 0) return null;
  return `[当前状态 · 系统根据确定事实生成，仅供参考，不要复述]\n${lines.join("\n")}`;
}

/**
 * 命令是否属于「验证类」：测试 / 构建 / 类型检查 / lint。
 *
 * 只做保守的启发式匹配：宁可漏判（少提醒一次），也不要把 `ls`、`cat` 之类
 * 当成验证 —— 误判会让模型以为「我已经验证过了」。命中即视为跑过验证，
 * **不看成败**：失败的结果模型已经看到了，再重复提醒没有意义。
 */
export function isVerificationCommand(command: string): boolean {
  const pattern =
    /(^|[\s/])(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|typecheck|lint|check)\b|vitest|jest|pytest|py_compile|tsc\b|go\s+(test|build|vet)|cargo\s+(test|build|check|clippy)|mvn\s+test|gradlew?\s+\S*(test|build|check)|make\s+(test|check|build)|dotnet\s+(test|build)|ruff\b|eslint\b|mypy\b|flake8\b|phpunit|rspec\b|bats\b/i;
  return pattern.test(command);
}

/**
 * 验证门的提示（`role: "user"`，不写入历史，只在本轮 `turn` 里）。
 *
 * 为什么用 user 角色：各家协议里 tool 消息必须对应一次 tool_call，而这里没有；
 * user 消息既能承载指令，又不会破坏结构。
 */
export interface FinishGateInput {
  /** 本轮改过、但之后没跑过验证的文件 */
  verificationFiles?: string[];
  /** 任务清单里仍未完成的项目 */
  incompleteTodos?: TodoItem[];
}

/**
 * 收尾检查（验证门 + 未完成门的合并提示）。
 *
 * 两件事同时成立时只发**一条**消息：分开发会让模型连续被两条系统指令打断，
 * 也让用户看到两段重复的「请继续」。
 *
 * 与目标模式的区别：这里允许模型第二次直接收尾（用户可能就是要先停），
 * 只要求它说清是「受阻 / 需要用户决定 / 有意暂停」中的哪种。
 */
export function finishGatePrompt(input: FinishGateInput): string {
  const sections: string[] = [];

  const todos = input.incompleteTodos ?? [];
  if (todos.length > 0) {
    const shown = todos
      .slice(0, 5)
      .map(
        (item) =>
          `  - [${item.status === "in_progress" ? "进行中" : "待办"}] ${item.content}`,
      )
      .join("\n");
    const more = todos.length > 5 ? `\n  …还有 ${todos.length - 5} 项` : "";
    sections.push(
      `任务清单里还有 ${todos.length} 项未完成：\n${shown}${more}\n` +
        "请继续完成它们；若确实要现在停下，说明原因。",
    );
  }

  const files = input.verificationFiles ?? [];
  if (files.length > 0) {
    const shown = files.slice(0, 3).map((file) => `  - ${file}`).join("\n");
    const more = files.length > 3 ? `\n  …共 ${files.length} 个文件` : "";
    sections.push(
      `你在本轮修改过文件，但还没有运行任何验证（测试 / 构建 / 类型检查 / lint）：\n` +
        `${shown}${more}\n` +
        `请运行项目对应的验证命令（参照 AGENTS.md / package.json / 现有测试）；` +
        `确实无法运行时，说明原因与「未验证」的风险。`,
    );
  }

  return `[系统检查] 收尾前还有未完成的工作：\n\n${sections.join("\n\n")}\n\n` +
    `若确实需要现在停下，请在答复里说明属于哪种情况（受阻 / 需要用户决定 / 有意暂停）与原因。`;
}

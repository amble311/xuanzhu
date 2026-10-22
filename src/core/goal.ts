import type { TodoItem } from "../tools/types";

/**
 * 目标模式（`/goal`）用的提示词。
 *
 * 与子代理的「一次性任务」不同：目标模式由界面**反复驱动**同一段对话 ——
 * 每轮模型给出答复后，若它还没调用 `goal_complete`，界面就再发一条「继续」。
 * 因此这里的三段文字各司其职：
 * - `goalSystemSection`：随每次请求注入系统提示词，确立「不要中途停下」的角色；
 * - `goalStartPrompt`：目标的第一条 user 消息，交代目标与执行方式；
 * - `goalContinuePrompt`：后续自动继续的 user 消息，强调「接着做没做完的部分」。
 *
 * 为什么「不要停」必须写进系统提示词而不只是首条消息：历史会被裁剪，
 * 十几轮之后首条目标消息可能已经不在上下文里，系统提示词则每次都在。
 */
export function goalSystemSection(goal: string): string {
  return `## 目标模式（/goal）
用户设定了一个目标，系统会在你**每次给出答复后自动继续**，直到你调用 \`goal_complete\` 声明完成。
因此**不要在中途停下来征求确认**——本模式下没有人会回答你。

当前目标：
${goal}

规则：
1. **持续推进**：每一轮都必须有实际进展（读文件、写代码、跑命令、验证），不要只输出计划，
   也不要把已经完成的工作重做一遍。
2. **自主决策**：遇到需要选择 / 确认的地方，按最合理、最保守的方案直接执行，并在结论里说明取舍；
   绝不能以「需要你确认」「等你回复」为理由结束本轮。
3. **先看进度再动手**：动手前先确认哪些部分已经做完（对话记录、todo 列表、工具返回里的
   「这一步已经完成」提醒），从**未完成**处接着做；长任务最容易出的问题就是忘记进度后重新开始。
4. **维护任务清单**：多步任务用 \`todo_write\` 列出计划并随进度更新，这既是你的进度记忆，
   也让用户能看到进展。
5. **完成判定**：只有目标**全部完成并验证过**（构建 / 测试 / 实际运行通过）时，才调用
   \`goal_complete\`，并在其中写清做了什么、怎么验证的。若确认无法完成（缺凭据、外部依赖不可用等），
   也调用 \`goal_complete\`，把阻塞点和已完成的部分写进 summary。
6. 调用 \`goal_complete\` 之后，用一段简短的最终总结收尾，不要再开始新工作。`;
}

/** 目标模式的首轮 user 消息 */
export function goalStartPrompt(goal: string): string {
  return `[目标模式] 请把下面这件事作为目标，持续推进直到完成。本模式下系统会自动继续，不会中途停下。

## 目标
${goal}

## 现在开始
1. 先确认现状：定位相关文件 / 命令 / 已有进展，不要凭空假设。
2. 拆解步骤（多步任务用 todo_write 列出），然后**逐步实际执行**并验证。
3. 目标全部完成并验证通过后，调用 \`goal_complete\`，再给出简短的最终总结。
4. 中途不要停下来询问确认 —— 需要决定时自己选最合理的方案，并说明理由。`;
}

/** 后续自动继续的 user 消息（`round` 为已完成的轮数） */
export function goalContinuePrompt(
  goal: string,
  round: number,
  todos: TodoItem[] = [],
): string {
  const pending = todos.filter((item) => item.status !== "completed" && item.status !== "cancelled");
  const todoSection =
    todos.length === 0
      ? ""
      : `\n\n## 任务清单（todo_write）\n${todos
          .map((item) => {
            const mark =
              item.status === "completed"
                ? "[x]"
                : item.status === "in_progress"
                  ? "[~]"
                  : item.status === "cancelled"
                    ? "[-]"
                    : "[ ]";
            return `${mark} ${item.content}`;
          })
          .join("\n")}`;

  return `[目标模式 · 自动继续 第 ${round + 1} 轮] 目标还没有完成 —— 你上一轮以答复结束，但没有调用 \`goal_complete\`。

## 目标
${goal}${todoSection}

## 继续要求
- 立刻接着做**尚未完成**的部分：不要重复已完成的步骤，也不要重新从头分析。
- 若上一轮停在「等用户确认 / 提出方案」上，请自行做出合理决定并执行下去。
- 每轮都要有实际产出（改代码、跑命令、验证结果），不要只输出说明。
- 只有目标真正完成并验证通过，才调用 \`goal_complete\`；确认无法完成时也调用它并写明阻塞原因。
${pending.length > 0 ? `- 当前还有 ${pending.length} 项未完成，优先推进它们。` : ""}`;
}

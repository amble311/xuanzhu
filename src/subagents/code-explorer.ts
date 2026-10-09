import type { SubAgentDefinition } from "./types";

/**
 * code-explorer —— 代码库探索子代理（只读）。
 *
 * 存在的意义是**隔离上下文**：探索型任务（翻几十个文件、多种命名约定逐个排查）
 * 会产生大量一次性内容，让它自己做、只把发现带回来，主对话就不会被塞满。
 *
 * 工具白名单刻意**只含读取类**：探索不该改代码，只读还省掉了「子代理改坏东西」
 * 与「与主代理并发写同一文件」两类风险。需要动手改代码的场景由主代理自己做。
 */
export const codeExplorer: SubAgentDefinition = {
  name: "code-explorer",
  description:
    "Fast subagent specialized in codebase exploration. Use it whenever the task requires " +
    "searching across multiple files, directories, or patterns, or when the scope of code " +
    "exploration is too large for a single read_file or grep call. " +
    'When calling it, state the desired thoroughness level in the prompt: "quick" for a basic ' +
    'lookup, "medium" for moderate exploration, or "very thorough" for comprehensive analysis ' +
    "across multiple locations and naming conventions. " +
    "它是**只读**子代理：只回报发现与证据，不会修改任何文件；" +
    "需要实际改代码时不要派它，自己动手。",
  toolNames: [
    "read_file",
    "list_dir",
    "glob",
    "grep",
    "list_skills",
    "load_skill",
  ],
  systemPrompt({ cwd, description, prompt }): string {
    return `你是「玄猪」派出的 **code-explorer（代码库探索）子代理**，只做调研并回报发现。

工作目录：${cwd}
子任务：${description}
权限：**只读**。你只有 read_file / list_dir / glob / grep 等读取与搜索工具，
**不要尝试修改任何文件或执行命令**；发现需要改动的地方，写进报告由主代理处理。

## 探索力度（thoroughness）
任务描述里可能给出力度要求，按它决定投入：
- \`quick\`：一次基本查找。定位到目标、给出直接答案即可。
- \`medium\`：适度探索。覆盖主要相关文件，确认调用方与关键分支。
- \`very thorough\`：穷尽式分析。遍历多种命名约定与可能位置（含测试、文档、脚本、
  配置），交叉验证结论，明确说明「已确认没有」的部分。

## 工作方式
1. 你**看不到主对话的历史**，只能依据下面的「任务描述」独立完成；描述若有歧义，
   按最合理的解释推进，并在报告中写明你的假设。
2. 先摸清现状再下结论：用 glob / grep 定位（不要靠猜路径），再用 read_file 确认真实内容。
   对同一结论尽量交叉验证（例如既搜定义也搜引用）。
3. 只做这件子任务，**不要扩大范围**（不要顺手重构、不要做未被要求的改动）。
4. 完成后**直接给出结论性报告**，不要反问、不要请求确认：
   - **结论**：最重要的事实放最前面，直接回答问题；
   - **证据**：\`文件路径:行号\` + 关键代码片段（引用要精确，不要凭印象转述）；
   - **已排查未找到**：说明搜过哪些模式与位置，避免主代理重复劳动；
   - **风险或待确认项**：如有。

## 任务描述
${prompt.trim()}`;
  },
};

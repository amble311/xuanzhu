/** 构建玄猪的系统提示词 */
export function buildSystemPrompt(
  cwd: string,
  extra?: string,
  projectRules?: string | null,
  projectMemory?: { longTerm: string; recentDaily: string } | null,
): string {
  const base = `你是「玄猪」（XuanZhu），一款运行在终端中的 AI 编码 Agent。

你的工作目录：${cwd}

## 核心原则
1. 先理解再动手：修改文件前先用 read_file 读取确认内容，不要凭猜测修改。
2. 精准编辑：优先使用 edit_file 做局部替换，避免用 write_file 覆盖整个文件。
3. 主动验证：完成代码修改后，尽量使用 bash 运行测试、构建或类型检查来验证结果。
4. 简洁沟通：用中文回复，直接给出结论与关键信息，避免冗长客套。
5. 工具优先：需要查找文件用 glob，搜索内容用 grep，不要靠猜路径。

## 工具使用规范
- read_file：读取文件（带行号），修改前必读
- list_dir：查看目录结构
- glob：按模式查找文件，如 "src/**/*.ts"
- grep：用正则搜索文件内容
- write_file：覆盖写入整个文件（危险，需确认）
- edit_file：精确替换文本（危险，需确认）
- bash：执行 shell 命令（危险，需确认）

## 技能（Skills）
玄猪内置若干技能，每个技能是一份指导你使用特定外部 CLI 工具的指南
（如 playwright 浏览器自动化、officecli 文档处理）。
- 当任务涉及某个领域时，先调用 list_skills 查看可用技能，再用 load_skill <name> 加载完整指南。
- 加载后严格按指南中的命令与步骤操作；指南在本次对话中持续有效，同一个技能无需重复加载。
- 若指南依赖的 CLI 未安装，按指南中的安装说明先安装，不要凭空猜测参数。

## 输出风格
- 涉及代码时使用 Markdown 代码块并标注语言。
- 完成任务后简要说明改了什么、接下来可以做什么。
- 若任务无法完成，说明原因和所需信息。`;

  let result = base;

  if (projectRules && projectRules.trim()) {
    result += `\n\n## 项目规则（来自项目根 .xuanzhu/rules.md，请优先遵守）\n${projectRules.trim()}`;
  }

  result += buildMemorySection(projectMemory);

  if (extra && extra.trim()) {
    result += `\n\n## 附加指令\n${extra.trim()}`;
  }

  return result;
}

const MEMORY_EXCERPT_CHARS = 1500;

/** 生成「项目记忆」段落：说明记忆工具用法，并附上长期记忆节选 */
function buildMemorySection(
  memory?: { longTerm: string; recentDaily: string } | null,
): string {
  let section =
    "\n\n## 项目记忆\n" +
    "本项目在 `.xuanzhu/memory/` 中保存跨会话记忆（长期记忆 MEMORY.md + 每日日志）。\n" +
    "- 处理需要项目背景的任务前，可调用 `memory_read` 了解此前积累的结论与约定。\n" +
    "- 完成实质工作后，调用 `memory_write` 记录值得跨会话保留的信息。";

  const longTerm = memory?.longTerm?.trim();
  if (longTerm) {
    const excerpt =
      longTerm.length > MEMORY_EXCERPT_CHARS
        ? `${longTerm.slice(0, MEMORY_EXCERPT_CHARS)}\n…（已截断，可用 memory_read 查看完整内容）`
        : longTerm;
    section += `\n\n### 现有长期记忆（节选）\n${excerpt}`;
  }

  return section;
}

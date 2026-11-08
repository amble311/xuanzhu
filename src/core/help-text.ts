import { ansi } from "../utils/ansi";

/**
 * 玄猪的内置命令帮助，TUI（`/help`）与 gateway（微信里的 `/help`）共用。
 *
 * 放在这里而不是 TUI 里：两处的内容必须一致，微信里用户看到的就是
 * 「和 xzh 一样」的帮助 —— 差异部分（鼠标 / 快捷键等纯界面项）保留原样，
 * 由调用方决定是否附上「界面专属」说明。
 *
 * 行内含 ANSI 转义；纯文本渠道（微信）发送前需要自行 strip。
 */
export function commandHelpLines(): string[] {
  return [
    `${ansi.bold}玄猪 内置命令${ansi.reset}`,
    `  /help          显示本帮助`,
    `  /clear         清空屏幕`,
    `  /tools         列出本轮发给模型的工具（排查「某个工具似乎没被调用过」）`,
    `  /context       查看上下文预算（系统 / 工具 / 历史 / 状态各占多少）`,
    `  /usage         查看本轮 / 累计真实 token 用量（模型返回 usage 时）`,
    `  /compact       将旧历史压缩成摘要（用一次模型调用，保留最近几轮）`,
    `  /focus [文件]  查看 / 维护工作集（/focus <文件>、rm、clear）`,
    `  /device        手机设备桥（先 /device serve 或 /device connect <手机IP>）`,
    `                 子命令：connect｜serve｜stop｜list｜push <文件>｜run <文件>｜logs [N]`,
    `                 体检与截图请用命令行：xzh device check / xzh device shot`,
    `  /copy [N|A-B|last|all]  复制左侧对话到系统剪贴板（默认最近 30 行）`,
    `  /copy term [N|A-B|all]  复制右侧终端输出（按栏取内容，不会串栏）`,
    `  /image         把系统剪贴板里的图片加为本轮附件（同 Ctrl+V；别名 /paste）`,
    `  /mouse         切换鼠标捕获：开启后可在输出区拖拽选择（按整行）`,
    `  /feed          开关后台巡检过程流（思考 / 工具调用实时显示，btc 模式）`,
    `  /stop          暂停后端巡检与自动交易（btc 模式；/stop resume 恢复）`,
    `  /reset         重置对话上下文`,
    `  /monitor       查看全部叫醒条件（面板只显示前 2 条，长公式会折行）`,
    `  /btc [moni]    切到 btc 模式（moni = 模拟盘）；/xzh 回到普通模式`,
    `  /a             切到 A 股分析模式；/xzh 回到普通模式`,
    `  /xzh           退出专用模式，回到进入前的项目目录`,
    `  xzh a          A 股分析模式（命令行启动；进入后可用 a_* 分析工具）`,
    `  xzh a serve    A 股独立巡检：盘中每 15 分钟选股 / 监控 / 模拟买卖`,
    `  /reset moni [初始资金]  重置模拟盘账本并记入记忆（仅 xzh btc moni 下有意义）`,
    `  /undo [N]      撤销玄猪最近 N 次文件修改（默认 1，最多 20；改前自动备份）`,
    `  /resume [编号]  列出 / 恢复历史会话（对话历史会自动保存）`,
    `  /cwd           显示当前工作目录`,
    `  /switch <目录> 切换项目（载入该项目上次会话接着聊）`,
    `  /term          显示/隐藏右侧终端面板（/term clear 清空输出）`,
    `  /model [编号|id|模型名]  查看 / 切换当前模型（不带参数：↑ ↓ 选择，Enter 确认）`,
    `  /goal <目标>   目标模式：持续自动执行直到完成（Ctrl+C 中断；/goal off 清除）`,
    `  /goal [status|continue|off]  查看当前目标 / 继续已暂停的目标 / 清除目标`,
    `  /memory        查看项目记忆；/memory show [global] 查看全文；/memory global 状态；/memory clear [global] 清空（需确认）`,
    `  /init [--dry-run|--force]  扫描并搭建 AGENTS.md/docs 框架，再用模型完善（写入前确认）`,
    `  /auto [on|off] 切换自动批准（on：所有工具直接执行，写入配置）`,
    `  /autonomy [ask|observe|auto]  自治等级：逐项确认 / 只观察（拦截并记录写操作）/ 全自动`,
    `  /jobs [id|kill <id>]  查看后台任务与输出（长命令会自动转后台，结束时通知）`,
    `  /prompt [list|show <段落>|reset <段落|--all>]  查看 / 重置系统提示词的分段覆盖`,
    `  /intent [on|off] 切换意图分析（on：每条消息先做意图分析再处理，写入配置）`,
    `  /exit          退出玄猪`,
    `${ansi.bold}快捷键${ansi.reset}`,
    `  Enter 提交 · ${ansi.bold}Alt+Enter${ansi.reset} 换行（Ctrl/Shift+Enter 视终端而定）`,
    `  ↑/↓ 历史 · Ctrl+A/Ctrl+E 行首/行尾 · PgUp/PgDn 翻页 · Shift+↑/↓ 逐行`,
    `  Home/End 跳到最早/最新`,
    `  ${ansi.gray}鼠标${ansi.reset}：滚轮滚动输出区；${ansi.bold}在输出区拖拽即可选中并复制${ansi.reset}${ansi.gray}（松开写入剪贴板）。${ansi.reset}`,
    `      想用终端原生框选/右键菜单：${ansi.reset}Shift+拖拽${ansi.gray} 绕过，或 ${ansi.reset}/mouse${ansi.gray} 交还鼠标（滚动改用 PgUp/PgDn）。${ansi.reset}`,
    `      ⚠ 拖选是矩形选择，跨过中缝会把另一栏一起带走 ——` + `跨栏内容请改用 ${ansi.reset}/copy${ansi.gray}（左栏）或 ${ansi.reset}/copy term${ansi.gray}（右栏）。${ansi.reset}`,
    `  ${ansi.gray}粘贴${ansi.reset}：支持多行整段粘贴（不会逐行提交）；也可用 ${ansi.reset}/copy${ansi.gray} 复制输出区。${ansi.reset}`,
    `  ${ansi.bold}Ctrl+V${ansi.reset} ${ansi.gray}粘贴图片：读取系统剪贴板里的图片作为附件（输入框显示${ansi.reset}[图片N]${ansi.gray}，回车发送）。${ansi.reset}`,
    `       ${ansi.gray}终端只会传文本，图片拿不到，因此由玄猪主动读剪贴板：${ansi.reset}`,
    `       ${ansi.gray}Linux 缺 ${ansi.reset}wl-clipboard${ansi.gray}/${ansi.reset}xclip${ansi.gray} 时会询问后自动安装；Windows 用内置 PowerShell；macOS 用 ${ansi.reset}pngpaste${ansi.gray} 或内置 osascript。${ansi.reset}`,
    `       ${ansi.gray}若本终端把 Ctrl+V 当自己的粘贴键（如 Windows Terminal），改用 ${ansi.reset}/image${ansi.gray}。${ansi.reset}`,
    `       ${ansi.gray}需要模型支持视觉（glm-4v / qwen-vl / gpt-4o / claude 等）；可用 ${ansi.reset}xzh model vision <id> on${ansi.gray} 手动标注。${ansi.reset}`,
    `  Shift+Tab 切换焦点（对话 ⇄ 右侧终端）· 鼠标点击亦可`,
    `  Ctrl+C 中断任务 / 清空输入 / 退出（空闲且输入为空时退出）`,
    `  Ctrl+D 结束本轮正在进行的对话 · 任何情况下都不会退出玄猪`,
    `  Ctrl+L 清屏`,
    `  注：${ansi.bold}Alt+Enter${ansi.reset} 走终端原生编码，各终端通用；`,
    `      Ctrl/Shift+Enter 需要终端支持扩展键盘协议，部分终端（尤其 IDE 内置）不支持。`,
    `${ansi.bold}右侧终端${ansi.reset}`,
    `  Enter 执行命令 · ↑/↓ 命令历史 · Ctrl+C / Ctrl+D 中断运行中的命令 · Ctrl+L 清空`,
    `  PgUp/PgDn / Shift+↑↓ / Home/End 回看历史输出（滚动不影响正在运行的命令）`,
    `  命令在当前项目目录下执行；cd 生效（面板自行维护工作目录）`,
  ];
}

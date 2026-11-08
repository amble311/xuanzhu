/**
 * 专用模式（`xzh btc` 这类子命令）。
 *
 * 一个模式 = 一套「入口 + 工作目录 + 技能范围 + 提示词」，复用同一个 Agent 内核：
 * 不新建 Agent 类，也不复制工具实现，只是给启动过程加点约束。
 *
 * 与 `config` 的区别：模式**不写全局配置**。`~/.xzh/config/config.json` 是用户对所有场景的
 * 共同设置；模式带来的差异（目录锁定、技能范围、提示词段）只作用于本次运行，
 * 退出即恢复，避免「跑过一次 btc 之后普通 xzh 也变得怪怪的」。
 */
export interface AgentMode {
  /** 模式名，同时是 CLI 子命令名（如 `btc`） */
  name: string;
  /** 展示名，用于启动提示与 `/switch` 的拒绝文案 */
  label: string;
  /**
   * 固定工作目录（绝对路径）。启动时作为 cwd，且该目录不存在时会被创建。
   *
   * 注意它**不跟随** `XZH_HOME`：`~/.xzh` 是玄猪的全局配置，而 `~/.xzh_btc` 是这个
   * 模式的数据目录，两者归属不同，重定向一个不该带走另一个。
   */
  home: string;
  /** 是否禁止 `/switch`（true = 本次运行只能在该目录工作） */
  cwdLocked: boolean;
  /**
   * 代码生成的模式说明段。
   *
   * **不可被 `config.promptOverrides` 覆盖**：这一段描述的是「本模式被代码强制的约束」，
   * 用户整段替换掉会让模型以为目录能切、技能能随便加载。要改模式说明请改代码。
   */
  promptSection: string;
  /** 进入模式时在输出区显示的一行提示 */
  startupHint: string;
  /**
   * 启动时释放随包资产（同步、无网络）；失败**不阻止启动**。
   *
   * 适合放「复制脚本」「建空目录」这类毫秒级动作；装依赖、下数据这类要联网的
   * 重操作必须留给显式命令（如 `xzh btc setup`），否则启动会卡在网络上。
   */
  bootstrap?: (home: string) => void;
  /**
   * 首次进入模式时的环境准备（可能联网、耗时几十秒）。
   *
   * 在 TUI 接管终端**之前**调用，pip 的进度才看得见。返回 `ok: false` 时
   * **不阻止进入界面** —— 该模式的部分工具会自行报「环境未就绪」，
   * 用户也可以稍后手动重跑（`xzh btc setup`）。
   */
  autoSetup?: () => Promise<{ ok: boolean; error?: string; skipped?: boolean }>;
  /**
   * 确保模式的**常驻服务**在跑（如 btc 的后端行情巡检）。
   *
   * 与 `autoSetup` 的区别：这是长期进程，界面退出后仍要继续运行，
   * 下次进入时复用而不是重新拉起。返回的 message 显示在启动提示里，
   * 失败只提示、不阻断进入界面。
   */
  ensureService?: () => Promise<{ ok: boolean; message: string }>;
}

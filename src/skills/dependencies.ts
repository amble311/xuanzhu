/**
 * 技能的外部依赖声明。
 *
 * 技能是一份 CLI 使用指南；这些 CLI 由玄猪负责检测与自动安装，
 * 使用户安装玄猪后无需再单独安装对应工具。
 */

export type Platform = "linux" | "darwin" | "win32";

export interface SkillRequirement {
  /** 人类可读名称 */
  name: string;
  /** 检测命令：退出码为 0 视为已安装 */
  check: string;
  /** 各平台的安装命令 */
  install: Partial<Record<Platform, string>>;
  /** 安装成功后的补充命令（例如下载浏览器内核） */
  postInstall?: Partial<Record<Platform, string>>;
}

export function currentPlatform(): Platform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  return "linux";
}

const NPM_PLAYWRIGHT_CLI = "npm install -g @playwright/cli@latest";
const PLAYWRIGHT_BROWSER = "npx --yes playwright@latest install chromium";

const OFFICECLI_INSTALL = {
  linux: "curl -fsSL https://d.officecli.ai/install.sh | bash",
  darwin: "curl -fsSL https://d.officecli.ai/install.sh | bash",
  win32:
    'powershell -NoProfile -Command "irm https://d.officecli.ai/install.ps1 | iex"',
};

/** 内置技能的依赖清单（技能名 → 依赖列表） */
export const SKILL_REQUIREMENTS: Record<string, SkillRequirement[]> = {
  playwright: [
    {
      name: "Playwright CLI（playwright-cli）",
      check: "playwright-cli --version",
      install: {
        linux: NPM_PLAYWRIGHT_CLI,
        darwin: NPM_PLAYWRIGHT_CLI,
        win32: NPM_PLAYWRIGHT_CLI,
      },
      postInstall: {
        linux: PLAYWRIGHT_BROWSER,
        darwin: PLAYWRIGHT_BROWSER,
        win32: PLAYWRIGHT_BROWSER,
      },
    },
  ],
  officecli: [
    {
      name: "OfficeCLI（officecli）",
      check: "officecli --version",
      install: OFFICECLI_INSTALL,
    },
  ],
};

/** 取得某技能声明的依赖；未声明则返回空数组 */
export function getSkillRequirements(skillName: string): SkillRequirement[] {
  return SKILL_REQUIREMENTS[skillName.trim().toLowerCase()] ?? [];
}

/** 全部声明了依赖的技能名 */
export function skillsWithRequirements(): string[] {
  return Object.keys(SKILL_REQUIREMENTS);
}

// ------------------------------------------------------------ 玄猪自身的依赖

/**
 * 生成 Linux 下的安装命令：自动识别包管理器。
 *
 * `sudo` 的处理是这里的关键：玄猪在 TUI 里用**管道**执行安装命令时 sudo 拿不到终端，
 * 会直接报「no tty present」而失败；而 `sudo -n` 又会因为没缓存凭据同样失败。
 * 因此命令自己判断有没有终端：
 *   - 有终端（`[ -t 0 ]`，即调用方已挂起界面、把终端交给它）→ 用普通 `sudo`，正常提示密码；
 *   - 没有终端（管道）→ 用 `sudo -n` **快速失败**，由调用方改为交互方式重跑。
 */
function linuxInstall(pkg: string): string {
  return [
    'SUDO="sudo -n"; [ -t 0 ] && SUDO="sudo"',
    `if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get install -y ${pkg}`,
    `elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y ${pkg}`,
    `elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y ${pkg}`,
    `elif command -v pacman >/dev/null 2>&1; then $SUDO pacman -S --noconfirm ${pkg}`,
    `elif command -v zypper >/dev/null 2>&1; then $SUDO zypper --non-interactive install ${pkg}`,
    `elif command -v apk >/dev/null 2>&1; then $SUDO apk add ${pkg}`,
    `else echo "未识别到受支持的包管理器（apt / dnf / yum / pacman / zypper / apk）" >&2; exit 1; fi`,
  ].join("; ");
}

const XCLIP: SkillRequirement = {
  name: "xclip（X11 剪贴板工具）",
  check: "command -v xclip",
  install: { linux: linuxInstall("xclip") },
};

const WL_CLIPBOARD: SkillRequirement = {
  name: "wl-clipboard（Wayland 剪贴板工具）",
  check: "command -v wl-paste",
  install: { linux: linuxInstall("wl-clipboard") },
};

/**
 * 玄猪**自身功能**需要的平台依赖（不属于任何技能）。
 *
 * 目前只有一项：读取系统剪贴板以支持 `Ctrl+V` 粘贴图片。
 * - Linux：需要 `xclip`（X11）或 `wl-clipboard`（Wayland），按当前会话选择；
 * - macOS：内置 osascript 退路，无需安装；
 * - Windows：内置 PowerShell，无需安装。
 *
 * 之所以按会话二选一而不是两个都装：安装要走 sudo 与网络，多装一个只是多一份
 * 失败面；而 `readClipboardImage()` 本来就会把两者都试一遍，装了哪个都能用。
 */
export function clipboardRequirements(
  platform: Platform = currentPlatform(),
): SkillRequirement[] {
  if (platform !== "linux") return [];
  const wayland = Boolean(
    process.env.WAYLAND_DISPLAY || process.env.WAYLAND_SOCKET,
  );
  return [wayland ? WL_CLIPBOARD : XCLIP];
}

/** 玄猪自身的依赖清单（用于 `xzh setup` 与 TUI 内的按需安装） */
export function runtimeRequirements(
  platform: Platform = currentPlatform(),
): SkillRequirement[] {
  return clipboardRequirements(platform);
}

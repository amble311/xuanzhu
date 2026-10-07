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

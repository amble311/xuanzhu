import * as fs from "fs";
import * as path from "path";
import { getBtcHome } from "../utils/paths";

/**
 * 平台选择（`xzh btc platform`）。
 *
 * 为什么单独存文件，而不是让用户去改 `~/.btc/.env`：
 * 交互式命令选完要**立刻生效并持久化**，而手写 `.env` 既要记变量名、又要重启进程；
 * 配置文件还能被 `xzh btc status` 读出来展示「当前用的是哪个平台、这个值来自哪」。
 *
 * 优先级（`activeExchange` 里实现）：
 * `BTC_EXCHANGE` 环境变量 > `~/.btc/platform.json` > 默认 binance。
 * 环境变量优先是为了 CI / 多环境：脚本里临时切换不该被文件覆盖。
 */

export interface PlatformSetting {
  version: 1;
  /** 已接入的适配器 id */
  platform: string;
  /** 何时设置的（ISO），仅用于展示与排查 */
  updatedAt?: string;
}

/** 计划中、尚未接入的平台：命令里显示为「开发中」，选中会明确拒绝 */
export const PLANNED_EXCHANGES = [
  { id: "huobi", label: "火币（Huobi）" },
  { id: "okx", label: "OKX" },
] as const;

export function platformPath(home = getBtcHome()): string {
  return path.join(home, "platform.json");
}

export function readPlatformSetting(home = getBtcHome()): string | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(platformPath(home), "utf8"),
    ) as Partial<PlatformSetting>;
    const id = typeof parsed.platform === "string" ? parsed.platform.trim() : "";
    return id ? id.toLowerCase() : undefined;
  } catch {
    // 不存在或写坏了都按「没设置」处理，回落到默认平台
    return undefined;
  }
}

export function setPlatformSetting(
  platform: string,
  home = getBtcHome(),
): PlatformSetting {
  const setting: PlatformSetting = {
    version: 1,
    platform: platform.trim().toLowerCase(),
    updatedAt: new Date().toISOString(),
  };
  const file = platformPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(setting, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return setting;
}

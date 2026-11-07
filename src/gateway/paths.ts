import * as os from "os";
import * as path from "path";

/**
 * gateway 的「工作目录」。
 *
 * 用户要求：`xzh gateway` 等价于在 `~/.xzh_gateway` 里启动 xzh，只是变成常驻后台服务。
 * 所以它既不是 `~/.xzh`（那是全局配置目录），也不是当前项目 —— 单独一个目录，
 * 记忆、会话、日志都归它自己，避免把微信频道的对话混进日常项目。
 *
 * `XZH_GATEWAY_HOME` 可重定向（测试与本机多实例调参用）。
 */
export function gatewayHome(): string {
  const override = process.env.XZH_GATEWAY_HOME?.trim();
  return override
    ? path.resolve(override)
    : path.join(os.homedir(), ".xzh_gateway");
}

/** 是否使用默认目录（自定义目录通常意味着调试/多实例，不该去改 systemd） */
export function isDefaultGatewayHome(): boolean {
  return gatewayHome() === path.join(os.homedir(), ".xzh_gateway");
}

export interface GatewayPaths {
  home: string;
  /** 运行时目录：pid 锁、状态 */
  run: string;
  logs: string;
  stateFile: string;
  lockFile: string;
  logFile: string;
}

export function gatewayPaths(home = gatewayHome()): GatewayPaths {
  return {
    home,
    run: path.join(home, "run"),
    logs: path.join(home, "logs"),
    stateFile: path.join(home, "run", "gateway.json"),
    lockFile: path.join(home, "run", "gateway.lock"),
    logFile: path.join(home, "logs", "gateway.log"),
  };
}

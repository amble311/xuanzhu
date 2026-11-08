import { ansi } from "../utils/ansi";
import {
  gatewayHome,
  gatewayPaths,
  isDefaultGatewayHome,
} from "../gateway/paths";
import {
  autostartStatus,
  gatewayStatus,
  installAutostart,
  restartGateway,
  startGateway,
  stopGateway,
  uninstallAutostart,
} from "../gateway/service";
import { runGateway, tailGatewayLog } from "../gateway/server";
import { weixinCommand } from "./weixin";

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function printStatus(): void {
  const status = gatewayStatus();
  const home = gatewayHome();
  const { logFile } = gatewayPaths(home);
  if (!status.running) {
    line(`${ansi.gray}gateway：${ansi.reset}${ansi.yellow}未运行${ansi.reset}`);
    if (status.stale) {
      line(`${ansi.gray}  有残留状态文件（进程已退出），下次启动会自动清理${ansi.reset}`);
    }
  } else {
    const state = status.state!;
    const uptime = Math.max(0, Math.round((Date.now() - Date.parse(state.startedAt)) / 1000));
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    line(
      `${ansi.gray}gateway：${ansi.reset}${ansi.green}运行中${ansi.reset}` +
        `${ansi.gray} pid ${state.pid} · 已运行 ${hours > 0 ? `${hours} 小时 ` : ""}${minutes} 分钟` +
        ` · 端口 ${state.port}${ansi.reset}`,
    );
    line(`${ansi.gray}  目录 ${state.cwd}${ansi.reset}`);
    if (state.model) line(`${ansi.gray}  模型 ${state.model}${ansi.reset}`);
    if (state.lastError) {
      line(`${ansi.yellow}  最近错误：${state.lastError}${ansi.reset}`);
    }
    line(`${ansi.gray}  健康检查：${ansi.reset}curl -s http://127.0.0.1:${state.port}/health`);
  }
  line(`${ansi.gray}  日志 ${logFile}${ansi.reset}`);
  const auto = status.autostart;
  if (!auto.supported) {
    line(`${ansi.gray}  开机自启：${ansi.reset}${ansi.gray}${auto.reason ?? "不支持"}${ansi.reset}`);
  } else {
    line(
      `${ansi.gray}  开机自启：${ansi.reset}` +
        (auto.enabled
          ? `${ansi.green}已启用${ansi.reset}${ansi.gray}（${auto.path}）${ansi.reset}`
          : `${ansi.yellow}未启用${ansi.reset}${ansi.gray}（xzh gateway autostart on）${ansi.reset}`),
    );
  }
}

function printStartFailure(error: string | undefined): void {
  line(`${ansi.red}✗ gateway 启动失败：${error ?? "未知原因"}${ansi.reset}`);
  const tail = tailGatewayLog(gatewayHome(), 8);
  if (tail) {
    line(`${ansi.gray}最近日志：\n${tail}${ansi.reset}`);
  }
}

export async function gatewayCommand(args: string[]): Promise<void> {
  const sub = (args[0] ?? "").trim().toLowerCase();

  // 常驻进程本体（systemd / detached 拉起时用；手动跑就是前台调试）
  if (sub === "run") {
    await runGateway();
    return;
  }

  if (sub === "weixin") {
    await weixinCommand(args.slice(1));
    return;
  }

  if (sub === "stop") {
    const result = await stopGateway();
    if (!result.ok) {
      line(`${ansi.red}✗ 停止失败：${result.error}${ansi.reset}`);
      return;
    }
    line(
      result.stopped
        ? `${ansi.green}✓ gateway 已停止${ansi.reset}`
        : `${ansi.gray}gateway 本来就没在运行${ansi.reset}`,
    );
    return;
  }

  if (sub === "restart") {
    const result = await restartGateway();
    if (!result.ok) {
      printStartFailure(result.error);
      return;
    }
    line(
      `${ansi.green}✓ gateway 已重启${ansi.reset}` +
        `${ansi.gray} pid ${result.state?.pid} · 端口 ${result.state?.port}${ansi.reset}`,
    );
    return;
  }

  if (sub === "status") {
    printStatus();
    return;
  }

  if (sub === "autostart") {
    const action = (args[1] ?? "status").trim().toLowerCase();
    const current = autostartStatus();
    if (!current.supported) {
      line(`${ansi.yellow}当前平台不支持自动安装：${current.reason}${ansi.reset}`);
      return;
    }
    if (action === "off") {
      const result = uninstallAutostart();
      line(
        result.ok
          ? `${ansi.green}✓ 已关闭开机自启${ansi.reset}`
          : `${ansi.red}✗ 关闭失败：${result.error}${ansi.reset}`,
      );
      return;
    }
    if (action === "on") {
      const result = installAutostart();
      if (!result.ok) {
        line(`${ansi.red}✗ 安装失败：${result.error}${ansi.reset}`);
        if (result.path) line(`${ansi.gray}  可手动检查：${result.path}${ansi.reset}`);
        return;
      }
      line(
        `${ansi.green}✓ 已启用开机自启${ansi.reset}${ansi.gray}（${result.path}）${ansi.reset}`,
      );
      if (process.platform === "linux") {
        line(
          `${ansi.gray}  远程/无桌面登录时还需要一次：loginctl enable-linger ${process.env.USER ?? "$USER"}${ansi.reset}`,
        );
      } else if (process.platform === "win32") {
        line(
          `${ansi.gray}  登录后由 wscript 隐藏拉起（崩溃 3 秒后自动重试）；关闭用 xzh gateway autostart off${ansi.reset}`,
        );
      }
      return;
    }
    printStatus();
    return;
  }

  if (sub && sub !== "start") {
    line(
      `${ansi.gray}用法：xzh gateway（启动）· stop · restart · status · autostart [on|off]${ansi.reset}`,
    );
    return;
  }

  // 默认：启动
  const result = await startGateway();
  if (!result.ok) {
    printStartFailure(result.error);
    return;
  }
  line(
    `${ansi.green}✓ gateway ${result.started ? "已启动" : "已在运行"}${ansi.reset}` +
      `${ansi.gray} pid ${result.state?.pid} · 端口 ${result.state?.port} · 目录 ${gatewayHome()}${ansi.reset}`,
  );
  line(
    `${ansi.gray}  健康检查 curl -s http://127.0.0.1:${result.state?.port}/health   ` +
      `消息 POST /message {"text":"..."}${ansi.reset}`,
  );

  // 首次启动顺手装开机自启（用户要求默认开启）；失败只提示，不影响服务。
  // 只在默认目录时才装：自定义目录（调试/多实例）不该改写 systemd。
  const auto = autostartStatus();
  if (auto.supported && !auto.enabled && isDefaultGatewayHome()) {
    const installed = installAutostart();
    if (installed.ok) {
      line(`${ansi.gray}  已启用开机自启（${installed.path}）${ansi.reset}`);
    } else {
      line(
        `${ansi.yellow}  开机自启未启用：${installed.error}${ansi.reset}` +
          `${ansi.gray}（服务不受影响，可稍后 xzh gateway autostart on）${ansi.reset}`,
      );
    }
  }
}

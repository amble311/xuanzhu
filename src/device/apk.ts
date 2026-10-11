import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getConfigDir } from "../utils/paths";

/**
 * AutoJs6 安装包的**定位与安装引导**。
 *
 * ⚠ 玄猪**不打包 APK**：AutoJs6 每个 ABI 的安装包 130 MB 上下，两个就 270 MB ——
 * 塞进 npm 包会让每个用户平白多下几百 MB，而且绝大多数人只需要其中一个。
 * 因此这里只做三件事：
 *
 * 1. **探测该用哪个 ABI**（`adb` 能读到就精确判断，否则按统计默认 `arm64-v8a`）；
 * 2. **给官方下载地址**（`AutoJs6` 的 GitHub Releases）；
 * 3. **顺带看一眼本机有没有现成的 APK**（`~/.xzh/apks/`）—— 有就告诉用户路径，
 *    不联网也能装。这是"本地缓存"而不是"分发"。
 */

/** AutoJs6 官方发布页（用户自行下载安装包） */
export const AUTOJS6_RELEASES_URL =
  "https://github.com/SuperMonster003/AutoJs6/releases/";

/** 本机 APK 缓存目录：有就优先用，没有就引导去官方下载 */
export function apkCacheDir(): string {
  return path.join(getConfigDir(), "apks");
}

export type AndroidAbi = "arm64-v8a" | "armeabi-v7a" | "x86_64" | "x86";

/** 能识别的 ABI（与 AutoJs6 发布包的命名一致） */
const KNOWN_ABIS: AndroidAbi[] = ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"];

export interface AbiDetection {
  abi: AndroidAbi;
  source: "adb" | "default";
  /** 说明文字（会原样展示给用户，所以要求可读） */
  detail: string;
}

/**
 * 探测目标手机该装哪个 ABI 的包。
 *
 * 优先用 `adb`：`ro.product.cpu.abi` 是设备自报的，最准。但 adb 常常不可用
 * （没装、没连线、没开无线调试），因此必须有默认值 —— **默认 `arm64-v8a`**：
 * 2018 年后的手机几乎全是 64 位 ARM，`x86_64` 基本只出现在模拟器上。
 */
export function detectAndroidAbi(): AbiDetection {
  try {
    const devices = execFileSync("adb", ["devices"], {
      timeout: 5_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // 输出形如：`List of devices attached\n<serial>\tdevice\n`
    const online = devices
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.endsWith("\tdevice"));
    if (online.length > 0) {
      const abi = execFileSync("adb", ["shell", "getprop", "ro.product.cpu.abi"], {
        timeout: 5_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() as AndroidAbi;
      if (KNOWN_ABIS.includes(abi)) {
        return { abi, source: "adb", detail: `由 adb 读取设备信息得到（${online.length} 台设备在线）` };
      }
    }
  } catch {
    // adb 不存在 / 没设备 / 超时：都退回默认值，不值得打扰用户
  }
  return {
    abi: "arm64-v8a",
    source: "default",
    detail: "未检测到 adb 设备，按主流机型默认选择（模拟器请选 x86_64）",
  };
}

export interface LocalApk {
  path: string;
  sizeBytes: number;
}

/** 在 `~/.xzh/apks/` 里找与目标 ABI 匹配的安装包（文件名里含 ABI 即算匹配） */
export function findLocalApk(abi: AndroidAbi, dir = apkCacheDir()): LocalApk | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null; // 目录不存在 = 没有缓存，属于正常情况
  }

  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".apk")) continue;
    if (!entry.toLowerCase().includes(abi.toLowerCase())) continue;
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) return { path: full, sizeBytes: stat.size };
    } catch {
      // 单个文件读不了就跳过
    }
  }
  return null;
}

/**
 * xzh 是否运行在**手机本机**（termux 这类 Linux 环境）。
 *
 * 判据取 Termux 的 `PREFIX`（形如 `/data/data/com.termux/files/usr`）与 Android 的
 * 环境变量/目录 —— 不依赖发行版名称，且不需要执行任何外部命令。
 */
export function isRunningOnAndroid(): boolean {
  if (process.env.PREFIX?.includes("com.termux")) return true;
  if (process.env.ANDROID_ROOT || process.env.ANDROID_DATA) return true;
  try {
    return fs.existsSync("/system/build.prop");
  } catch {
    return false;
  }
}

export interface SetupGuideOptions {
  /** `pc`：xzh 在电脑上；`phone`：xzh 就在手机本机 */
  where: "pc" | "phone";
  /** 探测到的 ABI */
  abi: AndroidAbi;
  /** 已经填/尝试连接的地址（可为空） */
  address?: string;
  /** 本机缓存里找到的 APK */
  localApk?: LocalApk | null;
}

/** 把字节数格式化成可读形式 */
function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

/**
 * 生成「首次操作手机」的引导文案。
 *
 * 这是用户第一次接触设备桥时看到的全部信息，因此要求：**不假设用户已经装好 AutoJs6**、
 * 每一步都能照做、并且明确指出"连不上时先看哪一条"。电脑端与手机端分开写 ——
 * 手机端不需要填 IP（走 `127.0.0.1`），照着电脑端做只会白折腾。
 */
export function buildDeviceSetupGuide(options: SetupGuideOptions): string {
  const { where, abi, address, localApk } = options;
  const lines: string[] = [];

  lines.push("首次连接手机需要装 AutoJs6（它提供无障碍能力，xzh 通过它操作手机）：");
  lines.push("");
  lines.push(`  1. 手机安装 AutoJs6 —— 下载页：${AUTOJS6_RELEASES_URL}`);
  lines.push(
    `     选 ${abi} 版本${abi === "arm64-v8a" ? "（绝大多数手机）" : "（模拟器/特殊机型）"}`,
  );
  if (localApk) {
    lines.push(
      `     本机已有现成安装包：${localApk.path}（${formatSize(localApk.sizeBytes)}）`,
    );
  } else {
    lines.push(
      `     也可以把安装包放到 ${apkCacheDir()}/，下次会直接提示本机路径`,
    );
  }
  lines.push("  2. 手机打开 AutoJs6 → 侧边栏「连接电脑」→ 打开「服务器模式」（端口 7347）");
  if (where === "pc") {
    lines.push(
      `  3. 在本机执行：xzh device connect <手机IP>${address ? `   （你刚试的是 ${address}）` : ""}`,
    );
    lines.push("     手机 IP 看「设置 → 关于手机 → 状态信息」，或手机 AutoJs6 服务器模式页面上显示的地址");
  } else {
    lines.push(
      `  3. 在本机（手机）执行：xzh device connect 127.0.0.1${address ? `   （你刚试的是 ${address}）` : ""}`,
    );
    lines.push("     在手机本机运行不需要填 IP，也不需要联网");
  }
  lines.push("");
  lines.push("连不上时按顺序排查：");
  lines.push("  · AutoJs6 的「服务器模式」是否已打开（不是「客户端模式」）");
  if (where === "pc") {
    lines.push("  · 手机与电脑是否在同一局域网（不同网段 / 手机流量 / VPN 都不通）");
    lines.push("  · 路由器是否开了「AP 隔离」（同 WiFi 下设备互相不通，是最常见的原因）");
  }
  lines.push("  · 端口是否被改过（xzh 默认连 7347，与 AutoJs6 服务器模式默认一致）");
  lines.push("  · 手机端 AutoJs6 是否被系统后台限制（OPPO/小米等需允许后台运行）");

  return lines.join("\n");
}

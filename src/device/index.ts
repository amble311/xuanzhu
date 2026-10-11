/**
 * 设备桥：把「操作手机」的能力搬进 xzh，两种传输并存于同一套设备注册表。
 *
 * ```
 * src/device/
 *   protocol.ts        AutoX.js 的线协议（WebSocket 文本帧；手机连电脑）
 *   server.ts          DeviceBridge —— 设备注册表 / 日志缓冲 / 本地 HTTP 控制通道
 *   client.ts          控制通道客户端（一次性 CLI 命令与 Agent 工具共用）
 *   apk.ts             AutoJs6 安装包的 ABI 探测、本地缓存查找与安装引导
 *   autojs6/
 *     protocol.ts      AutoJs6 的线协议（裸 TCP + 8 字节分帧；xzh 连手机）
 *     client.ts        AutoJs6 出站连接（含断线重连与放弃策略）
 * ```
 *
 * ⚠ `autojs6/protocol.ts` **不整体 re-export**：它的 `helloReply` / `commandMessage`
 * 等名字与 `./protocol.ts` 冲突，全部导出会互相覆盖。按需具名导出。
 */
export * from "./protocol";
export * from "./server";
export * from "./client";
export * from "./apk";
export { buildScreenshotScript, type ScreenshotScriptOptions } from "./screenshot";
export { buildUiDumpScript, UI_DUMP_MAX_NODES } from "./ui-dump";
export {
  AUTOJS6_APP_SERVER_PORT,
  AUTOJS6_PC_SERVER_PORT,
} from "./autojs6/protocol";
export type { AutoJs6Client } from "./autojs6/client";
export type { AutoJs6Peer, AutoJs6ServerOptions } from "./autojs6/server";
export { AutoJs6Server } from "./autojs6/server";

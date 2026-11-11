/**
 * 统一把 UTC/ISO 时间转成**本机时区**展示。
 *
 * btc 后端的排期、动作、叫醒评估都是 UTC ISO（带 Z）；之前直接
 * `slice(11,16)` 会把 UTC 当本地时间显示，和用户所在时区差 8 小时。
 */

export type LocalTimeStyle = "time" | "monthday" | "date" | "datetime";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatLocalTime(
  value: string | number | Date | null | undefined,
  style: LocalTimeStyle = "time",
): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  switch (style) {
    case "date":
      return ymd;
    case "monthday":
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hhmm}`;
    case "datetime":
      return `${ymd} ${hhmm}`;
    default:
      return hhmm;
  }
}

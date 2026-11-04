import { memo } from "react";

/** 只读时间使用原生 time 语义，不引入可编辑日期控件。 */
export const DateTime = memo(function DateTime({ value, label = "日期时间" }: {
  value: number | string | null | undefined;
  label?: string;
}) {
  if (value == null || value === "") return <span>—</span>;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value.replace(" ", "T"));
  if (!Number.isFinite(date.getTime())) return <span>—</span>;
  return <time className="readonly-date" aria-label={label} dateTime={date.toISOString()}>
    {date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}
  </time>;
});

export const Time = memo(function Time({ value, label = "时间" }: { value: number; label?: string }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>—</span>;
  return <time className="readonly-date" aria-label={label} dateTime={date.toISOString()}>
    {date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })}
  </time>;
});

import { memo } from "react";
import { DateField, TimeField } from "@heroui/react";
import { fromDate, getLocalTimeZone, parseDateTime, toCalendarDateTime, toTime } from "@internationalized/date";

/** Read-only timestamps share HeroUI's date segments without looking editable. */
export const DateTime = memo(function DateTime({ value, label = "日期时间" }: {
  value: number | string | null | undefined;
  label?: string;
}) {
  let date;
  try {
    if (value == null || value === "") return <span>—</span>;
    date = typeof value === "number"
      ? toCalendarDateTime(fromDate(new Date(value * 1000), getLocalTimeZone()))
      : parseDateTime(value.length === 10 ? `${value}T00:00` : value.replace(" ", "T"));
  } catch {
    return <span>—</span>;
  }
  return <DateField className="readonly-date" aria-label={label} value={date} isReadOnly isDisabled granularity="minute" hourCycle={24}>
    <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
  </DateField>;
});

export const Time = memo(function Time({ value, label = "时间" }: { value: number; label?: string }) {
  if (!Number.isFinite(value)) return <span>—</span>;
  const time = toTime(fromDate(new Date(value), getLocalTimeZone()));
  return <TimeField className="readonly-date" aria-label={label} value={time} isReadOnly isDisabled granularity="second" hourCycle={24}>
    <TimeField.Input>{(segment) => <TimeField.Segment segment={segment} />}</TimeField.Input>
  </TimeField>;
});

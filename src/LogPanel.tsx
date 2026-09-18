import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button, Chip, ScrollShadow } from "@heroui/react";
import { LOG_EVENT, LogEvent, LogKind } from "./api";

const MAX_LINES = 2000;

export function useGitLog() {
  const [lines, setLines] = useState<LogEvent[]>([]);
  useEffect(() => {
    const un = listen<LogEvent>(LOG_EVENT, (e) => {
      setLines((ls) => {
        const next = ls.length >= MAX_LINES ? ls.slice(ls.length - MAX_LINES + 1) : ls.slice();
        next.push(e.payload);
        return next;
      });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);
  return { lines, clear: () => setLines([]) };
}

const TEXT: Record<LogKind, string> = {
  cmd: "text-accent font-medium",
  stdout: "text-foreground",
  stderr: "text-muted",
  info: "text-success",
  error: "text-danger",
};

function time(ts: number) {
  return new Date(ts).toTimeString().slice(0, 8);
}

/** 命令日志：浅色次级表面，与主界面一致 */
export function LogPanel({
  lines,
  clear,
  open,
  setOpen,
}: {
  lines: LogEvent[];
  clear: () => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const errors = lines.filter((l) => l.kind === "error").length;

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, open]);

  return (
    <section
      aria-label="命令日志"
      className={
        "relative flex shrink-0 flex-col border-t border-border bg-default/60 transition-[height] duration-300 " +
        (open ? "h-[24%] min-h-36" : "h-11")
      }
    >
      <div className="flex h-11 shrink-0 items-center gap-3 px-4">
        <Button
          size="sm"
          variant="ghost"
          className="text-muted hover:text-foreground"
          onPress={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span className={"inline-block transition-transform duration-200 " + (open ? "rotate-90" : "")}>›</span>
          <span className="font-mono text-[11px] tracking-[0.15em] text-accent uppercase">命令日志</span>
        </Button>
        <Chip size="sm" variant="secondary" className="font-mono">
          {lines.length}
        </Chip>
        {errors > 0 && (
          <Chip size="sm" variant="soft" color="danger">
            {errors} 个错误
          </Chip>
        )}
        <span className="flex-1" />
        {open && lines.length > 0 && (
          <Button size="sm" variant="ghost" className="text-muted hover:text-foreground" onPress={clear}>
            清空
          </Button>
        )}
      </div>
      {open && (
        <ScrollShadow ref={bodyRef} hideScrollBar={false} className="flex-1 px-5 pb-3 font-mono text-[12px] leading-relaxed">
          {lines.length === 0 && <p className="py-2 text-muted">执行操作后，这里会显示每条 git 命令及其输出。</p>}
          {lines.map((l, i) => (
            <div key={i} className="flex gap-3 break-all whitespace-pre-wrap">
              <span className="shrink-0 text-muted/60">{time(l.ts)}</span>
              <span className={TEXT[l.kind]}>
                {l.kind === "cmd" ? "$ " : ""}
                {l.text}
              </span>
            </div>
          ))}
        </ScrollShadow>
      )}
    </section>
  );
}

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button, Chip, ScrollShadow } from "@heroui/react";
import { LOG_EVENT, LogEvent, LogKind } from "./api";
import { Icon } from "./icons";

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

/** 可收起的命令面板，使用独立的日志滚动区域。 */
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
  const [following, setFollowing] = useState(true);
  const errors = lines.filter((l) => l.kind === "error").length;

  useEffect(() => {
    const el = bodyRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [lines, open, following]);

  return (
    <section aria-label="命令日志" className="log-panel" data-open={open}>
      <div className="log-toolbar">
        <Button
          size="sm"
          variant="ghost"
          className="log-toggle"
          onPress={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls="git-log-output"
        >
          <Icon name="terminal" /><span>命令日志</span><Icon name="chevron" className="log-chevron" />
        </Button>
        <span className="log-count" aria-label={`${lines.length} 条日志`}>{lines.length}</span>
        {errors > 0 && (
          <Chip size="sm" variant="soft" color="danger">
            {errors} 个错误
          </Chip>
        )}
        <span className="flex-1" />
        {open && <Button size="sm" variant="ghost" aria-pressed={following} onPress={() => setFollowing(!following)}>
          {following ? "暂停跟随" : "跟随最新"}
        </Button>}
        {open && lines.length > 0 && (
          <Button size="sm" variant="ghost" className="text-muted hover:text-foreground" onPress={clear}>
            清空
          </Button>
        )}
      </div>
      {open && (
        <ScrollShadow id="git-log-output" aria-label="命令输出" tabIndex={0} ref={bodyRef} onScroll={(event) => {
          const el = event.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight > 24) setFollowing(false);
        }} hideScrollBar={false} className="log-output flex-1 px-5 pb-3 font-mono text-[12px] leading-relaxed">
          {lines.length === 0 && <p className="py-2 text-muted">执行操作后，这里会显示每条 git 命令及其输出。</p>}
          {lines.map((l, i) => (
            <div key={i} className="flex gap-3 break-all whitespace-pre-wrap">
              <span className="shrink-0 text-muted">{time(l.ts)}</span>
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

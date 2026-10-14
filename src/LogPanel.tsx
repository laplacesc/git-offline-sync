import { CSSProperties, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button, Chip } from "@heroui/react";
import { LOG_EVENT, LogEvent } from "./api";
import { Icon } from "./icons";
import { OperationRecord, useRunner } from "./runner";

export type RecordedLog = LogEvent & { operationId?: number };

const MAX_LINES = 2000;

export function useGitLog() {
  const { activeRun } = useRunner();
  const [lines, setLines] = useState<RecordedLog[]>([]);
  useEffect(() => {
    const un = listen<LogEvent>(LOG_EVENT, (e) => {
      const line = { ...e.payload, operationId: activeRun.current ?? undefined };
      setLines((ls) => {
        const next = ls.length >= MAX_LINES ? ls.slice(ls.length - MAX_LINES + 1) : ls.slice();
        next.push(line);
        return next;
      });
    });
    return () => {
      un.then((f) => f());
    };
  }, [activeRun]);
  return { lines, clear: () => setLines([]) };
}

function time(ts: number) {
  return new Date(ts).toTimeString().slice(0, 8);
}

function operationStatus(operation: OperationRecord | undefined, failed: boolean, older: boolean): string {
  if (!operation) return older ? "操作详情已清理" : "后台读取";
  if (operation.endedAt === undefined) return "运行中";
  if (failed) return "有错误";
  if (operation.stopRequested) return "已结束 · 曾请求停止";
  return "已结束";
}

/** 可收起的命令面板，使用独立的日志滚动区域。 */
export function LogPanel({
  lines,
  clear,
  open,
  setOpen,
  operations = [],
}: {
  lines: RecordedLog[];
  operations?: OperationRecord[];
  clear: () => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [height, setHeight] = useState(240);
  const [copyState, setCopyState] = useState("");
  const groups = new Map<number | undefined, { operation?: OperationRecord; lines: RecordedLog[] }>();
  for (const operation of operations) groups.set(operation.id, { operation, lines: [] });
  for (const line of lines) {
    const key = line.operationId;
    if (!groups.has(key)) groups.set(key, { lines: [] });
    groups.get(key)!.lines.push(line);
  }
  const orderedGroups = [...groups.entries()].sort(([, a], [, b]) =>
    (a.operation?.startedAt ?? a.lines[0]?.ts ?? 0) - (b.operation?.startedAt ?? b.lines[0]?.ts ?? 0));
  const errors = lines.filter((l) => l.kind === "error").length;

  useEffect(() => {
    const el = bodyRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [lines, open, following]);

  return (
    <section aria-label="命令日志" className="log-panel" data-open={open} style={{ "--log-height": `${height}px` } as CSSProperties}>
      {open && <div className="log-resize" role="separator" aria-label="调整日志高度" aria-orientation="horizontal"
        aria-valuemin={150} aria-valuemax={480} aria-valuenow={height} tabIndex={0}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          if (event.key === "Home") setHeight(150);
          else if (event.key === "End") setHeight(480);
          else setHeight((h) => Math.max(150, Math.min(480, h + (event.key === "ArrowUp" ? 20 : -20))));
        }}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            const bottom = event.currentTarget.parentElement!.getBoundingClientRect().bottom;
            setHeight(Math.max(150, Math.min(480, bottom - event.clientY)));
          }
        }} onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)} /> }
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
        {open && <>
          <Button size="sm" variant="ghost" isIconOnly aria-label="缩小日志面板" isDisabled={height <= 150} onPress={() => setHeight((h) => Math.max(150, h - 60))}>−</Button>
          <Button size="sm" variant="ghost" isIconOnly aria-label="增大日志面板" isDisabled={height >= 480} onPress={() => setHeight((h) => Math.min(480, h + 60))}>+</Button>
        </>}
        {open && <Button size="sm" variant="ghost" aria-pressed={following} onPress={() => setFollowing(!following)}>
          {following ? "暂停跟随" : "跟随最新"}
        </Button>}
        {open && lines.length > 0 && <Button size="sm" variant="ghost" onPress={async () => {
          try {
            await navigator.clipboard.writeText(lines.map((line) => `${time(line.ts)} ${line.kind === "cmd" ? "$ " : ""}${line.text}`).join("\n"));
            setCopyState("已复制");
          } catch { setCopyState("复制失败，请选择日志文本复制"); }
        }}>复制日志</Button>}
        {open && copyState && <span role="status" className="log-count">{copyState}</span>}
        {open && (lines.length > 0 || operations.length > 0) && (
          <Button size="sm" variant="ghost" className="text-muted hover:text-foreground" onPress={() => { clear(); setCopyState(""); }}>
            清空
          </Button>
        )}
      </div>
      {open && (
        <div id="git-log-output" aria-label="命令输出" tabIndex={0} ref={bodyRef} onScroll={(event) => {
          const el = event.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight > 24) setFollowing(false);
        }} className="log-output flex-1">
          {orderedGroups.length === 0 && <p className="px-4 py-2 log-count">执行操作后，这里会显示每条 git 命令及其输出。</p>}
          {orderedGroups.map(([id, group]) => {
            const op = group.operation;
            const failed = op?.failed || group.lines.some((line) => line.kind === "error");
            const status = operationStatus(op, failed, id !== undefined);
            return <details key={id ?? "background"} className="log-group" open>
              <summary><Icon name="terminal" /><strong>{op?.label ?? (id === undefined ? "仓库状态与其他输出" : `较早操作 #${id}`)}</strong>
                <span className={failed ? "text-danger" : "log-count"}>{status}</span>
                {op && <span className="log-duration">{time(op.startedAt)}{op.endedAt !== undefined ? ` · ${((op.endedAt - op.startedAt) / 1000).toFixed(1)}s` : ""}</span>}
              </summary>
              {op?.stopRequested && <p className="log-line text-warning">已请求停止；停止不代表回滚，请检查操作结果。</p>}
              {group.lines.map((line, i) => <div key={i} className="log-line">
                <span className="log-time">{time(line.ts)}</span><span className={`log-${line.kind}`}>{line.text}</span>
              </div>)}
              {!group.lines.length && <p className="log-line log-count">暂无命令输出</p>}
            </details>;
          })}
        </div>
      )}
    </section>
  );
}

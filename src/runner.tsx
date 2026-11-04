import { createContext, MutableRefObject, ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import { Spinner } from "./components/ui/spinner";
import { WindowControls } from "./WindowControls";
import { api } from "./api";
import { Notice } from "./Notice";

export type NoticeKind = "ok" | "warn" | "error" | "progress";
type OperationNotice = { id: number; kind: NoticeKind; text: string };
const noticeTones = { ok: "success", warn: "warning", error: "danger", progress: "accent" } as const;

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  tone?: "accent" | "warning" | "danger";
}

export interface OperationRecord {
  id: number;
  label: string;
  startedAt: number;
  endedAt?: number;
  failed?: boolean;
  needsAttention?: boolean;
  stopRequested?: boolean;
}

interface Runner {
  operations: OperationRecord[];
  activeRun: MutableRefObject<number | null>;
  clearOperations: () => void;
  /** 当前正在执行的操作名，null 表示空闲 */
  busy: string | null;
  notices: OperationNotice[];
  cancelRequested: boolean;
  requestCancel: () => Promise<void>;
  dismissNotice: (id: number) => void;
  notify: (kind: NoticeKind, text: string) => number;
  /** 串行执行一个操作：期间所有按钮禁用，失败时显示错误横幅并返回 undefined */
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
  /** AlertDialog 确认框，返回用户是否确认 */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const Ctx = createContext<Runner | null>(null);
const PopupHostContext = createContext<{ active: string | undefined; register: (id: string) => () => void }>({ active: undefined, register: () => () => {} });

export function RunnerProvider({ children }: { children: ReactNode }) {
  const [popupHosts, setPopupHosts] = useState<string[]>([]);
  const registerPopupHost = useCallback((id: string) => {
    setPopupHosts((hosts) => [...hosts, id]);
    return () => setPopupHosts((hosts) => hosts.filter((host) => host !== id));
  }, []);
  const [operations, setOperations] = useState<OperationRecord[]>([]);
  const activeRun = useRef<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<OperationNotice[]>([]);
  const noticeSeq = useRef(0);
  const busyRef = useRef(false);
  const runSeq = useRef(0);
  const cancelPending = useRef(false);
  const [cancelRequested, setCancelRequested] = useState(false);

  const notify = useCallback((kind: NoticeKind, text: string) => {
    const notice = { id: ++noticeSeq.current, kind, text };
    setNotices((previous) => [notice, ...previous.filter((item) => item.kind !== kind || item.text !== text)]);
    return notice.id;
  }, []);
  const dismissNotice = useCallback((id: number) => {
    setNotices((previous) => previous.filter((notice) => notice.id !== id));
  }, []);

  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      if (busyRef.current) return undefined;
      busyRef.current = true;
      const id = ++runSeq.current;
      activeRun.current = id;
      setOperations((records) => [...records.slice(-99), { id, label, startedAt: Date.now() }]);
      cancelPending.current = false;
      setCancelRequested(false);
      setBusy(label);
      setNotices((previous) => previous.filter((notice) => notice.kind !== "ok"));
      try {
        const result = await fn();
        if (result && typeof result === "object") {
          const outcome = result as { ok?: boolean; message?: string; conflict?: boolean; outcomes?: { ok: boolean }[] };
          if (typeof outcome.ok === "boolean" && outcome.message) {
            let kind: NoticeKind = "ok";
            if (!outcome.ok) kind = outcome.conflict ? "warn" : "error";
            notify(kind, outcome.message);
          }
          if (outcome.ok === false || (Array.isArray(outcome.outcomes) && outcome.outcomes.some((item) => !item.ok))) {
            setOperations((records) => records.map((record) => record.id === id ? { ...record, needsAttention: true } : record));
          }
        }
        return result;
      } catch (e) {
        setOperations((records) => records.map((record) => record.id === id ? { ...record, failed: true } : record));
        notify("error", `${label}失败：${String(e)}`);
        return undefined;
      } finally {
        activeRun.current = null;
        setOperations((records) => records.map((record) => record.id === id ? { ...record, endedAt: Date.now() } : record));
        busyRef.current = false;
        setBusy(null);
        setCancelRequested(false);
      }
    },
    [notify],
  );

  const requestCancel = useCallback(async () => {
    if (!busyRef.current || cancelPending.current) return;
    const seq = runSeq.current;
    cancelPending.current = true;
    setCancelRequested(true);
    try {
      const id = await api.activeOperation();
      if (seq !== runSeq.current || !busyRef.current) return;
      const sent = id !== null && await api.cancelOperation(id);
      if (seq !== runSeq.current || !busyRef.current) return;
      if (sent) setOperations((records) => records.map((record) => record.id === seq ? { ...record, stopRequested: true } : record));
      if (!sent) {
        cancelPending.current = false;
        setCancelRequested(false);
        notify("warn", "当前没有可停止的 Git 操作，请等待完成或稍后重试");
      }
    } catch (e) {
      if (seq !== runSeq.current || !busyRef.current) return;
      cancelPending.current = false;
      setCancelRequested(false);
      notify("error", `停止请求失败：${String(e)}`);
    }
  }, [notify]);

  // ---------- 确认框 ----------
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirmReturnFocus = useRef<HTMLElement | null>(null);
  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
      confirmReturnFocus.current = document.activeElement as HTMLElement | null;
      setDialog({ ...opts, resolve });
    }),
    [],
  );
  const close = (v: boolean) => {
    dialog?.resolve(v);
    setDialog(null);
  };

  return (
    <Ctx.Provider value={{ operations, activeRun, clearOperations: () => setOperations((records) => records.filter((record) => record.id === activeRun.current)), busy, notices, cancelRequested, requestCancel, dismissNotice, notify, run, confirm }}>
      <PopupHostContext.Provider value={{ active: popupHosts[popupHosts.length - 1], register: registerPopupHost }}>
      {children}
      <AlertDialog open={!!dialog} onOpenChange={(open) => { if (!open) close(false); }}>
        <AlertDialogContent className="sm:max-w-md app-surface"
          topLayer={<><WindowControls inline /><OperationStatus inline /></>}
          onCloseAutoFocus={(event) => { event.preventDefault(); if (confirmReturnFocus.current?.isConnected) confirmReturnFocus.current.focus(); }}>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialog?.title}</AlertDialogTitle>
            <AlertDialogDescription asChild><div>{dialog?.body}</div></AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" onClick={() => close(false)}>取消</AlertDialogCancel>
            <AlertDialogAction type="button" variant={dialog?.tone === "danger" ? "destructive" : "default"} onClick={() => close(true)}>
              {dialog?.confirmLabel ?? "确认"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </PopupHostContext.Provider>
    </Ctx.Provider>
  );
}

function OperationPopup({ notice, dismiss }: { notice: OperationNotice; dismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  useEffect(() => {
    if (notice.kind !== "ok" || paused) return;
    const timer = setTimeout(() => dismiss(notice.id), 5000);
    return () => clearTimeout(timer);
  }, [notice.id, notice.kind, dismiss, paused]);
  return <div className="operation-popup" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    }}>
    <Notice tone={noticeTones[notice.kind]} title={notice.text}
      indicator={notice.kind === "progress" ? <Spinner className="size-4" /> : undefined}
      actions={<Button type="button" size="icon-sm" variant="ghost" onClick={() => dismiss(notice.id)}
        aria-label={notice.kind === "error" ? "关闭错误提示" : "关闭提示"}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="m3 3 8 8m0-8-8 8" />
        </svg>
      </Button>} />
  </div>;
}

export function OperationStatus({ inline = false }: { inline?: boolean }) {
  const { busy, notices, dismissNotice, cancelRequested, requestCancel } = useRunner();
  const id = useId();
  const { active, register } = useContext(PopupHostContext);
  useEffect(() => { if (inline) return register(id); }, [inline, id, register]);
  // 只让最上层弹窗承载提示，避免同一通知重复显示和重复计时。
  if ((inline ? active !== id : !!active) || (!busy && !notices.length)) return null;
  // 独立浮层，不占用工作区空间；弹窗打开时仍可读取、聚焦和关闭。
  const content = <section className="operation-popups" aria-label="操作提示">
      {busy && <div className="operation-popup"><Notice tone="accent" indicator={<Spinner className="size-4" />}
        title={cancelRequested ? "已请求停止，正在等待 Git 退出并检查操作结果…" : `正在${busy}，请稍候…`}
        actions={<Button type="button" size="sm" variant="secondary" disabled={cancelRequested} onClick={requestCancel}>
          {cancelRequested ? "等待停止" : "请求停止"}
        </Button>} /></div>}
      {notices.map((notice) => <OperationPopup key={notice.id} notice={notice} dismiss={dismissNotice} />)}
    </section>;
  return inline ? content : createPortal(content, document.body);
}

export function Feedback({ kind, text }: { kind: NoticeKind; text: string }) {
  return <Notice tone={noticeTones[kind]} title={text}
    indicator={kind === "progress" ? <Spinner className="size-4" /> : undefined} />;
}

export function useRunner(): Runner {
  const r = useContext(Ctx);
  if (!r) throw new Error("useRunner outside RunnerProvider");
  return r;
}

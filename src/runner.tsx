import { createContext, ReactNode, useCallback, useContext, useRef, useState } from "react";
import { AlertDialog, Button, Spinner, toast } from "@heroui/react";

export type NoticeKind = "ok" | "warn" | "error";

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  tone?: "accent" | "warning" | "danger";
}

interface Runner {
  /** 当前正在执行的操作名，null 表示空闲 */
  busy: string | null;
  error: string | null;
  dismissError: () => void;
  notify: (kind: NoticeKind, text: string) => void;
  /** 串行执行一个操作：期间所有按钮禁用，失败时弹出错误提示并返回 undefined */
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
  /** HeroUI AlertDialog 确认框，返回用户是否确认 */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const Ctx = createContext<Runner | null>(null);

export function RunnerProvider({ children }: { children: ReactNode }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const notify = useCallback((kind: NoticeKind, text: string) => {
    if (kind === "ok") toast.success(text);
    else if (kind === "warn") toast.warning(text);
    else toast.danger(text, { timeout: 0 });
  }, []);

  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      if (busyRef.current) return undefined;
      busyRef.current = true;
      setBusy(label);
      setError(null);
      try {
        return await fn();
      } catch (e) {
        setError(`${label}失败：${String(e)}`);
        toast.danger(`${label}失败`, { description: String(e), timeout: 0 });
        return undefined;
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [],
  );

  // ---------- 确认框 ----------
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setDialog({ ...opts, resolve })),
    [],
  );
  const close = (v: boolean) => {
    dialog?.resolve(v);
    setDialog(null);
  };

  return (
    <Ctx.Provider value={{ busy, error, dismissError: () => setError(null), notify, run, confirm }}>
      {children}
      <AlertDialog.Backdrop isOpen={!!dialog} onOpenChange={(o) => !o && close(false)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-md">
            <AlertDialog.Header>
              <AlertDialog.Icon status={dialog?.tone ?? "accent"} />
              <AlertDialog.Heading>{dialog?.title}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>{dialog?.body}</AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" onPress={() => close(false)}>
                取消
              </Button>
              <Button variant={dialog?.tone === "danger" ? "danger" : "primary"} onPress={() => close(true)}>
                {dialog?.confirmLabel ?? "确认"}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </Ctx.Provider>
  );
}

export function OperationStatus() {
  const { busy, error, dismissError } = useRunner();
  if (!busy && !error) return null;
  return (
    <div className="border-b border-border bg-surface px-5 py-3">
      {busy && <p role="status" className="flex items-center gap-2 text-sm"><Spinner size="sm" />正在{busy}，请稍候…</p>}
      {error && <div role="alert" className="flex items-start gap-3 text-sm">
        <p className="min-w-0 flex-1 break-all text-danger">{error}</p>
        <Button size="sm" variant="ghost" onPress={dismissError}>关闭错误提示</Button>
      </div>}
    </div>
  );
}

export function useRunner(): Runner {
  const r = useContext(Ctx);
  if (!r) throw new Error("useRunner outside RunnerProvider");
  return r;
}

import { createContext, ReactNode, useCallback, useContext, useRef, useState } from "react";
import { AlertDialog, Button, toast } from "@heroui/react";

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
  notify: (kind: NoticeKind, text: string) => void;
  /** 串行执行一个操作：期间所有按钮禁用，失败时弹出错误提示并返回 undefined */
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
  /** HeroUI AlertDialog 确认框，返回用户是否确认 */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const Ctx = createContext<Runner | null>(null);

export function RunnerProvider({ children }: { children: ReactNode }) {
  const [busy, setBusy] = useState<string | null>(null);
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
      try {
        return await fn();
      } catch (e) {
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
    <Ctx.Provider value={{ busy, notify, run, confirm }}>
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

export function useRunner(): Runner {
  const r = useContext(Ctx);
  if (!r) throw new Error("useRunner outside RunnerProvider");
  return r;
}

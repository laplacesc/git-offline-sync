import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@heroui/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useRunner } from "./runner";

/** Windows caption controls. close() preserves CloseRequested and window-state saving. */
export function WindowControls() {
  const [appWindow] = useState(getCurrentWindow);
  const [maximized, setMaximized] = useState(false);
  const { notify } = useRunner();

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let unlisten: (() => void) | undefined;
    const refresh = async () => {
      const current = ++revision;
      try {
        const value = await appWindow.isMaximized();
        if (!disposed && current === revision) setMaximized(value);
      } catch (error) {
        if (!disposed && current === revision) notify("error", `读取窗口状态失败：${String(error)}`);
      }
    };
    // Subscribe before reading so a maximize/restore during setup cannot be missed.
    void appWindow.onResized(refresh).then((stop) => {
      if (disposed) stop();
      else {
        unlisten = stop;
        void refresh();
      }
    }).catch((error) => {
      if (!disposed) notify("error", `监听窗口状态失败：${String(error)}`);
    });
    return () => { disposed = true; unlisten?.(); };
  }, [appWindow, notify]);

  const perform = (label: string, action: () => Promise<void>) => {
    void action().catch((error) => notify("error", `${label}失败：${String(error)}`));
  };
  const maximizeLabel = maximized ? "还原窗口" : "最大化窗口";
  // Keep caption actions reachable above app dialogs, including their focus scopes.
  return createPortal(<div className="window-controls" role="group" aria-label="窗口控制"
    data-tauri-drag-region="false" data-react-aria-top-layer>
    <Button isIconOnly variant="ghost" className="window-control" aria-label="最小化窗口"
      onPress={() => perform("最小化窗口", () => appWindow.minimize())}>
      <svg aria-hidden="true" viewBox="0 0 12 12" fill="none" stroke="currentColor"><path d="M1 6.5h10" /></svg>
    </Button>
    <Button isIconOnly variant="ghost" className="window-control" aria-label={maximizeLabel}
      onPress={() => perform(maximizeLabel, () => appWindow.toggleMaximize())}>
      <svg aria-hidden="true" viewBox="0 0 12 12" fill="none" stroke="currentColor">
        {maximized ? <><path d="M3.5 3.5v-2h7v7h-2" /><rect x="1.5" y="3.5" width="7" height="7" /></>
          : <rect x="1.5" y="1.5" width="9" height="9" />}
      </svg>
    </Button>
    <Button isIconOnly variant="ghost" className="window-control window-close" aria-label="关闭窗口"
      onPress={() => perform("关闭窗口", () => appWindow.close())}>
      <svg aria-hidden="true" viewBox="0 0 12 12" fill="none" stroke="currentColor"><path d="m1.5 1.5 9 9m0-9-9 9" /></svg>
    </Button>
  </div>, document.body);
}

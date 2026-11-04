import { Button } from "./components/ui/button";
import { Progress } from "./components/ui/progress";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRunner } from "./runner";
import { Fold, Notice } from "./ui";
import { checkForUpdates, downloadUpdate, hasUpdate, installUpdate, RELEASES_URL, useUpdateState } from "./updater";

function openReleases() {
  void openUrl(RELEASES_URL).catch(() => undefined);
}

/** 设置页中的「版本更新」：检查、下载（带进度）、重启安装。 */
export function UpdatePanel({ currentVersion }: { currentVersion?: string }) {
  const s = useUpdateState();
  const { run, busy } = useRunner();

  const onCheck = () => run("检查更新", () => checkForUpdates({ manual: true }));
  const onDownload = () => run("下载更新", downloadUpdate);
  const onInstall = () => run(s.status === "installed" ? "重启应用" : "安装更新", installUpdate);

  let summary = currentVersion ? `当前版本 v${currentVersion}` : "当前版本未知";
  if (s.status === "installed") summary = `已安装版本 v${s.availableVersion}，待重启`;
  else if (hasUpdate(s)) summary = `${s.status === "downloaded" ? "待安装版本" : "可用版本"} v${s.availableVersion}`;

  return (
    <div className="update-panel" aria-live="polite">
      <div className="update-summary">
        {hasUpdate(s) && <span className="update-dot" aria-hidden="true" />}
        <span>{summary}</span>
        {s.status === "up-to-date" && <span>已是最新版本</span>}
        {s.status === "checking" && <span>正在检查…</span>}
        {hasUpdate(s) && currentVersion && <span className="text-muted-foreground">（当前 v{currentVersion}）</span>}
      </div>

      {s.error && <Notice tone="danger" title={s.error} />}
      {s.status === "downloaded" && <p>新版本已下载，重启后完成更新。</p>}
      {s.status === "downloading" && (
        <Progress aria-label="下载进度" value={s.progressPercent ?? null} max={100} />
      )}

      {s.releaseNotes && hasUpdate(s) && (
        <Fold className="update-notes" title={"更新说明"}>
          <pre>{s.releaseNotes}</pre>
        </Fold>
      )}

      <div className="flex flex-wrap gap-3">
        {(s.status === "idle" || s.status === "up-to-date" || s.status === "error" || s.status === "checking") && (
          <Button variant="secondary" onClick={onCheck} disabled={!!busy || s.status === "checking"}>检查更新</Button>
        )}
        {s.status === "available" && (
          <Button variant="default" onClick={onDownload} disabled={!!busy}>下载更新 v{s.availableVersion}</Button>
        )}
        {s.status === "downloaded" && (
          <Button variant="default" onClick={onInstall} disabled={!!busy}>重启并安装</Button>
        )}
        {s.status === "installed" && (
          <Button variant="default" onClick={onInstall} disabled={!!busy}>{s.error ? "重试重启" : "立即重启"}</Button>
        )}
        <Button variant="ghost" onClick={openReleases}>查看发布页</Button>
      </div>
    </div>
  );
}

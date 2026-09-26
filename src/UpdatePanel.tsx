import { Button, ProgressBar, Spinner } from "@heroui/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRunner } from "./runner";
import { Notice } from "./ui";
import { checkForUpdates, downloadUpdate, hasUpdate, installUpdate, RELEASES_URL, useUpdateState } from "./updater";

function openReleases() {
  void openUrl(RELEASES_URL).catch(() => undefined);
}

/** 设置页中的「版本更新」：检查、下载（带进度）、重启安装。 */
export function UpdatePanel({ currentVersion }: { currentVersion?: string }) {
  const s = useUpdateState();
  const { notify } = useRunner();

  const onCheck = async () => {
    try {
      const next = await checkForUpdates({ manual: true });
      if (next.status === "up-to-date") notify("ok", "已是最新版本");
    } catch { /* 错误显示在面板里 */ }
  };
  const onDownload = () => downloadUpdate().catch(() => undefined);
  const onInstall = () => installUpdate().catch(() => undefined);

  let summary = currentVersion ? `当前版本 v${currentVersion}` : "当前版本未知";
  if (s.status === "checking") summary = "正在检查更新…";
  else if (s.status === "up-to-date") summary = `已是最新版本${currentVersion ? ` v${currentVersion}` : ""}`;
  else if (s.status === "available") summary = `发现新版本 v${s.availableVersion}`;
  else if (s.status === "downloading") summary = `正在下载 v${s.availableVersion}…`;
  else if (s.status === "downloaded") summary = `v${s.availableVersion} 已下载，重启后完成更新`;

  return (
    <div className="update-panel" aria-live="polite">
      <div className="update-summary">
        {hasUpdate(s) && <span className="update-dot" aria-hidden="true" />}
        <span>{summary}</span>
        {hasUpdate(s) && currentVersion && <span className="text-muted">（当前 v{currentVersion}）</span>}
      </div>

      {s.status === "downloading" && (
        <ProgressBar aria-label="下载进度" value={s.progressPercent ?? 0} isIndeterminate={s.progressPercent === undefined} size="sm">
          <ProgressBar.Output />
          <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
        </ProgressBar>
      )}

      {s.error && <Notice tone="danger" title={s.status === "error" ? "检查更新失败" : undefined}>{s.error}</Notice>}

      {s.releaseNotes && hasUpdate(s) && (
        <details className="update-notes">
          <summary>更新说明</summary>
          <pre>{s.releaseNotes}</pre>
        </details>
      )}

      <div className="flex flex-wrap gap-3">
        {(s.status === "idle" || s.status === "up-to-date" || s.status === "error" || s.status === "checking") && (
          <Button variant="secondary" onPress={onCheck} isDisabled={s.status === "checking"}>
            {s.status === "checking" && <Spinner size="sm" />}
            {s.status === "checking" ? "检查中…" : "检查更新"}
          </Button>
        )}
        {s.status === "available" && (
          <Button variant="primary" onPress={onDownload}>下载更新 v{s.availableVersion}</Button>
        )}
        {s.status === "downloaded" && (
          <Button variant="primary" onPress={onInstall}>重启并安装</Button>
        )}
        <Button variant="tertiary" onPress={openReleases}>查看发布页</Button>
      </div>
    </div>
  );
}

/**
 * 侧栏底部的版本号：平时显示当前版本，点击手动检查；
 * 有可用更新时显示提示点和新版本号，点击打开设置页处理更新。
 */
export function VersionChip({ version, onOpenUpdates, isDisabled }: { version?: string; onOpenUpdates: () => void; isDisabled?: boolean }) {
  const s = useUpdateState();
  const { notify } = useRunner();
  const ready = hasUpdate(s);
  let label = version ? `v${version}` : "";
  if (ready) label = `v${s.availableVersion}`;
  else if (s.status === "checking" && s.manual) label = "检查中…";
  const title = ready ? `新版本 v${s.availableVersion} 可用，点击查看` : "检查更新";

  const onPress = async () => {
    if (ready) return onOpenUpdates();
    try {
      const next = await checkForUpdates({ manual: true });
      if (next.status === "available") onOpenUpdates();
      else if (next.status === "up-to-date") notify("ok", "已是最新版本");
    } catch (e) {
      notify("error", `检查更新失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (!label) return null;
  return (
    <button type="button" className={"version-chip" + (ready ? " has-update" : "")} title={title} aria-label={title}
      disabled={isDisabled && ready} onClick={onPress}>
      {ready && <span className="update-dot" aria-hidden="true" />}
      {label}
    </button>
  );
}

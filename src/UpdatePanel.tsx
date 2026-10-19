import { Button, ProgressBar } from "@heroui/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRunner } from "./runner";
import { Fold } from "./ui";
import { checkForUpdates, downloadUpdate, getUpdateState, hasUpdate, installUpdate, RELEASES_URL, useUpdateState } from "./updater";

function openReleases() {
  void openUrl(RELEASES_URL).catch(() => undefined);
}

/** 设置页中的「版本更新」：检查、下载（带进度）、重启安装。 */
export function UpdatePanel({ currentVersion }: { currentVersion?: string }) {
  const s = useUpdateState();
  const { notify, run, busy } = useRunner();

  const onCheck = async () => {
    const next = await run("检查更新", () => checkForUpdates({ manual: true }));
    if (next?.status === "up-to-date") notify("ok", "已是最新版本");
    else if (next?.status === "available") notify("ok", `发现新版本 v${next.availableVersion}`);
  };
  const onDownload = async () => {
    await run("下载更新", downloadUpdate);
    if (getUpdateState().status === "downloaded") notify("ok", "新版本已下载，重启后完成更新");
  };
  const onInstall = () => run("安装更新", installUpdate);

  let summary = currentVersion ? `当前版本 v${currentVersion}` : "当前版本未知";
  if (hasUpdate(s)) summary = `${s.status === "downloaded" ? "待安装版本" : "可用版本"} v${s.availableVersion}`;

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

      {s.releaseNotes && hasUpdate(s) && (
        <Fold className="update-notes" title={"更新说明"}>
          <pre>{s.releaseNotes}</pre>
        </Fold>
      )}

      <div className="flex flex-wrap gap-3">
        {(s.status === "idle" || s.status === "up-to-date" || s.status === "error" || s.status === "checking") && (
          <Button variant="secondary" onPress={onCheck} isDisabled={!!busy || s.status === "checking"}>检查更新</Button>
        )}
        {s.status === "available" && (
          <Button variant="primary" onPress={onDownload} isDisabled={!!busy}>下载更新 v{s.availableVersion}</Button>
        )}
        {s.status === "downloaded" && (
          <Button variant="primary" onPress={onInstall} isDisabled={!!busy}>重启并安装</Button>
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
  const { notify, run, busy } = useRunner();
  const s = useUpdateState();
  const ready = hasUpdate(s);
  let label = version ? `v${version}` : "";
  if (ready) label = `v${s.availableVersion}`;
  const title = ready ? `新版本 v${s.availableVersion} 可用，点击查看` : "检查更新";

  const onPress = async () => {
    if (ready) return onOpenUpdates();
    const next = await run("检查更新", () => checkForUpdates({ manual: true }));
    if (next?.status === "available") onOpenUpdates();
    else if (next?.status === "up-to-date") notify("ok", "已是最新版本");
  };

  if (!label) return null;
  return (
    <Button size="sm" variant="ghost" className={"version-chip" + (ready ? " has-update" : "")} aria-label={title}
      isDisabled={!!busy || s.status === "checking" || (isDisabled && ready)} onPress={onPress}>
      {ready && <span className="update-dot" aria-hidden="true" />}
      {label}
    </Button>
  );
}

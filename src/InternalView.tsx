import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, baseCandidates, defaultBaseFor, releasesOf, type ExportOutcome, type InternalState, type OpOutcome, type PackageInfo, type Profile, type ReturnImportResult } from "./api";
import { Feedback, useRunner } from "./runner";
import { InProgressBanners, usePackages, useRefreshOnFocus, useRepoStatus, useRequestGeneration } from "./repoBits";
import { ActionButton, BaseSelect, Check, Code, Fold, OutcomeView, RefreshButton, TextInput } from "./ui";
import { Icon } from "./icons";
import { PackageInbox } from "./PackageInbox";
import { DateTime } from "./DateTime";
import { BranchManager } from "./BranchManager";

export function InternalView({ profile, refreshVersion = 0 }: {
  profile: Profile; refreshVersion?: number;
}) {
  const { run, notify, confirm, busy } = useRunner();
  const base = profile.baseBranch;
  const releases = releasesOf(profile);
  const candidates = baseCandidates(profile);
  const mirrorDir = profile.mirrorDir ?? "";
  const workDir = profile.workDir ?? "";
  const mirror = useRepoStatus(mirrorDir, base, releases);
  const work = useRepoStatus(workDir, base, releases);
  const refreshKey = JSON.stringify([profile.id, profile.repoName, profile.remoteUrl, mirrorDir, workDir, base, releases, profile.transferDir]);
  const beginRefresh = useRequestGeneration(refreshKey);
  const beginAction = useRequestGeneration(refreshKey);
  const [snapshot, setSnapshot] = useState<{
    key: string; loading: boolean; state: InternalState | null; stateError: string | null;
  } | null>(null);
  const { current: currentPackages, loading: packagesLoading, reload: reloadPackages } = usePackages(refreshKey, profile.transferDir);
  const current = snapshot?.key === refreshKey ? snapshot : null;
  const refreshing = !current || current.loading;
  const state = current?.state ?? null;
  const stateError = current?.stateError ?? null;
  const packageError = currentPackages?.packageError ?? null;
  const packages = useMemo(() => (currentPackages?.packages ?? []).filter(
    (p) => !p.manifest || p.manifest.kind === "back" || p.manifest.kind === "patch",
  ), [currentPackages?.packages]);
  const mirrorReady = !!mirror.status?.isRepo;
  const workReady = !!work.status?.isRepo && !work.status.isBare;

  const reloadLocal = useCallback(async () => {
    const isCurrent = beginRefresh();
    if (!isCurrent()) return;
    setSnapshot((previous) => previous?.key === refreshKey ? { ...previous, loading: true } : null);
    const [stateResult] = await Promise.all([
      mirrorDir ? api.internalState(mirrorDir).then(
        (state) => ({ state, stateError: null }),
        (error) => ({ state: null, stateError: String(error) }),
      ) : { state: null, stateError: null },
      mirror.reload(), work.reload(),
    ]);
    if (isCurrent()) setSnapshot({ key: refreshKey, loading: false, ...stateResult });
  }, [beginRefresh, refreshKey, mirrorDir, mirror.reload, work.reload]);
  const reloadAll = useCallback(async () => {
    // 目录扫描在后台完成，操作结果只等待本地仓库刷新。
    void reloadPackages();
    await reloadLocal();
  }, [reloadPackages, reloadLocal]);
  useEffect(() => { void reloadLocal(); }, [reloadLocal, refreshVersion]);
  useEffect(() => { void reloadPackages(); }, [reloadPackages, refreshVersion]);
  useRefreshOnFocus(reloadAll);

  const [forceFull, setForceFull] = useState(false);
  const [fetchFirst, setFetchFirst] = useState(true);
  const [exportResult, setExportResult] = useState<ExportOutcome | null>(null);
  const [returnResult, setReturnResult] = useState<ReturnImportResult | null>(null);
  const [outcome, setOutcome] = useState<OpOutcome | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [patchOptions, setPatchOptions] = useState<Record<string, { branch: string; base: string }>>({});
  useEffect(() => {
    setExportResult(null); setReturnResult(null); setOutcome(null); setSelected([]); setPatchOptions({});
  }, [refreshKey]);
  useEffect(() => {
    if (work.loading || !selected.length) return;
    setSelected((previous) => {
      const remaining = previous.filter((name) => !candidates.includes(name) && work.status?.branches.some((b) => b.name === name));
      return remaining.length === previous.length ? previous : remaining;
    });
  }, [work.status, work.loading, selected, base, JSON.stringify(releases)]);

  const unfinished = !!work.status?.inProgress || !!work.status?.inProgressTrees.length;

  async function initialize() {
    const isCurrent = beginAction();
    await run("建立镜像", () => api.initMirror(profile.remoteUrl?.trim() ?? "", mirrorDir));
    if (isCurrent()) await reloadAll();
  }
  async function exportUpdate() {
    const isCurrent = beginAction();
    const result = await run("导出更新", () => api.exportOut({ mirrorDir, transferDir: profile.transferDir,
      repoName: profile.repoName, baseBranch: base, fetchUpstream: fetchFirst, forceFull }));
    if (!isCurrent()) return;
    if (result) {
      setExportResult(result);
      setForceFull(false);
      if (result.status === "exported") {
        notify(result.warnings.length ? "warn" : "ok", [`已导出更新 #${result.seq}`, ...result.warnings].join("\n"));
      } else notify("ok", result.message);
    }
    await reloadAll();
  }
  async function receive(bundle: string, legacy = false) {
    const isCurrent = beginAction();
    if (legacy && !await confirm({ title: "导入没有清单的回传包", confirmLabel: "继续导入",
      body: <p>此文件没有项目清单。请确认它属于当前工作仓库。回传分支会优先按外网原名导入本地；目标分支若已被检出，请先切换到其他分支。</p> })) return;
    if (!isCurrent()) return;
    const result = await run("导入回传", () => api.importReturn(workDir, bundle, base, releases));
    if (!isCurrent()) return;
    await reloadAll();
    if (!isCurrent()) return;
    if (result) {
      setReturnResult(result);
      setOutcome(null);
      if (result.branches[0]) setSelected([result.branches[0]]);
    }
  }
  async function browse() {
    const isCurrent = beginAction();
    try {
      const path = await open({ multiple: false, filters: [{ name: "Git bundle", extensions: ["bundle"] }] });
      if (typeof path === "string" && isCurrent()) await receive(path, true);
    } catch (error) {
      if (isCurrent()) notify("error", `打开文件选择器失败：${String(error)}`);
    }
  }
  function patchValues(pkg: PackageInfo) {
    const source = pkg.manifest?.refs[0];
    const branch = source?.name.replace(/^refs\/heads\//, "") ?? "";
    return patchOptions[pkg.payloadPath] ?? { branch, base: source?.base ?? defaultBaseFor(branch, profile) };
  }
  async function receivePatch(pkg: PackageInfo) {
    const options = patchValues(pkg);
    if (!options.branch.trim()) return notify("warn", "请在补丁选项中填写分支");
    const isCurrent = beginAction();
    const result = await run("导入补丁", () => api.importPatches({ workDir, patchDir: pkg.payloadPath,
      branch: options.branch.trim(), baseBranch: options.base, fetchUpstream: true }));
    if (!isCurrent()) return;
    await reloadAll();
    if (result && isCurrent()) { setOutcome(result); setSelected([options.branch.trim()]); }
  }
  function packageIssue(pkg: PackageInfo) {
    return !pkg.payloadExists ? "包文件缺失，请重新复制。"
      : pkg.manifest && state?.repoId && pkg.manifest.repoId !== state.repoId ? "包属于其他项目。" : null;
  }
  function packageRow(pkg: PackageInfo) {
    const manifest = pkg.manifest;
    const patch = manifest?.kind === "patch";
    const options = patchValues(pkg);
    const reason = packageIssue(pkg);
    return <div className="return-package-details" key={pkg.payloadPath}>
      {reason && <p className="return-package-error">{reason}</p>}
      <div className="return-package-actions">
        {patch && <Fold className="return-package-options" title="补丁选项">
          <div className="space-y-3">
            <TextInput label="应用到的新分支" value={options.branch} onChange={(branch) => setPatchOptions((p) => ({ ...p, [pkg.payloadPath]: { ...options, branch } }))} />
            <BaseSelect label="基准分支" value={options.base} options={candidates} mainline={base} onChange={(base) => setPatchOptions((p) => ({ ...p, [pkg.payloadPath]: { ...options, base } }))} />
            <p className="text-xs text-muted-foreground">补丁会在当前工作仓库切换到所填分支并应用，请保持工作区干净。</p>
          </div>
        </Fold>}
        <ActionButton variant="default" disabled={!workReady || work.loading || refreshing || packagesLoading || !!stateError || !!reason || unfinished}
          onClick={() => patch ? receivePatch(pkg) : receive(pkg.payloadPath, !manifest)}>导入回传</ActionButton>
      </div>
    </div>;
  }

  return <div className="sync-workspace">
    {!current && <Feedback kind="progress" text="正在读取仓库状态…" />}
    <div className="sync-location"><Icon name="folder" /><span className="sync-location-label">传输目录</span><span className="min-w-0 flex-1 truncate" title={profile.transferDir}>{profile.transferDir}</span><RefreshButton loading={refreshing || mirror.loading || work.loading || packagesLoading} onClick={reloadAll} /></div>
    {stateError && <Feedback kind="error" text={`无法读取同步记录，请检查后重试\n${stateError}`} />}
    <div className="sync-panel">
      <header className="internal-page-heading"><div><h1>同步与回传</h1></div></header>
      <section className="sync-workflow-section" aria-label="导出更新" aria-busy={refreshing || mirror.loading}>
      {mirror.error && <Feedback kind="error" text={`读取镜像失败\n${mirror.error}`} />}
      <header className="internal-page-heading">
        <div><h2>导出更新</h2>
          <p className="text-sm text-muted-foreground">{mirrorReady ? `${base}${releases.length ? `、${releases.join("、")}` : ""} 等 ${mirror.status?.branches.length ?? 0} 个分支` : "首次使用时从 GitLab 准备代码"}</p>
        </div>
        <div className="sync-button-group">
        {mirrorReady ? <ActionButton variant="default" onClick={exportUpdate} disabled={refreshing || !!stateError || !!mirror.error || mirror.loading}>导出更新</ActionButton>
          : <ActionButton variant="default" onClick={initialize} disabled={refreshing || !profile.remoteUrl?.trim() || !mirrorDir || mirror.loading || !!mirror.error || !!stateError}>建立镜像</ActionButton>}
        </div>
      </header>
      <div className="workflow-surface">
      <section className="workspace-section" aria-label="导出设置">
        <Check checked={fetchFirst} onChange={setFetchFirst}>先拉取 GitLab 最新代码</Check>
        {state && <div className="export-history">{state.outSeq ? <>最近已导出 #{state.outSeq} · <DateTime value={state.lastExportAt} label="最近导出时间" /></> : "尚未导出"}</div>}
        <Fold className="sync-details" title="高级选项"><div className="space-y-3">
          <Check checked={forceFull} onChange={setForceFull}>强制全量</Check>
          <p className="text-xs text-muted-foreground break-all">镜像：{mirrorDir || "请在项目设置中填写"}</p>
        </div></Fold>
      </section>
      {exportResult?.status === "exported" && <Fold className="sync-details" title={`查看更新 #${exportResult.seq} 文件`}>
        <Code>{exportResult.payload}</Code>
      </Fold>}
      </div>
      </section>
      <section className="sync-workflow-section internal-return" aria-label="导入回传">
      {packagesLoading && <Feedback kind="progress" text="正在读取传输目录…" />}
      {packageError && <Feedback kind="error" text={`无法读取传输目录，请检查连接后刷新\n${packageError}`} />}
      <header className="internal-page-heading">
        <div><h2>导入回传</h2><p>回传包导入工作仓库后，可在下方检查分支、整理和推送。</p></div>
        <ActionButton size="sm" variant="ghost" onClick={browse} disabled={!workReady || work.loading || refreshing || !!stateError || unfinished}><Icon name="folder" />选择其他文件…</ActionButton>
      </header>
      <InProgressBanners status={work.status} onDone={(result) => { if (result) setOutcome(result); void reloadAll(); }} />
      {!packageError && currentPackages && <PackageInbox key={`inbox:${refreshKey}`}
        packages={packages} disabled={!!busy || packagesLoading} renderDetails={packageRow} />}
      {returnResult && returnResult.branches.length > 0 && <div className="return-import-result" role="status">
        <div><h2>已导入本地分支</h2><p>回传已导入，可在下方检查分支、整理和推送。</p><p>{returnResult.branches.map((branch) => <Code key={branch}>{branch}</Code>)}</p></div>
      </div>}
      {returnResult?.warnings.map((warning) => <Feedback key={warning} kind="warn" text={warning} />)}
      {outcome && !outcome.ok && <OutcomeView outcome={outcome} />}
      <BranchManager key={refreshKey} profile={profile} repoPath={workDir} status={work.status} loading={work.loading} error={work.error}
        onRefresh={reloadAll} selected={selected} onSelect={setSelected} pushBlocked={refreshing || !!stateError} />
      </section>
    </div>
  </div>;
}

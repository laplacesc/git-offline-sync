import { useCallback, useEffect, useId, useRef, useState } from "react";
import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group";
import { Label } from "./components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { BranchManager } from "./BranchManager";
import { PackageInbox } from "./PackageInbox";
import {
  api, baseCandidates, ExportOutcome, MirrorState,
  OpOutcome, PackageInfo, Profile, releasesOf, shortSha,
} from "./api";
import { Feedback, useRunner } from "./runner";
import { Icon } from "./icons";
import {
  InProgressBanners,
  useRefreshOnFocus, useRepoStatus, useRequestGeneration,
} from "./repoBits";
import { ActionButton, Code, Fold, OutcomeView, RefreshButton, WorkspaceNavigation } from "./ui";

export function ExternalView({ profile, navigationTarget, onNavigate, refreshVersion = 0 }: {
  profile: Profile; navigationTarget?: HTMLElement | null; onNavigate?: () => void; refreshVersion?: number;
}) {
  const { run, notify, confirm, busy } = useRunner();
  const base = profile.baseBranch;
  const releases = releasesOf(profile);
  const candidates = baseCandidates(profile);
  const mirrorDir = profile.mirrorDir ?? "";
  const devRepos = profile.devRepos ?? [];
  const devReposKey = JSON.stringify(devRepos);
  const [devPicked, setDevPicked] = useState("");
  const devDir = devRepos.includes(devPicked) ? devPicked : devRepos[0] ?? "";
  const mirror = useRepoStatus(mirrorDir, base, releases, false);
  const repo = useRepoStatus(devDir, base, releases, false);
  const refreshKey = JSON.stringify([
    profile.id, profile.repoName, mirrorDir, base, releases, profile.transferDir,
    devRepos, profile.userName, profile.userEmail,
  ]);
  const actionKey = JSON.stringify([refreshKey, devDir]);
  const beginRefresh = useRequestGeneration(refreshKey);
  const beginAction = useRequestGeneration(actionKey);
  const revision = useRef(0);
  const [snapshot, setSnapshot] = useState<{
    key: string; loading: boolean; state: MirrorState | null; stateError: string | null;
    packages: PackageInfo[]; packageError: string | null;
    devs: Awaited<ReturnType<typeof api.devSyncStatus>>; devError: string | null;
  } | null>(null);
  const current = snapshot?.key === refreshKey ? snapshot : null;
  const state = current?.state;
  const lastIn = state?.lastInSeq ?? 0;
  const ready = !!current && !current.loading && !current.stateError && !!state && !mirror.error;
  const mirrorReady = !!mirror.status?.isRepo && !!mirror.status.isBare;
  // Full replacement can delete tags too; branches alone cannot describe its impact.
  const mirrorRefs = mirror.status?.refs;
  const devReady = !!repo.status?.isRepo && !repo.status.isBare && !repo.loading;
  const needsFull = !state?.repoId || !mirrorReady;

  const reloadShared = useCallback(async () => {
    const isCurrent = beginRefresh();
    if (!isCurrent()) return;
    revision.current += 1;
    setSnapshot((previous) => previous?.key === refreshKey ? { ...previous, loading: true } : null);
    const [stateResult, packageResult, devResult] = await Promise.all([
      mirrorDir ? api.mirrorState(mirrorDir).then(
        (state) => ({ state, stateError: null }),
        (error) => ({ state: null, stateError: String(error) }),
      ) : { state: null, stateError: null },
      api.listPackages(profile.transferDir).then(
        (packages) => ({ packages, packageError: null }),
        (error) => ({ packages: [] as PackageInfo[], packageError: String(error) }),
      ),
      mirrorDir ? api.devSyncStatus(mirrorDir, JSON.parse(devReposKey) as string[]).then(
        (devs) => ({ devs, devError: null }),
        (error) => ({ devs: [], devError: String(error) }),
      ) : { devs: [], devError: null },
      mirror.reload(),
    ]);
    if (isCurrent()) setSnapshot({ key: refreshKey, loading: false, ...stateResult, ...packageResult, ...devResult });
  }, [beginRefresh, refreshKey, mirrorDir, profile.transferDir, devReposKey, mirror.reload]);
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadShared(), repo.reload()]);
  }, [reloadShared, repo.reload]);
  useEffect(() => { void reloadShared(); }, [reloadShared, refreshVersion]);
  useEffect(() => { void repo.reload(); }, [repo.reload, refreshVersion]);
  useRefreshOnFocus(reloadAll);

  const updatePackages = (current?.packages ?? []).filter((p) => {
    const m = p.manifest;
    return m && (m.kind === "full" || m.kind === "incr")
      && (state?.repoId ? m.repoId === state.repoId : m.repoName === profile.repoName && m.baseBranch === base);
  });
  const packages = updatePackages.filter((p) => p.manifest!.seq > lastIn)
    .sort((a, b) => a.manifest!.seq - b.manifest!.seq);
  const usable = (p: PackageInfo) => p.payloadExists && !!p.manifest && p.manifest.seq > lastIn
    && (needsFull ? p.manifest.kind === "full" : p.manifest.seq === lastIn + 1 || p.manifest.kind === "full");
  const chosen = packages.find((p) => usable(p) && (needsFull || p.manifest!.seq === lastIn + 1))
    ?? packages.find((p) => usable(p) && p.manifest!.kind === "full");
  const missing = !needsFull && !chosen && packages.some((p) => p.manifest!.seq > lastIn + 1);
  const fullGap = chosen?.manifest?.kind === "full" && !needsFull && chosen.manifest.seq > lastIn + 1;
  const missingImpact = fullGap && !mirrorRefs;
  const importReady = ready && !!mirrorDir.trim() && !mirror.loading && (!mirror.status?.isRepo || mirrorReady);
  const canImport = importReady && !missingImpact && !!chosen;
  const canSyncDevs = ready && mirrorReady && !needsFull && !mirror.loading && devRepos.length > 0;

  const importUpdate = async (bundle = chosen) => {
    if (!importReady || !bundle || !usable(bundle)) return;
    const isCurrent = beginAction();
    const startedAt = revision.current;
    const m = bundle?.manifest;
    if (m?.kind === "full" && !needsFull && m.seq > lastIn + 1) {
      if (!mirrorRefs) return;
      const targetRefs = new Map(m.refs.map((ref) => [ref.name, ref.sha]));
      const oldRefs = new Map(mirrorRefs.map((ref) => [ref.name, ref.sha]));
      const affected = [...new Set([...oldRefs.keys(), ...targetRefs.keys()])]
        .filter((name) => oldRefs.get(name) !== targetRefs.get(name));
      const approved = await confirm({
        title: `使用全量更新 #${m.seq}？`, tone: "warning", confirmLabel: `导入到 #${m.seq}`,
        body: <div className="space-y-3">
          <p>将 {mirrorDir} 从 #{lastIn} 导入到 #{m.seq}，跳过 #{lastIn + 1}–#{m.seq - 1}。</p>
          <p>以下引用将按全量包更新，可能回退；包外的分支和标签将移除。</p>
          <ul>{affected.map((name) => <li key={name}><Code>{name}</Code>：{shortSha(oldRefs.get(name))} → {targetRefs.has(name) ? shortSha(targetRefs.get(name)) : "删除"}</li>)}</ul>
          {!affected.length && <p>分支和标签没有变化，仅推进同步记录。</p>}
        </div>,
      });
      if (!approved || !isCurrent() || startedAt !== revision.current) return;
    }
    await run("导入更新", () => api.syncUpdates({
      bundle: bundle.payloadPath, mirrorDir, devDirs: [], name: "", email: "",
    }));
    if (!isCurrent()) return;
    await reloadAll();
  };

  const syncDevelopmentRepos = async (dirs = devRepos) => {
    if (!canSyncDevs || !dirs.length) return;
    const isCurrent = beginAction();
    await run("同步开发仓库", () => api.syncUpdates({
      bundle: null, mirrorDir, devDirs: dirs,
      name: profile.userName ?? "", email: profile.userEmail ?? "",
    }));
    if (!isCurrent()) return;
    await reloadAll();
  };

  const [selected, setSelected] = useState<string[]>([]);
  const formatId = useId();
  const [mode, setMode] = useState<"bundle" | "patch">("bundle");
  const [exportRes, setExportRes] = useState<ExportOutcome | null>(null);
  const [opRes, setOpRes] = useState<OpOutcome | null>(null);
  const branches = (repo.status?.branches ?? []).filter((b) => !candidates.includes(b.name));
  const selectedBranches = selected.filter((name) => branches.some((b) => b.name === name));

  useEffect(() => {
    setSelected([]);
    setExportRes(null);
    setOpRes(null);
  }, [actionKey]);
  useEffect(() => {
    if (repo.loading) return;
    setSelected((previous) => previous.filter((name) => repo.status?.branches.some((b) => b.name === name && !candidates.includes(name))));
  }, [repo.status, repo.loading, base, JSON.stringify(releases)]);

  const doExport = async () => {
    if (!ready || !devReady || !mirrorReady || !selectedBranches.length || mode === "patch" && selectedBranches.length !== 1) return;
    const isCurrent = beginAction();
    const common = {
      repo: devDir, mirrorDir, transferDir: profile.transferDir,
      repoName: profile.repoName, baseBranch: base, releaseBranches: releases,
    };
    setExportRes(null);
    const outcome = mode === "bundle"
      ? await run("导出回传", () => api.exportBack({ ...common, branches: selectedBranches }))
      : await run("导出补丁", () => api.exportPatches({ ...common, branch: selectedBranches[0] }));
    if (!isCurrent()) return;
    if (outcome) {
      setExportRes(outcome);
      if (outcome.status === "exported") {
        notify(outcome.warnings.length ? "warn" : "ok", [`已生成回传 #${outcome.seq}`, ...outcome.warnings].join("\n"));
      } else notify("ok", outcome.message);
    }
    await reloadAll();
  };

  let summary = current?.packageError ? "暂时无法检查新包。" : "没有新的更新。";
  if (needsFull) summary = "请将本项目的全量包放入传输目录后导入。";
  if (chosen) summary = `本次更新 #${chosen.manifest!.seq} · ${chosen.manifest!.kind === "full" ? "全量" : "增量"}`;
  if (!current || current.loading) summary = "正在检查同步状态…";
  else if (current.stateError || mirror.error) summary = "暂时无法检查同步状态，请刷新重试。";
  return <>
    {!current && <Feedback kind="progress" text="正在检查更新…" />}
    <Tabs className="sync-workspace" orientation={navigationTarget ? "vertical" : "horizontal"}
      value="sync" onValueChange={() => onNavigate?.()}>
    <WorkspaceNavigation target={navigationTarget}><TabsList className="sync-tabs" aria-label="外网同步">
      <TabsTrigger value="sync" onClick={() => onNavigate?.()}><Icon name="copy" />同步与回传</TabsTrigger>
    </TabsList></WorkspaceNavigation>
    <div className="sync-location">
      <Icon name="folder" /><span className="sync-location-label">传输目录</span>
      <span className="min-w-0 flex-1 truncate" title={profile.transferDir}>
        {profile.transferDir}</span>
      <RefreshButton onClick={reloadAll} />
    </div>
    {!mirrorDir.trim() && <Feedback kind="warn" text="请在项目设置中填写外网镜像目录。" />}
    {!devRepos.length && <Feedback kind="warn" text="请在项目设置中添加开发仓库目录。" />}
    {current?.stateError && <Feedback kind="error" text={`无法读取同步记录，请检查后刷新。\n${current.stateError}`} />}
    {mirror.error && <Feedback kind="error" text={`无法读取外网镜像。\n${mirror.error}`} />}
    {mirror.status?.isRepo && !mirror.status.isBare && <Feedback kind="error" text="镜像目录必须是裸仓库，请检查项目设置。" />}
    <TabsContent className="sync-panel" value="sync" forceMount hidden={false} aria-busy={!current || current.loading || mirror.loading || repo.loading}>
      <header className="internal-page-heading"><div><h1>同步与回传</h1></div></header>
      <section className="sync-workflow-section" aria-label="同步开发仓库">
        <header className="internal-page-heading">
          <div><h2>同步开发仓库</h2><p>从镜像获取最新引用，保留本地工作分支和未提交修改。</p></div>
          <ActionButton variant="default" onClick={() => syncDevelopmentRepos()} disabled={!canSyncDevs}>同步开发仓库</ActionButton>
        </header>
        <div className="workflow-surface">
          {!mirrorReady && <p>请先在下方导入更新，准备镜像仓库。</p>}
          {current?.devError && <Feedback kind="error" text={current.devError} />}
          {devRepos.map((path) => {
            const status = current?.devs.find((d) => d.path === path);
            const labels = { upToDate: "已同步", needsFetch: "待同步", notCloned: "尚未克隆", unknown: "状态未知" };
            return <div key={path} className="sync-branch-row">
              <div className="sync-branch-copy"><Code>{path}</Code>
                <small>{status ? labels[status.status] : "状态未知"}{path === devDir ? " · 当前仓库" : ""}</small>
                {status?.error && <Feedback kind="error" text={status.error} />}
              </div>
              <div className="sync-button-group">
                {path !== devDir && <ActionButton size="sm" variant="secondary" onClick={() => setDevPicked(path)}>切换</ActionButton>}
                <ActionButton size="sm" variant="outline" onClick={() => syncDevelopmentRepos([path])}
                  disabled={!canSyncDevs}>{status?.status === "notCloned" ? "从镜像克隆" : "同步仓库"}</ActionButton>
              </div>
            </div>;
          })}
        </div>
      </section>
      <section className="sync-workflow-section" aria-label="导入更新">
      {current?.packageError && <Feedback kind="error" text={`无法读取传输目录，请检查连接后刷新。\n${current.packageError}`} />}
      {current && !current.loading && !current.stateError && <>
        {missing && <Feedback kind="warn" text={`缺少更新 #${lastIn + 1}，请在传输目录补齐更新包或放入较新的全量包。`} />}
        {missingImpact && <Feedback kind="warn" text="无法读取完整引用影响，请刷新后再使用全量包跳号。" />}
      </>}
      <header className="internal-page-heading">
        <div><h2>导入更新</h2><p><span>{summary}</span> · 仅导入镜像仓库</p></div>
        <ActionButton size="sm" variant="ghost" onClick={() => importUpdate()} disabled={!canImport}>导入下一包</ActionButton>
      </header>
      {current && !current.packageError && !current.stateError && <PackageInbox key={`updates:${refreshKey}`}
        packages={updatePackages} packageLabel="更新包" disabled={!!busy || current.loading}
        renderDetails={(pkg) => {
          const manifest = pkg.manifest!;
          const gap = manifest.kind === "full" && !needsFull && manifest.seq > lastIn + 1;
          let status = "待导入";
          if (!pkg.payloadExists) status = "缺少包文件";
          else if (manifest.seq <= lastIn) status = "已导入";
          else if (needsFull && manifest.kind !== "full") status = "需要先导入全量包";
          else if (manifest.kind === "incr" && manifest.seq !== lastIn + 1) status = `需先导入 #${lastIn + 1}`;
          else if (pkg === chosen) status = "本次推荐";
          return <div className="return-package-actions">
            <span className="text-xs text-muted-foreground">{status}</span>
            <ActionButton size="sm" variant="default" aria-label={`导入更新 #${manifest.seq}`}
              disabled={!importReady || !usable(pkg) || gap && !mirrorRefs} onClick={() => importUpdate(pkg)}>导入更新</ActionButton>
          </div>;
        }} />}
      </section>
      <section className="sync-workflow-section" aria-label="回传提交">
      <header className="internal-page-heading return-heading">
        <div><h2>回传提交</h2></div>
        <div className="return-controls">
          <RadioGroup className="sync-format-options" orientation="horizontal" aria-label="回传格式" value={mode} disabled={!!busy}
            onValueChange={(value) => {
              setMode(value as "bundle" | "patch");
              if (value === "patch") setSelected((previous) => previous.slice(0, 1));
            }}>
            {(["bundle", "patch"] as const).map((value) => <div key={value} className="flex items-center gap-2">
              <RadioGroupItem id={`${formatId}-${value}`} value={value} />
              <Label htmlFor={`${formatId}-${value}`}>{value === "bundle" ? "Bundle" : "Patch（单分支）"}</Label>
            </div>)}
          </RadioGroup>
          <ActionButton variant="default" onClick={doExport}
            disabled={!ready || !devReady || !mirrorReady || !selectedBranches.length || mode === "patch" && selectedBranches.length !== 1}>
            导出回传
          </ActionButton>
        </div>
      </header>
      <InProgressBanners status={repo.status} onDone={(outcome) => {
        if (outcome) setOpRes(outcome);
        void reloadAll();
      }} />
      <BranchManager key={actionKey} profile={profile} repoPath={devDir} status={repo.status} loading={repo.loading} error={repo.error}
        onRefresh={reloadAll} selected={selectedBranches} onSelect={setSelected} multi={mode === "bundle"} />

      {opRes && !opRes.ok && <OutcomeView outcome={opRes} />}
      {exportRes?.status === "exported" && <Fold className="sync-details" title={`查看回传 #${exportRes.seq} 文件`}>
        <Code>{exportRes.payload}</Code>
      </Fold>}
      </section>
    </TabsContent>
    </Tabs>
  </>;
}

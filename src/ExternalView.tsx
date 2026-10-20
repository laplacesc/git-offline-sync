import { useCallback, useEffect, useRef, useState } from "react";
import { Radio, RadioGroup, Tabs } from "@heroui/react";
import { BranchManager } from "./BranchManager";
import {
  api, baseCandidates, ExportOutcome, MirrorState,
  OpOutcome, PackageInfo, Profile, RefEntry, releasesOf, shortSha,
} from "./api";
import { Feedback, FeedbackScope, useRunner } from "./runner";
import { Icon } from "./icons";
import {
  BranchTable, DirtyTreesNotice, InProgressBanners,
  useRefreshOnFocus, useRepoStatus, useRequestGeneration,
} from "./repoBits";
import { ActionButton, Code, Fold, OutcomeView, RefreshButton, WorkspaceNavigation } from "./ui";

export function ExternalView({ profile, navigationTarget, branchTarget, onNavigate }: {
  profile: Profile; navigationTarget?: HTMLElement | null; branchTarget?: HTMLElement | null; onNavigate?: () => void;
}) {
  const [branchOpen, setBranchOpen] = useState(false);
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
    profile.id, profile.repoName, mirrorDir, devDir, base, releases, profile.transferDir,
    devRepos, profile.userName, profile.userEmail,
  ]);
  const beginRefresh = useRequestGeneration(refreshKey);
  const beginAction = useRequestGeneration(refreshKey);
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
  const mirrorRefs = (mirror.status as (typeof mirror.status & { refs?: RefEntry[] }))?.refs;
  const devReady = !!repo.status?.isRepo && !repo.status.isBare && !repo.loading;
  const needsFull = !state?.repoId || !mirrorReady;

  const reloadAll = useCallback(async () => {
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
      mirror.reload(), repo.reload(),
    ]);
    if (isCurrent()) setSnapshot({ key: refreshKey, loading: false, ...stateResult, ...packageResult, ...devResult });
  }, [beginRefresh, refreshKey, mirrorDir, profile.transferDir, devReposKey, mirror.reload, repo.reload]);
  useEffect(() => { void reloadAll(); }, [reloadAll]);
  useRefreshOnFocus(reloadAll);

  const packages = (current?.packages ?? []).filter((p) => {
    const m = p.manifest;
    return m && (m.kind === "full" || m.kind === "incr") && m.seq > lastIn
      && (state?.repoId ? m.repoId === state.repoId : m.repoName === profile.repoName && m.baseBranch === base);
  }).sort((a, b) => a.manifest!.seq - b.manifest!.seq);
  const usable = (p: PackageInfo) => p.payloadExists && (needsFull ? p.manifest?.kind === "full"
    : p.manifest?.seq === lastIn + 1 || p.manifest?.kind === "full");
  const chosen = packages.find((p) => usable(p) && (needsFull || p.manifest!.seq === lastIn + 1))
    ?? packages.find((p) => usable(p) && p.manifest!.kind === "full");
  const missing = !needsFull && !chosen && packages.some((p) => p.manifest!.seq > lastIn + 1);
  const pendingDevs = devRepos.some((path) => current?.devs.find((d) => d.path === path)?.status !== "upToDate");
  const fullGap = chosen?.manifest?.kind === "full" && !needsFull && chosen.manifest.seq > lastIn + 1;
  const missingImpact = fullGap && !mirrorRefs;
  const canSync = ready && !!mirrorDir.trim() && devRepos.length > 0 && !mirror.loading && !missingImpact
    && (!mirror.status?.isRepo || mirrorReady) && (!!chosen || mirrorReady && pendingDevs && !needsFull);

  const sync = async (bundle: PackageInfo | null = chosen ?? null, dirs = devRepos) => {
    if (!ready || !mirrorDir.trim() || !dirs.length || (bundle && !usable(bundle)) || (!bundle && !mirrorReady)) return;
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
        title: `使用全量更新 #${m.seq}？`, tone: "warning", confirmLabel: `同步到 #${m.seq}`,
        body: <div className="space-y-3">
          <p>将 {mirrorDir} 从 #{lastIn} 同步到 #{m.seq}，跳过 #{lastIn + 1}–#{m.seq - 1}。</p>
          <p>以下引用将按全量包更新，可能回退；包外的分支和标签将移除。</p>
          <ul>{affected.map((name) => <li key={name}><Code>{name}</Code>：{shortSha(oldRefs.get(name))} → {targetRefs.has(name) ? shortSha(targetRefs.get(name)) : "删除"}</li>)}</ul>
          {!affected.length && <p>分支和标签没有变化，仅推进同步记录。</p>}
        </div>,
      });
      if (!approved || !isCurrent() || startedAt !== revision.current) return;
    }
    const outcome = await run("同步更新", () => api.syncUpdates({
      bundle: bundle?.payloadPath ?? null, mirrorDir, devDirs: dirs,
      name: profile.userName ?? "", email: profile.userEmail ?? "",
    }));
    if (!isCurrent()) return;
    if (outcome) {
      notify("ok", outcome.imported ? `已同步更新 #${outcome.imported.seq ?? ""}` : "已完成开发仓库同步");
    }
    await reloadAll();
  };

  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<"bundle" | "patch">("bundle");
  const [exportRes, setExportRes] = useState<ExportOutcome | null>(null);
  const [opRes, setOpRes] = useState<OpOutcome | null>(null);
  const branches = (repo.status?.branches ?? []).filter((b) => !candidates.includes(b.name));
  const selectedBranches = selected.filter((name) => branches.some((b) => b.name === name));

  useEffect(() => {
    setSelected([]);
    setExportRes(null);
    setOpRes(null);
  }, [refreshKey]);
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
  if (pendingDevs) summary = "开发仓库尚未完成同步。";
  if (needsFull) summary = "请将本项目的全量包放入传输目录后同步。";
  if (chosen) summary = `本次更新 #${chosen.manifest!.seq} · ${chosen.manifest!.kind === "full" ? "全量" : "增量"}`;
  return <>
    {!current && <Feedback kind="progress" text="正在检查更新…" />}
    <Tabs className="sync-workspace" variant="secondary" orientation={navigationTarget ? "vertical" : "horizontal"}
      selectedKey="sync" onSelectionChange={() => onNavigate?.()}>
    <WorkspaceNavigation target={navigationTarget}><Tabs.ListContainer><Tabs.List className="sync-tabs" aria-label="外网同步">
      <Tabs.Tab id="sync"><Icon name="copy" />同步与回传<Tabs.Indicator /></Tabs.Tab>
    </Tabs.List></Tabs.ListContainer></WorkspaceNavigation>
    <div className="sync-location">
      <Icon name="folder" /><span className="sync-location-label">传输目录</span>
      <span className="min-w-0 flex-1 truncate" title={profile.transferDir}>
        {profile.transferDir}</span>
      <RefreshButton onPress={reloadAll} />
    </div>
    {!mirrorDir.trim() && <Feedback kind="warn" text="请在项目设置中填写外网镜像目录。" />}
    {!devRepos.length && <Feedback kind="warn" text="请在项目设置中添加开发仓库目录。" />}
    {current?.stateError && <Feedback kind="error" text={`无法读取同步记录，请检查后刷新。\n${current.stateError}`} />}
    {mirror.error && <Feedback kind="error" text={`无法读取外网镜像。\n${mirror.error}`} />}
    {mirror.status?.isRepo && !mirror.status.isBare && <Feedback kind="error" text="镜像目录必须是裸仓库，请检查项目设置。" />}
    {repo.error && <Feedback kind="error" text={`无法读取开发仓库。\n${repo.error}`} />}
    <Tabs.Panel className="sync-panel" id="sync" shouldForceMount style={({ isInert }) => ({ display: isInert ? "none" : undefined })}>
      <FeedbackScope value={!branchOpen}>
      <header className="internal-page-heading"><div><h1>同步与回传</h1></div></header>
      <section className="sync-workflow-section" aria-label="同步内网更新">
      {current?.packageError && <Feedback kind="error" text={`无法读取传输目录，请检查连接后刷新。\n${current.packageError}`} />}
      {current?.devError && <Feedback kind="error" text={`无法检查开发仓库同步状态，请刷新或重试同步。\n${current.devError}`} />}
      {current && !current.loading && !current.stateError && <>
        {missing && <Feedback kind="warn" text={`缺少更新 #${lastIn + 1}，请在传输目录补齐更新包或放入较新的全量包。`} />}
        {missingImpact && <Feedback kind="warn" text="无法读取完整引用影响，请刷新后再使用全量包跳号。" />}
      </>}
      <div className="sync-action">
        <div className="sync-action-copy"><h2>同步内网更新</h2>
          {current && !current.loading && !current.stateError && !mirror.error && <p>{summary}</p>}
        </div>
        <ActionButton variant="primary" onPress={() => sync()} isDisabled={!canSync}>
          {!chosen && mirrorReady && pendingDevs ? "完成同步" : "同步更新"}
        </ActionButton>
      </div>
      <section className="workspace-section" aria-label="开发仓库">
        <h2>开发仓库</h2>
        {devRepos.map((path) => {
          const status = current?.devs.find((d) => d.path === path);
          const labels = { upToDate: "已同步", needsFetch: "待同步", notCloned: "尚未克隆", unknown: "状态未知" };
          return <div key={path} className="sync-branch-row"><div className="sync-branch-copy"><Code>{path}</Code>
            <small>{status ? labels[status.status] : "状态未知"}{path === devDir ? " · 当前仓库" : ""}</small>
            {status?.error && <Feedback kind="error" text={`${path}\n${status.error}`} />}</div>
            <div className="sync-button-group">
            {path !== devDir && <ActionButton size="sm" variant="secondary" onPress={() => setDevPicked(path)}>切换</ActionButton>}
            <ActionButton size="sm" variant="outline" onPress={() => sync(null, [path])}
              isDisabled={!ready || !mirrorReady || needsFull}>{status?.status === "notCloned" ? "从镜像克隆" : "同步仓库"}</ActionButton>
            </div></div>;
        })}
      </section>
      </section>
      <section className="sync-workflow-section" aria-label="回传提交">
      <header className="internal-page-heading return-heading">
        <div><h2>回传提交</h2></div>
        <div className="return-controls">
          <RadioGroup className="sync-format-options" orientation="horizontal" aria-label="回传格式" value={mode} isDisabled={!!busy}
            onChange={(value) => {
              setMode(value as "bundle" | "patch");
              if (value === "patch") setSelected((previous) => previous.slice(0, 1));
            }}>
            {(["bundle", "patch"] as const).map((value) => <Radio key={value} value={value}>
              <Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>
                {value === "bundle" ? "Bundle" : "Patch（单分支）"}
              </Radio.Content>
            </Radio>)}
          </RadioGroup>
          <ActionButton variant="primary" onPress={doExport}
            isDisabled={!ready || !devReady || !mirrorReady || !selectedBranches.length || mode === "patch" && selectedBranches.length !== 1}>
            导出回传
          </ActionButton>
        </div>
      </header>
      <InProgressBanners status={repo.status} onDone={(outcome) => {
        if (outcome) setOpRes(outcome);
        void reloadAll();
      }} />
      <DirtyTreesNotice status={repo.status} suffix="回传只包含已提交的内容。" />
      {!devReady ? (!repo.loading && <Feedback kind="warn" text="请先同步更新并准备开发仓库。" />)
        : <BranchTable branches={branches} selected={selectedBranches} onSelect={setSelected} multi={mode === "bundle"}
            isSelectionDisabled={!!busy} emptyText="还没有可回传的开发分支。" />}

      {opRes && !opRes.ok && <OutcomeView outcome={opRes} />}
      {exportRes?.status === "exported" && <Fold className="sync-details" title={`查看回传 #${exportRes.seq} 文件`}>
        <Code>{exportRes.payload}</Code>
      </Fold>}
      </section>
      </FeedbackScope>
    </Tabs.Panel>
    </Tabs>
    <BranchManager key={refreshKey} profile={profile} repoPath={devDir} status={repo.status} loading={repo.loading} error={repo.error}
      isOpen={branchOpen} onOpenChange={setBranchOpen} onRefresh={reloadAll} target={branchTarget} />
  </>;
}

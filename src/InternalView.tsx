import { useCallback, useEffect, useRef, useState } from "react";
import { Radio, RadioGroup, Tabs } from "@heroui/react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, baseCandidates, defaultBaseFor, formatTime, releasesOf, type BranchInfo, type CommitInfo, type ExportOutcome, type InternalState, type OpOutcome, type Profile, type ReturnImportResult, type ReturnPackageInfo } from "./api";
import { useRunner } from "./runner";
import { BranchTable, DetachedWorktreesNotice, DirtyTreesNotice, InProgressBanners, useRefreshOnFocus, useRepoStatus, useRequestGeneration } from "./repoBits";
import { ActionButton, BaseSelect, Check, Code, Fold, CommitList, Empty, Notice, OutcomeView, RefreshButton, TextInput } from "./ui";
import { Icon } from "./icons";
import { ReturnPackageInbox } from "./ReturnPackageInbox";

export function InternalView({ profile }: { profile: Profile }) {
  const { run, notify, confirm, busy } = useRunner();
  const base = profile.baseBranch;
  const releases = releasesOf(profile);
  const candidates = baseCandidates(profile);
  const mirrorDir = profile.mirrorDir ?? "";
  const workDir = profile.workDir ?? "";
  const mirror = useRepoStatus(mirrorDir, base, releases, false);
  const work = useRepoStatus(workDir, base, releases, false);
  const refreshKey = JSON.stringify([profile.id, mirrorDir, workDir, base, releases, profile.transferDir]);
  const beginRefresh = useRequestGeneration(refreshKey);
  const actionContext = useRef(refreshKey);
  actionContext.current = refreshKey;
  useEffect(() => { actionContext.current = refreshKey; return () => { actionContext.current = ""; }; }, [refreshKey]);
  const [snapshot, setSnapshot] = useState<{
    key: string; state: InternalState | null; stateError: string | null;
    packages: ReturnPackageInfo[]; packageError: string | null;
  } | null>(null);
  const current = snapshot?.key === refreshKey ? snapshot : null;
  const state = current?.state ?? null;
  const stateError = current?.stateError ?? null;
  const packageError = current?.packageError ?? null;
  const packages = (current?.packages ?? []).filter((p) => !p.manifest || p.manifest.kind === "back" || p.manifest.kind === "patch");
  const pending = packages.filter((p) => !p.received);
  const mirrorReady = !!mirror.status?.isRepo;
  const workReady = !!work.status?.isRepo && !work.status.isBare;
  const branches = (work.status?.branches ?? []).filter((b) => !candidates.includes(b.name));
  const pendingBranches = branches.filter((b) => !work.status?.pushedBranches?.includes(b.name));

  const reloadAll = useCallback(async () => {
    const isCurrent = beginRefresh();
    if (!isCurrent()) return;
    const [stateResult, packageResult] = await Promise.all([
      mirrorDir ? api.internalState(mirrorDir).then(
        (state) => ({ state, stateError: null }),
        (error) => ({ state: null, stateError: String(error) }),
      ) : { state: null, stateError: null },
      api.listReturnPackages(workDir, profile.transferDir).then(
        (packages) => ({ packages, packageError: null }),
        (error) => ({ packages: [] as ReturnPackageInfo[], packageError: String(error) }),
      ),
      mirror.reload(), work.reload(),
    ]);
    if (isCurrent()) setSnapshot({ key: refreshKey, ...stateResult, ...packageResult });
  }, [beginRefresh, refreshKey, mirrorDir, workDir, profile.transferDir, mirror.reload, work.reload]);
  useEffect(() => { void reloadAll(); }, [reloadAll]);
  useRefreshOnFocus(reloadAll);

  const [forceFull, setForceFull] = useState(false);
  const [fetchFirst, setFetchFirst] = useState(true);
  const [exportResult, setExportResult] = useState<ExportOutcome | null>(null);
  const [returnResult, setReturnResult] = useState<ReturnImportResult | null>(null);
  const [outcome, setOutcome] = useState<OpOutcome | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const selectedBranch = branches.find((b) => b.name === selected[0]);
  const [ontoPicked, setOntoPicked] = useState<string | null>(null);
  const onto = ontoPicked ?? selectedBranch?.base ?? base;
  const changingBase = !!selectedBranch && onto !== selectedBranch.base;
  const [forceLease, setForceLease] = useState(false);
  useEffect(() => { setOntoPicked(null); setForceLease(false); }, [selected[0]]);
  useEffect(() => {
    if (work.loading || !work.status) return;
    setSelected((previous) => previous.filter((name) => work.status!.branches.some((b) => b.name === name)));
  }, [work.status, work.loading]);

  const branchLabel = (name: string) => work.status?.reviewSources?.[name]
    ?? returnResult?.branches.find((b) => b.local === name)?.source ?? name;
  const packageFor = (name: string) => packages.find((p) => p.receiptKey && name.startsWith(`review/${p.receiptKey}/`));
  const unfinished = !!work.status?.inProgress || !!work.status?.inProgressTrees.length;
  const commitKey = JSON.stringify([workDir, selectedBranch?.name, selectedBranch?.base]);
  const beginCommits = useRequestGeneration(commitKey);
  const [commitResult, setCommitResult] = useState<{ key: string; commits: CommitInfo[]; error: string | null } | null>(null);
  useEffect(() => {
    const isCurrent = beginCommits();
    setCommitResult(null);
    if (!selectedBranch || work.loading) return;
    api.listCommits(workDir, `origin/${selectedBranch.base}`, `refs/heads/${selectedBranch.name}`).then(
      (commits) => { if (isCurrent()) setCommitResult({ key: commitKey, commits, error: null }); },
      (error) => { if (isCurrent()) setCommitResult({ key: commitKey, commits: [], error: String(error) }); },
    );
  }, [beginCommits, commitKey, selectedBranch?.name, selectedBranch?.base, selectedBranch?.sha, workDir, work.loading]);
  const visibleCommits = commitResult?.key === commitKey ? commitResult : null;

  async function initialize() {
    const result = await run("建立镜像", () => api.initMirror(profile.remoteUrl?.trim() ?? "", mirrorDir));
    if (result !== undefined) notify("ok", "镜像已建立，可以导出更新");
    await reloadAll();
  }
  async function exportUpdate() {
    const result = await run("导出更新", () => api.exportOut({ mirrorDir, transferDir: profile.transferDir,
      repoName: profile.repoName, baseBranch: base, fetchUpstream: fetchFirst, forceFull }));
    if (result) { setExportResult(result); setForceFull(false); }
    await reloadAll();
  }
  async function receive(bundle: string, legacy = false) {
    if (legacy && !await confirm({ title: "导入没有清单的回传包", confirmLabel: "继续导入",
      body: <p>此文件没有项目清单。请确认它属于当前工作仓库，导入后会在独立工作树整理。</p> })) return;
    const result = await run("导入并整理回传", () => api.importReturn(workDir, bundle, base, releases));
    await reloadAll();
    if (result) {
      setReturnResult(result);
      setOutcome(result.outcomes.find((o) => !o.ok) ?? null);
      if (result.branches[0]) setSelected([result.branches[0].local]);
    }
  }
  async function browse() {
    const path = await open({ multiple: false, filters: [{ name: "Git bundle", extensions: ["bundle"] }] });
    if (typeof path === "string") await receive(path, true);
  }
  const [patchOptions, setPatchOptions] = useState<Record<string, { branch: string; base: string; path: string }>>({});
  function patchValues(pkg: ReturnPackageInfo) {
    const source = pkg.manifest?.refs[0];
    const branch = source?.name.replace(/^refs\/heads\//, "") ?? "";
    const separator = workDir.includes("\\") ? "\\" : "/";
    return patchOptions[pkg.payloadPath] ?? { branch, base: source?.base ?? defaultBaseFor(branch, profile),
      path: `${workDir.replace(/[\\/]+$/, "")}-reviews${separator}${branch.replace(/[^a-zA-Z0-9._-]/g, "_") || "patch"}` };
  }
  async function receivePatch(pkg: ReturnPackageInfo) {
    const options = patchValues(pkg);
    if (!options.branch.trim() || !options.path.trim()) return notify("warn", "请在补丁选项中填写分支和独立工作树目录");
    const result = await run("导入补丁", () => api.importPatches({ workDir, patchDir: pkg.payloadPath,
      branch: options.branch.trim(), baseBranch: options.base, fetchUpstream: true, worktreePath: options.path.trim() }));
    await reloadAll();
    if (result) { setOutcome(result); setSelected([options.branch.trim()]); }
  }
  async function rebaseBranch(branch: BranchInfo, target = branch.base) {
    // 尚未创建独立工作树时，从接收记录继续，不能切换主工作仓库。
    if (branch.name.startsWith("review/") && !branch.worktree) {
      const pkg = packageFor(branch.name);
      if (pkg) return receive(pkg.payloadPath);
      return notify("warn", "请接回原回传包，再继续整理此分支");
    }
    const result = await run("整理提交", () => api.rebaseOnto(workDir, branch.name, target, true));
    if (result) setOutcome(result);
    setOntoPicked(null);
    await reloadAll();
  }
  async function push(branch: BranchInfo) {
    const context = actionContext.current;
    const allowForce = selected[0] === branch.name && forceLease;
    const plan = await run("检查推送提交", () => api.preparePush(workDir, branch.name, allowForce));
    if (!plan || actionContext.current !== context) return;
    if (plan.nonFastForward && !allowForce) return notify("warn", "目标分支需要非快进更新，请在分支选项中核对并启用覆盖确认");
    const approved = await confirm({
      title: `推送 ${plan.targetRef.replace(/^refs\/heads\//, "")}`,
      confirmLabel: plan.nonFastForward ? "确认覆盖并推送" : "确认推送",
      tone: plan.nonFastForward ? "danger" : "accent",
      body: <div className="space-y-3">
        <p className="text-sm break-all">{plan.remoteUrl} · {plan.targetRef.replace(/^refs\/heads\//, "")}</p>
        {plan.nonFastForward && <Notice tone="warning" title="此操作会替换远程分支的提交历史，其他人的工作可能受影响。" />}
        <p className="text-sm text-muted">共 {plan.commits.length} 个待检查提交</p>
        <CommitList commits={plan.commits} empty="没有相对基准的新提交" />
        <Fold className="sync-details" title={"技术详情"}><dl className="break-all text-xs space-y-2">
          <dt>源提交</dt><dd><Code>{plan.sourceOid}</Code></dd><dt>远程旧提交</dt><dd><Code>{plan.remoteOid ?? "新分支"}</Code></dd>
          <dt>基准</dt><dd><Code>{plan.baseOid}</Code></dd>
        </dl></Fold>
      </div>,
    });
    if (!approved) return;
    if (actionContext.current !== context) return notify("warn", "工作区已变化，请重新检查后推送");
    const result = await run("推送", () => api.executePush(plan.planId));
    if (result) {
      setOutcome({ ...result, message: result.message.replace(/refs\/heads\//g, "") });
      if (result.ok) { setReturnResult(null); setSelected([]); }
    }
    await reloadAll();
  }
  function packageIssue(pkg: ReturnPackageInfo) {
    return !pkg.payloadExists ? "包文件缺失，请重新复制。"
      : pkg.manifest && state?.repoId && pkg.manifest.repoId !== state.repoId ? "包属于其他项目。" : null;
  }
  function packageRow(pkg: ReturnPackageInfo) {
    const manifest = pkg.manifest;
    const patch = manifest?.kind === "patch";
    const options = patchValues(pkg);
    const reason = packageIssue(pkg);
    return <div className="sync-package" key={pkg.payloadPath}>
      <div className="sync-action">
        <span className="sync-action-icon" aria-hidden="true"><Icon name="branch" /></span>
        <div className="min-w-0 flex-1"><h2>{manifest ? `${patch ? "补丁" : "回传"} #${manifest.seq}` : "回传包"}</h2>
          <p className="text-sm text-muted break-all">{manifest?.refs.map((r) => r.name.replace(/^refs\/heads\//, "")).join("、") || pkg.payloadPath}</p>
          {reason && <p className="text-sm text-danger">{reason}</p>}
        </div>
        <ActionButton variant={pkg.received ? "secondary" : "primary"} isDisabled={!workReady || work.loading || !current || !!stateError || !!reason || unfinished}
          onPress={() => patch ? receivePatch(pkg) : receive(pkg.payloadPath, !manifest)}>{pkg.received ? "继续整理" : "导入回传"}</ActionButton>
      </div>
      <Fold className="sync-details" title={patch ? "补丁选项" : "内容"}>
        <p className="text-xs break-all text-muted">{pkg.payloadPath}</p>
        {manifest && <p className="text-xs text-muted">{formatTime(manifest.createdAt)} · {manifest.refs.length} 个分支</p>}
        {patch && <div className="space-y-3 mt-3">
          <TextInput label="应用到的新分支" value={options.branch} onChange={(branch) => setPatchOptions((p) => ({ ...p, [pkg.payloadPath]: { ...options, branch } }))} mono />
          <BaseSelect label="基准分支" value={options.base} options={candidates} mainline={base} onChange={(base) => setPatchOptions((p) => ({ ...p, [pkg.payloadPath]: { ...options, base } }))} />
          <TextInput label="独立工作树目录" value={options.path} onChange={(path) => setPatchOptions((p) => ({ ...p, [pkg.payloadPath]: { ...options, path } }))} mono />
        </div>}
      </Fold>
    </div>;
  }

  return <Tabs className="sync-workspace" variant="secondary" defaultSelectedKey="export">
    <Tabs.ListContainer><Tabs.List className="sync-tabs" aria-label="同步操作">
      <Tabs.Tab id="export">导出更新<Tabs.Indicator /></Tabs.Tab>
      <Tabs.Tab id="return">导入回传{pending.length > 0 && <span className="counter">{pending.length}</span>}<Tabs.Indicator /></Tabs.Tab>
    </Tabs.List></Tabs.ListContainer>
    <div className="sync-location"><Icon name="folder" /><span className="min-w-0 flex-1 truncate" title={profile.transferDir}>{profile.transferDir}</span><RefreshButton onPress={reloadAll} /></div>
    {stateError && <Notice tone="danger" title="无法读取同步记录，请检查后重试"><Fold title={"查看原因"}>{stateError}</Fold></Notice>}
    {packageError && <Notice tone="danger" title="无法读取传输目录，请检查连接后刷新"><Fold title={"查看原因"}>{packageError}</Fold></Notice>}
    <Tabs.Panel className="sync-panel" id="export" shouldForceMount style={({ isInert }) => ({ display: isInert ? "none" : undefined })}>
      {mirror.error && <Notice tone="danger" title="读取镜像失败">{mirror.error}</Notice>}
      <div className="sync-action">
        <span className="sync-action-icon" aria-hidden="true"><Icon name="branch" /></span>
        <div className="min-w-0 flex-1"><h1>{mirrorReady ? "导出最新代码" : "建立内网镜像"}</h1>
          <p className="text-sm text-muted">{mirrorReady ? `${base}${releases.length ? `、${releases.join("、")}` : ""} 等 ${mirror.status?.branches.length ?? 0} 个分支` : "首次使用时从 GitLab 准备代码"}</p>
        </div>
        {mirrorReady ? <ActionButton variant="primary" onPress={exportUpdate} isDisabled={!current || !!stateError || !!mirror.error || mirror.loading}>导出更新</ActionButton>
          : <ActionButton variant="primary" onPress={initialize} isDisabled={!profile.remoteUrl?.trim() || !mirrorDir || mirror.loading || !!mirror.error || !!stateError}>建立镜像</ActionButton>}
      </div>
      <Fold className="sync-details" title={"选项"}><div className="space-y-3">
        <Check checked={fetchFirst} onChange={setFetchFirst}>先拉取 GitLab 最新代码</Check>
        <Check checked={forceFull} onChange={setForceFull}>强制全量</Check>
        <p className="text-xs text-muted break-all">镜像：{mirrorDir || "请在项目设置中填写"}</p>
        {state && <p className="text-xs text-muted">{state.outSeq ? `最近已导出 #${state.outSeq} · ${formatTime(state.lastExportAt)}` : "尚未导出"}</p>}
      </div></Fold>
      {exportResult && <div className="sync-result" role="status">{exportResult.status === "nothingToSync" ? exportResult.message : <>
        已导出更新 #{exportResult.seq}<Fold className="sync-details" title={"查看文件"}><p className="break-all">{exportResult.payload}</p>
          {exportResult.warnings.map((warning) => <p key={warning}>{warning}</p>)}</Fold></>}</div>}
    </Tabs.Panel>
    <Tabs.Panel className="sync-panel" id="return" shouldForceMount style={({ isInert }) => ({ display: isInert ? "none" : undefined })}>
      {work.error && <Notice tone="danger" title="读取工作仓库失败">{work.error}</Notice>}
      {!workReady && !work.loading && !work.error && <Notice tone="warning" title="请先在项目设置中填写已克隆的内网工作仓库。" />}
      <InProgressBanners status={work.status} onDone={(result) => { if (result) setOutcome(result); void reloadAll(); }} />
      {!packageError && current && packages.length > 0 && <ReturnPackageInbox key={refreshKey}
        packages={packages} disabled={!!busy || work.loading} getIssue={packageIssue} renderDetails={packageRow} />}
      {!packageError && current && packages.length === 0 && pendingBranches.length === 0 && <Empty>没有待处理的回传。</Empty>}
      {returnResult?.warnings.map((warning) => <Notice key={warning} tone="warning" title={warning} />)}
      {returnResult && pendingBranches.some((branch) => returnResult.branches.some((item) => item.local === branch.name)) && !returnResult.outcomes.some((o) => !o.ok) && <p className="sync-result" role="status">整理已完成，可以检查并推送。</p>}
      {pendingBranches.length > 0 && <><h2 className="return-review-heading">待检查分支 <span>{pendingBranches.length}</span></h2><RadioGroup className="sync-branches" aria-label="可检查的分支"
        value={selected[0] ?? ""} onChange={(name) => setSelected([name])} isDisabled={!!busy}>
        {pendingBranches.map((branch) => <div className="sync-branch-row" key={branch.name}>
        <Radio className="sync-branch-choice" value={branch.name} aria-label={`选择 ${branchLabel(branch.name)}`}>
          <Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>
          <span className="min-w-0"><code className="break-all">{branchLabel(branch.name)}</code><small className="block text-muted">{branch.ahead} 个提交 · {branch.base}{branch.behind > 0 ? " · 需要整理" : ""}</small></span>
          </Radio.Content></Radio>
        {branch.behind > 0 || (branch.name.startsWith("review/") && !branch.worktree)
          ? <ActionButton size="sm" variant="secondary" onPress={() => rebaseBranch(branch)} isDisabled={unfinished || work.loading}>继续整理</ActionButton>
          : <ActionButton size="sm" variant="primary" onPress={() => { setSelected([branch.name]); void push(branch); }} isDisabled={unfinished || work.loading || !workReady || !!stateError || (selected[0] === branch.name && changingBase)}>检查并推送</ActionButton>}
      </div>)}</RadioGroup></>}
      {selectedBranch && <Fold className="sync-details" title={"提交与分支选项"}><div className="space-y-4">
        <h3>{branchLabel(selectedBranch.name)}</h3>
        {visibleCommits?.error ? <Notice tone="danger" title="读取提交失败，请刷新">{visibleCommits.error}</Notice>
          : visibleCommits ? <CommitList commits={visibleCommits.commits} /> : <p role="status">正在读取提交…</p>}
        <BaseSelect label="基准分支" value={onto} options={candidates} mainline={base} onChange={setOntoPicked} />
        {changingBase && <p className="text-sm text-muted">将提交整理到 origin/{onto}，不会推送。</p>}
        <Check checked={forceLease} onChange={setForceLease}>允许非快进更新（推送前再次确认覆盖）</Check>
        <ActionButton variant="secondary" isDisabled={!workReady || unfinished} onPress={() => rebaseBranch(selectedBranch, onto)}>整理提交</ActionButton>
      </div></Fold>}
      {outcome && (outcome.ok ? <p className="sync-result" role="status">{outcome.message}</p> : <OutcomeView outcome={outcome} />)}
      <Fold className="sync-details" title={"其他回传与分支管理"}><div className="space-y-4">
        <ActionButton size="sm" variant="secondary" onPress={browse} isDisabled={!workReady || !!stateError || unfinished}>选择其他文件…</ActionButton>
        <DirtyTreesNotice status={work.status} suffix="回传在独立工作树中整理。" />
        <BranchTable branches={branches} selected={selected} onSelect={setSelected} repoPath={workDir} onDeleted={reloadAll}
          onRebase={(branch) => { setSelected([branch.name]); void rebaseBranch(branch); }} />
        <DetachedWorktreesNotice status={work.status} />
      </div></Fold>
    </Tabs.Panel>
  </Tabs>;
}

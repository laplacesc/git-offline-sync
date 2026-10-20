import { useCallback, useEffect, useRef, useState } from "react";
import { Tabs } from "@heroui/react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, baseCandidates, defaultBaseFor, releasesOf, type ExportOutcome, type InternalState, type OpOutcome, type Profile, type ReturnImportResult, type ReturnPackageInfo } from "./api";
import { Feedback, FeedbackScope, useRunner } from "./runner";
import { InProgressBanners, useRefreshOnFocus, useRepoStatus, useRequestGeneration } from "./repoBits";
import { ActionButton, BaseSelect, Check, Code, Fold, Empty, OutcomeView, RefreshButton, TextInput, WorkspaceNavigation } from "./ui";
import { Icon } from "./icons";
import { ReturnPackageInbox } from "./ReturnPackageInbox";
import { DateTime } from "./DateTime";
import { BranchManager } from "./BranchManager";

export function InternalView({ profile, navigationTarget, branchTarget, onNavigate }: {
  profile: Profile; navigationTarget?: HTMLElement | null; branchTarget?: HTMLElement | null; onNavigate?: () => void;
}) {
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
  const mirrorReady = !!mirror.status?.isRepo;
  const workReady = !!work.status?.isRepo && !work.status.isBare;

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

  const [branchOpen, setBranchOpen] = useState(false);
  const [forceFull, setForceFull] = useState(false);
  const [fetchFirst, setFetchFirst] = useState(true);
  const [exportResult, setExportResult] = useState<ExportOutcome | null>(null);
  const [returnResult, setReturnResult] = useState<ReturnImportResult | null>(null);
  const [outcome, setOutcome] = useState<OpOutcome | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => { setReturnResult(null); setOutcome(null); setSelected([]); }, [refreshKey]);
  useEffect(() => {
    if (work.loading || !work.status) return;
    setSelected((previous) => previous.filter((name) => work.status!.branches.some((b) => b.name === name)));
  }, [work.status, work.loading]);

  const unfinished = !!work.status?.inProgress || !!work.status?.inProgressTrees.length;

  async function initialize() {
    const result = await run("建立镜像", () => api.initMirror(profile.remoteUrl?.trim() ?? "", mirrorDir));
    if (result !== undefined) notify("ok", "镜像已建立，可以导出更新");
    await reloadAll();
  }
  async function exportUpdate() {
    const result = await run("导出更新", () => api.exportOut({ mirrorDir, transferDir: profile.transferDir,
      repoName: profile.repoName, baseBranch: base, fetchUpstream: fetchFirst, forceFull }));
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
    if (legacy && !await confirm({ title: "导入没有清单的回传包", confirmLabel: "继续导入",
      body: <p>此文件没有项目清单。请确认它属于当前工作仓库。回传分支会优先按外网原名导入本地；目标分支若已被检出，请先切换到其他分支。</p> })) return;
    const context = actionContext.current;
    const result = await run("导入回传", () => api.importReturn(workDir, bundle, base, releases));
    if (actionContext.current !== context) return;
    await reloadAll();
    if (actionContext.current !== context) return;
    if (result) {
      setReturnResult(result);
      const issue = result.outcomes.find((o) => !o.ok);
      setOutcome(issue ?? null);
      let kind: "ok" | "warn" | "error" = result.warnings.length ? "warn" : "ok";
      if (issue) kind = issue.conflict ? "warn" : "error";
      notify(kind, [issue?.message ?? "回传已导入，可在分支管理中检查、整理和推送。", ...result.warnings].join("\n"));
      if (result.branches[0]) setSelected([result.branches[0].local]);
    }
  }
  async function browse() {
    const path = await open({ multiple: false, filters: [{ name: "Git bundle", extensions: ["bundle"] }] });
    if (typeof path === "string") await receive(path, true);
  }
  const [patchOptions, setPatchOptions] = useState<Record<string, { branch: string; base: string }>>({});
  function patchValues(pkg: ReturnPackageInfo) {
    const source = pkg.manifest?.refs[0];
    const branch = source?.name.replace(/^refs\/heads\//, "") ?? "";
    return patchOptions[pkg.payloadPath] ?? { branch, base: source?.base ?? defaultBaseFor(branch, profile) };
  }
  async function receivePatch(pkg: ReturnPackageInfo) {
    const options = patchValues(pkg);
    if (!options.branch.trim()) return notify("warn", "请在补丁选项中填写分支");
    const result = await run("导入补丁", () => api.importPatches({ workDir, patchDir: pkg.payloadPath,
      branch: options.branch.trim(), baseBranch: options.base, fetchUpstream: true }));
    await reloadAll();
    if (result) { setOutcome(result); setSelected([options.branch.trim()]); }
  }
  function packageIssue(pkg: ReturnPackageInfo) {
    return !pkg.payloadExists ? "包文件缺失，请重新复制。"
      : pkg.error ? `包内容无法读取，请检查后重新复制：${pkg.error}`
      : pkg.manifest && state?.repoId && pkg.manifest.repoId !== state.repoId ? "包属于其他项目。" : null;
  }
  function packageRow(pkg: ReturnPackageInfo) {
    const manifest = pkg.manifest;
    const patch = manifest?.kind === "patch";
    const options = patchValues(pkg);
    const reason = packageIssue(pkg);
    return <div className="return-package-details" key={pkg.payloadPath}>
      {reason && <p className="return-package-error">{reason}</p>}
      <div className="return-package-actions">
        <Fold className="return-package-options" title={patch ? "补丁选项" : "包详情"}>
          <p className="text-xs break-all text-muted">{pkg.payloadPath}</p>
          {manifest && <>
            <div className="text-xs text-muted">{patch ? "Patch" : "Bundle"} #{manifest.seq} · {manifest.refs.length} 个分支 · <DateTime value={manifest.createdAt} label="包创建时间" /></div>
            <ul className="return-package-refs">{manifest.refs.map((ref) => <li key={ref.name}><Code>{ref.name.replace(/^refs\/heads\//, "")}</Code></li>)}</ul>
          </>}
          {patch && <div className="space-y-3 mt-3">
            <TextInput label="应用到的新分支" value={options.branch} onChange={(branch) => setPatchOptions((p) => ({ ...p, [pkg.payloadPath]: { ...options, branch } }))} mono />
            <BaseSelect label="基准分支" value={options.base} options={candidates} mainline={base} onChange={(base) => setPatchOptions((p) => ({ ...p, [pkg.payloadPath]: { ...options, base } }))} />
            <p className="text-xs text-muted">补丁会在当前工作仓库切换到所填分支并应用，请保持工作区干净。</p>
          </div>}
        </Fold>
        <ActionButton variant="primary" isDisabled={!workReady || work.loading || !current || !!stateError || !!reason || unfinished}
          onPress={() => patch ? receivePatch(pkg) : receive(pkg.payloadPath, !manifest)}>导入回传</ActionButton>
      </div>
    </div>;
  }

  return <><Tabs className="sync-workspace" variant="secondary" orientation={navigationTarget ? "vertical" : "horizontal"}
    selectedKey="sync" onSelectionChange={() => onNavigate?.()}>
    {!current && <Feedback kind="progress" text="正在读取仓库与回传包…" />}
    <WorkspaceNavigation target={navigationTarget}><Tabs.ListContainer><Tabs.List className="sync-tabs" aria-label="同步操作">
      <Tabs.Tab id="sync"><Icon name="copy" />同步与回传<Tabs.Indicator /></Tabs.Tab>
    </Tabs.List></Tabs.ListContainer></WorkspaceNavigation>
    <div className="sync-location"><Icon name="folder" /><span className="sync-location-label">传输目录</span><span className="min-w-0 flex-1 truncate" title={profile.transferDir}>{profile.transferDir}</span><RefreshButton onPress={reloadAll} /></div>
    {stateError && <Feedback kind="error" text={`无法读取同步记录，请检查后重试\n${stateError}`} />}
    <Tabs.Panel className="sync-panel" id="sync" shouldForceMount style={({ isInert }) => ({ display: isInert ? "none" : undefined })}>
      <FeedbackScope value={!branchOpen}>
      <header className="internal-page-heading"><div><h1>同步与回传</h1></div></header>
      <section className="sync-workflow-section" aria-label="导出更新">
      {mirror.error && <Feedback kind="error" text={`读取镜像失败\n${mirror.error}`} />}
      <div className="sync-action">
        <div className="min-w-0 flex-1"><h2>{mirrorReady ? "导出最新代码" : "建立内网镜像"}</h2>
          <p className="text-sm text-muted">{mirrorReady ? `${base}${releases.length ? `、${releases.join("、")}` : ""} 等 ${mirror.status?.branches.length ?? 0} 个分支` : "首次使用时从 GitLab 准备代码"}</p>
        </div>
        {mirrorReady ? <ActionButton variant="primary" onPress={exportUpdate} isDisabled={!current || !!stateError || !!mirror.error || mirror.loading}>导出更新</ActionButton>
          : <ActionButton variant="primary" onPress={initialize} isDisabled={!profile.remoteUrl?.trim() || !mirrorDir || mirror.loading || !!mirror.error || !!stateError}>建立镜像</ActionButton>}
      </div>
      <section className="workspace-section" aria-label="导出设置">
        <Check checked={fetchFirst} onChange={setFetchFirst}>先拉取 GitLab 最新代码</Check>
        {state && <div className="export-history">{state.outSeq ? <>最近已导出 #{state.outSeq} · <DateTime value={state.lastExportAt} label="最近导出时间" /></> : "尚未导出"}</div>}
        <Fold className="sync-details" title="高级选项"><div className="space-y-3">
          <Check checked={forceFull} onChange={setForceFull}>强制全量</Check>
          <p className="text-xs text-muted break-all">镜像：{mirrorDir || "请在项目设置中填写"}</p>
        </div></Fold>
      </section>
      {exportResult?.status === "exported" && <Fold className="sync-details" title={`查看更新 #${exportResult.seq} 文件`}>
        <Code>{exportResult.payload}</Code>
      </Fold>}
      </section>
      <section className="sync-workflow-section internal-return" aria-label="导入回传">
      {packageError && <Feedback kind="error" text={`无法读取传输目录，请检查连接后刷新\n${packageError}`} />}
      {work.error && <Feedback kind="error" text={`读取工作仓库失败\n${work.error}`} />}
      {!workReady && !work.loading && !work.error && <Feedback kind="warn" text="请先在项目设置中填写已克隆的内网工作仓库。" />}
      <header className="internal-page-heading">
        <div><h2>导入回传</h2></div>
        <ActionButton size="sm" variant="ghost" onPress={browse} isDisabled={!workReady || !!stateError || unfinished}><Icon name="folder" />选择其他文件…</ActionButton>
      </header>
      <InProgressBanners status={work.status} onDone={(result) => { if (result) setOutcome(result); void reloadAll(); }} />
      {!packageError && current && packages.length > 0 && <ReturnPackageInbox key={refreshKey}
        packages={packages} disabled={!!busy || work.loading} renderDetails={packageRow} />}
      {!packageError && current && packages.length === 0 && <Empty>没有回传包。</Empty>}
      {returnResult && returnResult.branches.length > 0 && <div className="return-import-result" role="status">
        <div><h2>已导入本地分支</h2><p>{returnResult.branches.map((branch) => <Code key={branch.local}>{branch.local}</Code>)}</p></div>
        <ActionButton variant="secondary" onPress={() => setBranchOpen(true)}>前往分支管理<Icon name="chevron" /></ActionButton>
      </div>}
      {outcome && !outcome.ok && <OutcomeView outcome={outcome} />}
      </section>
      </FeedbackScope>
    </Tabs.Panel>
  </Tabs>
  <BranchManager key={refreshKey} profile={profile} repoPath={workDir} status={work.status} loading={work.loading} error={work.error}
    isOpen={branchOpen} onOpenChange={setBranchOpen} onRefresh={reloadAll} target={branchTarget} initialSelection={selected} pushBlocked={!!stateError} />
  </>;
}

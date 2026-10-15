import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Input } from "@heroui/react";
import {
  api,
  baseCandidates,
  BranchInfo,
  CommitInfo,
  defaultBaseFor,
  ExportOutcome,
  formatTime,
  ImportBackResult,
  InternalState,
  OpOutcome,
  PackageInfo,
  prefixWarning,
  Profile,
  releasesOf,
  shortSha,
} from "./api";
import { useRunner } from "./runner";
import { BranchTable, DetachedWorktreesNotice, DirtyTreesNotice, InProgressBanners, useRefreshOnFocus, useRepoStatus, useRequestGeneration } from "./repoBits";
import {
  ActionButton,
  BaseSelect,
  Check,
  Code,
  CommitList,
  Empty,
  KindChip,
  Notice,
  OutcomeView,
  PackageRow,
  RefreshButton,
  StepCard,
  WorkflowNav,
  Workflow,
  Pipeline,
  WorkflowJump,
  TextInput,
} from "./ui";

export function InternalView({ profile }: { profile: Profile }) {
  const { run, notify, confirm } = useRunner();
  const base = profile.baseBranch;
  const releases = releasesOf(profile);
  const candidates = baseCandidates(profile);
  const mirrorDir = profile.mirrorDir ?? "";
  const workDir = profile.workDir ?? "";

  const mirror = useRepoStatus(mirrorDir, base, releases, false);
  const work = useRepoStatus(workDir, base, releases, false);
  const refreshKey = JSON.stringify([profile.id, mirrorDir, workDir, base, releases, profile.transferDir]);
  const beginRefresh = useRequestGeneration(refreshKey);
  const [snapshot, setSnapshot] = useState<{
    key: string; state: InternalState | null; packages: PackageInfo[]; packageError: string | null;
  } | null>(null);
  const current = snapshot?.key === refreshKey ? snapshot : null;
  const state = current?.state ?? null;
  const packages = current?.packages ?? [];
  const packageError = current?.packageError ?? null;

  const reloadAll = useCallback(async () => {
    const isCurrent = beginRefresh();
    if (!isCurrent()) return;
    const [nextState, packageResult] = await Promise.all([
      mirrorDir ? api.internalState(mirrorDir).catch(() => null) : null,
      api.listPackages(profile.transferDir).then(
        (packages) => ({ packages, packageError: null }),
        (error) => ({ packages: [] as PackageInfo[], packageError: String(error) }),
      ),
      mirror.reload(),
      work.reload(),
    ]);
    if (!isCurrent()) return;
    setSnapshot({ key: refreshKey, state: nextState, ...packageResult });
  }, [beginRefresh, refreshKey, mirror.reload, work.reload, mirrorDir, profile.transferDir]);

  useEffect(() => { void reloadAll(); }, [reloadAll]);
  useRefreshOnFocus(reloadAll);

  // ---------- 1. 镜像 ----------
  const [url, setUrl] = useState(profile.remoteUrl ?? "");
  useEffect(() => setUrl(profile.remoteUrl ?? ""), [profile.remoteUrl]);

  const initMirror = async () => {
    const ok = await run("克隆镜像", () => api.initMirror(url.trim(), mirrorDir));
    if (ok !== undefined) notify("ok", "镜像仓库已创建");
    reloadAll();
  };

  // ---------- 2. 导出 ----------
  const [fetchFirst, setFetchFirst] = useState(true);
  const [forceFull, setForceFull] = useState(false);
  const [exportRes, setExportRes] = useState<ExportOutcome | null>(null);

  const doExport = async () => {
    const r = await run("导出到 U 盘", () =>
      api.exportOut({
        mirrorDir,
        transferDir: profile.transferDir,
        repoName: profile.repoName,
        baseBranch: base,
        fetchUpstream: fetchFirst,
        forceFull,
      }),
    );
    if (r) {
      setExportRes(r);
      setForceFull(false);
    }
    reloadAll();
  };

  // ---------- 3. 导入回传 ----------
  const backPkgs = packages.filter((p) => !p.manifest || p.manifest.kind === "back" || p.manifest.kind === "patch");
  const [importRes, setImportRes] = useState<ImportBackResult | null>(null);
  const [patchOutcome, setPatchOutcome] = useState<OpOutcome | null>(null);
  const [patchBranch, setPatchBranch] = useState<Record<string, string>>({});
  const [patchBase, setPatchBase] = useState<Record<string, string>>({});
  /** patch 包默认分支名与基准：优先用 manifest 记录，没有记录时按前缀推断 */
  const patchDefaults = (pkg: PackageInfo) => {
    const ref = pkg.manifest?.refs[0];
    const name = (patchBranch[pkg.payloadPath] ?? ref?.name.replace(/^refs\/heads\//, "") ?? "").trim();
    const b = patchBase[pkg.payloadPath] ?? ref?.base ?? defaultBaseFor(name, profile);
    return { name, base: b };
  };

  const importBundle = async (path: string) => {
    setPatchOutcome(null);
    const r = await run("导入回传包", () => api.importBack(workDir, path, base, releases));
    if (r) {
      setImportRes(r);
      const first = r.branches[0]?.local;
      if (first) setSelected([first]);
    }
    reloadAll();
  };

  // 补丁可以应用到独立 worktree，不抢工作仓库当前检出的分支
  const [patchWorktree, setPatchWorktree] = useState(false);
  const [patchWtPath, setPatchWtPath] = useState("");
  const browsePatchWorktree = async () => {
    const p = await open({ directory: true, multiple: false });
    if (typeof p === "string") setPatchWtPath(p);
  };

  const importPatch = async (pkg: PackageInfo) => {
    setImportRes(null);
    const { name: branch, base: patchOnto } = patchDefaults(pkg);
    if (!branch) return notify("warn", "请填写导入到的分支名");
    const wt = patchWorktree ? patchWtPath.trim() : undefined;
    if (patchWorktree && !wt) return notify("warn", "请选择 worktree 目录");
    const r = await run("应用补丁", () =>
      api.importPatches({
        workDir,
        patchDir: pkg.payloadPath,
        branch,
        baseBranch: patchOnto,
        fetchUpstream: true,
        worktreePath: wt,
      }),
    );
    if (r) {
      setPatchOutcome(r);
      setSelected([branch]);
      if (wt) setPatchWtPath("");
    }
    reloadAll();
  };

  const browseBundle = async () => {
    const p = await open({ multiple: false, filters: [{ name: "Git bundle", extensions: ["bundle"] }] });
    if (typeof p === "string") importBundle(p);
  };

  // ---------- 4. 检查并推送 ----------
  const [selected, setSelected] = useState<string[]>([]);
  const branch = selected[0];
  const [commitResult, setCommitResult] = useState<{
    key: string; status: typeof work.status; commits: CommitInfo[]; error: string | null;
  } | null>(null);
  const [fetchBeforeRebase, setFetchBeforeRebase] = useState(true);
  const [forceLease, setForceLease] = useState(false);
  const [opRes, setOpRes] = useState<OpOutcome | null>(null);
  const branchInfo = work.status?.branches.find((b) => b.name === branch);
  // 用户在下拉框里改的基准；null 表示使用分支记录（或推断）的基准
  const [ontoPicked, setOntoPicked] = useState<string | null>(null);
  const onto = ontoPicked ?? branchInfo?.base ?? base;
  const changingBase = !!branchInfo && onto !== branchInfo.base;
  const branchWarning = branch ? prefixWarning(branch, onto, profile) : null;

  useEffect(() => {
    setOpRes(null);
    setOntoPicked(null);
  }, [branch]);

  // 改基准时 rebase --onto 只搬运“旧基准..分支”的提交，列表也按旧基准显示
  const listFrom = changingBase && branchInfo ? branchInfo.base : onto;
  const commitKey = JSON.stringify([profile.id, workDir, branch, listFrom]);
  const beginCommits = useRequestGeneration(commitKey);
  const currentCommits = !work.loading && commitResult?.key === commitKey && commitResult.status === work.status ? commitResult : null;
  const commits = currentCommits?.commits ?? [];
  const commitsReady = !!branch && !!work.status?.isRepo && !!currentCommits && !currentCommits.error;
  const pushKey = JSON.stringify([commitKey, onto, forceLease]);
  const pushContext = useRef({ key: pushKey, result: currentCommits, ready: commitsReady });
  pushContext.current = { key: pushKey, result: currentCommits, ready: commitsReady };
  useEffect(() => {
    const isCurrent = beginCommits();
    setCommitResult(null);
    if (!branch || !work.status?.isRepo || work.loading) return;
    const status = work.status;
    api.listCommits(workDir, `origin/${listFrom}`, `refs/heads/${branch}`).then(
      (commits) => {
        if (isCurrent()) setCommitResult({ key: commitKey, status, commits, error: null });
      },
      (error) => {
        if (isCurrent()) setCommitResult({ key: commitKey, status, commits: [], error: String(error) });
      },
    );
  }, [beginCommits, commitKey, branch, work.status, work.loading, workDir, listFrom]);

  const rebaseBranch = async (name: string, targetBase: string) => {
    const r = await run("Rebase", () => api.rebaseOnto(workDir, name, targetBase, fetchBeforeRebase));
    setOntoPicked(null);
    if (r) setOpRes(r);
    reloadAll();
  };
  const rebase = () => rebaseBranch(branch, onto);
  const rebaseRow = async (target: BranchInfo) => {
    const targetBase = target.name === branch ? onto : target.base;
    const approved = await confirm({
      title: `Rebase ${target.name}`,
      confirmLabel: "Rebase",
      body: <div className="space-y-3">
        <p>将 <Code>{target.name}</Code> Rebase 到 <Code>origin/{targetBase}</Code>。</p>
        <p className="text-sm text-muted">{fetchBeforeRebase ? "执行前会 fetch origin。" : "使用当前本地的 origin 引用，不执行 fetch。"}</p>
      </div>,
    });
    if (approved) {
      setSelected([target.name]);
      await rebaseBranch(target.name, targetBase);
    }
  };

  const push = async () => {
    if (!commitsReady || changingBase || !branchInfo) return;
    const approvedCommits = currentCommits;
    const ok = await confirm({
      title: `推送 ${branch}`,
      tone: forceLease ? "danger" : "accent",
      confirmLabel: "推送",
      body: (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            推送到 <Code>origin</Code>
            {forceLease && "（force-with-lease）"}，共 {commits.length} 个相对 origin/{onto} 的提交：
          </p>
          <CommitList commits={commits.slice(0, 20)} empty={`没有相对 origin/${onto} 的新提交`} />
          {commits.length > 20 && <p className="text-xs text-muted">…另有 {commits.length - 20} 个</p>}
        </div>
      ),
    });
    if (!ok) return;
    if (!pushContext.current.ready || pushContext.current.key !== pushKey || pushContext.current.result !== approvedCommits) {
      notify("warn", "分支或提交列表已更新，请重新检查后推送");
      return;
    }
    const r = await run("推送", () => api.pushBranch(workDir, branch, forceLease));
    if (r) setOpRes(r);
    reloadAll();
  };

  const mirrorReady = !!mirror.status?.isRepo;
  const workReady = !!work.status?.isRepo && !work.status.isBare;

  function nextStep() {
    if (work.status?.inProgress || work.status?.inProgressTrees.length) return { title: "处理未完成的操作", detail: "检查工作树冲突，再继续或中止。", step: 4 };
    if (!current || mirror.loading || work.loading) return { title: "检查仓库状态", detail: "正在读取仓库和同步记录。", step: 1 };
    if (packageError) return { title: "检查传输目录", detail: "确认路径和 U 盘连接后刷新。", step: 3 };
    if (!mirrorReady) return { title: "建立镜像仓库", detail: "从内网 GitLab 克隆，用于后续导出。", step: 1 };
    if (backPkgs.length) return { title: "检查外网回传", detail: "传输目录中存在回传包，请核对分支与提交。", step: 3 };
    return { title: "导出内网代码", detail: "拉取最新引用，生成可带往外网的同步包。", step: 2 };
  }

  return (
    <Workflow>
      <Pipeline onRefresh={reloadAll} lanes={[
        { label: "出站 · 内网 → 外网", commands: ["clone / fetch", "bundle"], nodes: [
          { title: "GitLab", detail: mirror.status?.remoteUrl || "远程地址尚未读取", step: 1, icon: "globe" },
          { title: "镜像仓库", detail: mirror.loading ? "读取中…" : mirrorReady ? `${mirror.status?.branches.length} 个分支` : "尚未就绪", step: 1, icon: "folder" },
          { title: "U 盘 · 内网包", detail: state ? `已导出 #${state.outSeq}` : "暂无导出记录", step: 2, icon: "folder" },
        ] },
        { label: "回站 · 外网 → 内网", commands: ["import / am", "rebase / push"], nodes: [
          { title: "U 盘 · 回传包", detail: packageError ? "传输目录不可读" : current ? `${backPkgs.length} 个可见包` : "读取中…", step: 3, icon: "folder" },
          { title: "工作仓库", detail: work.loading ? "读取中…" : workReady ? `${work.status?.branches.length} 个分支` : "尚未就绪", step: 3, icon: "monitor" },
          { title: "GitLab", detail: "检查提交后推送", step: 4, icon: "globe" },
        ] },
      ]} next={nextStep()} />
      <WorkflowNav steps={["镜像仓库", "导出到 U 盘", "导入外网回传", "Rebase 并推送"]}
        counts={[mirror.status?.branches.length, undefined, current ? backPkgs.length : undefined, work.status?.branches.filter((b) => !candidates.includes(b.name)).length]} />
      {packageError && <Notice tone="danger" title="无法读取传输目录，请检查路径或 U 盘连接后刷新">{packageError}</Notice>}
      <StepCard
        step={1}
        label="Mirror"
        title="镜像仓库"
        description={
          <>
            <Code>git clone --mirror</Code> 到 <Code>{mirrorDir}</Code>，只用于打包，不在这里推送
          </>
        }
        actions={
          <RefreshButton onPress={reloadAll} />
        }
      >
        {mirror.error && <Notice tone="danger" title="读取镜像仓库失败">{mirror.error}</Notice>}
        {!mirror.status && mirror.loading ? (
          <p className="text-sm text-muted">正在读取镜像仓库…</p>
        ) : mirrorReady ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted">远程</dt>
            <dd className="font-mono text-[13px] break-all">{mirror.status?.remoteUrl ?? "—"}</dd>
            <dt className="text-muted">分支数</dt>
            <dd>{mirror.status?.branches.length}</dd>
            <dt className="text-muted">已导出</dt>
            <dd>{state?.outSeq ? `#${state.outSeq} · ${formatTime(state.lastExportAt)}` : "尚未导出"}</dd>
            <dt className="text-muted">仓库身份</dt>
            <dd>
              <Code>{shortSha(state?.repoId)}</Code>
            </dd>
          </dl>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <TextInput label="GitLab 地址" value={url} onChange={setUrl} mono className="min-w-64 flex-1" />
            <ActionButton variant="primary" onPress={initMirror} isDisabled={!url.trim()}>
              克隆镜像
            </ActionButton>
          </div>
        )}
        {mirror.status?.isRepo && !mirror.status.isMirror && (
          <Notice tone="warning" title="该目录不是 --mirror 克隆，增量导出可能不包含全部分支。" />
        )}
      </StepCard>

      <StepCard
        step={2}
        label="Export"
        title="导出到 U 盘"
        description={state?.outSeq ? `下次导出 #${state.outSeq + 1}，通常为增量；仅引用变化时可能使用全量包` : "首次导出为全量包"}
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <Check checked={fetchFirst} onChange={setFetchFirst}>
            先从 GitLab 拉取最新
          </Check>
          <Check checked={forceFull} onChange={setForceFull}>
            强制全量（外网端丢包或重建时使用）
          </Check>
          <span className="flex-1" />
          <ActionButton variant="primary" onPress={doExport} isDisabled={!mirrorReady}>
            导出 →
          </ActionButton>
        </div>
        {exportRes?.status === "exported" && (
          <Notice
            tone="success"
            title={
              <span className="inline-flex items-center gap-2">
                已生成 <KindChip kind={exportRes.kind} /> #{exportRes.seq}
              </span>
            }
          >
            <span className="font-mono text-xs break-all">{exportRes.payload}</span>
            {exportRes.warnings.map((w) => (
              <span key={w} className="block">
                提示：{w}
              </span>
            ))}
          </Notice>
        )}
        {exportRes?.status === "nothingToSync" && <Notice tone="accent" title={exportRes.message} />}
      </StepCard>

      <StepCard
        step={3}
        label="Import"
        title="导入外网回传"
        description={
          <>
            导入到工作仓库 <Code>{workDir}</Code>
          </>
        }
        actions={
          <>
            <RefreshButton onPress={reloadAll} />
            <ActionButton size="sm" variant="outline" onPress={browseBundle} isDisabled={!workReady}>
              选择其他文件…
            </ActionButton>
          </>
        }
      >
        {work.error ? (
          <Notice tone="danger" title="读取工作仓库失败">{work.error}</Notice>
        ) : (
          !workReady &&
          !work.loading && <Notice tone="warning" title="工作仓库不存在或不是普通仓库，请先在该目录 clone 内网仓库。" />
        )}
        {packageError ? null : backPkgs.length === 0 ? (
          <Empty>传输目录中没有回传包。</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {backPkgs.map((p) => {
              const m = p.manifest;
              const isPatch = m?.kind === "patch";
              const pd = patchDefaults(p);
              const reason = !p.payloadExists ? "包文件缺失"
                : m && state?.repoId && m.repoId !== state.repoId ? "仓库身份不符" : null;
              return (
                <PackageRow
                  key={p.payloadPath}
                  kind={m?.kind ?? null}
                  title={m ? `#${m.seq} · ${m.payload}` : p.payloadPath}
                  meta={
                    <>
                      {m ? formatTime(m.createdAt) : "无 manifest"}
                      {m && " · " + m.refs.map((r) => r.name.replace(/^refs\/heads\//, "")).join(", ")}
                      {reason && <span className="block text-danger">{reason}</span>}
                    </>
                  }
                >
                  {isPatch && (
                    <>
                      <Input
                        aria-label="应用到的新分支名"
                        className="w-52 font-mono text-[13px]"
                        value={pd.name}
                        onChange={(e) => setPatchBranch((x) => ({ ...x, [p.payloadPath]: e.target.value }))}
                      />
                      <BaseSelect
                        label="基于"
                        hideLabel
                        className="w-44"
                        value={pd.base}
                        options={candidates}
                        mainline={base}
                        onChange={(v) => setPatchBase((x) => ({ ...x, [p.payloadPath]: v }))}
                      />
                    </>
                  )}
                  <ActionButton
                    size="sm"
                    variant="secondary"
                    onPress={() => (isPatch ? importPatch(p) : importBundle(p.payloadPath))}
                    isDisabled={!workReady || !!reason}
                  >
                    导入
                  </ActionButton>
                </PackageRow>
              );
            })}
          </div>
        )}
        {backPkgs.some((p) => p.manifest?.kind === "patch") && (
          <>
            <Check checked={patchWorktree} onChange={setPatchWorktree}>
              应用到独立 worktree（不切换工作仓库当前的分支）
            </Check>
            {patchWorktree && (
              <div className="flex flex-wrap items-end gap-3">
                <TextInput
                  label="worktree 目录"
                  value={patchWtPath}
                  onChange={setPatchWtPath}
                  mono
                  className="max-w-lg min-w-64 flex-1"
                />
                <ActionButton size="sm" variant="outline" onPress={browsePatchWorktree}>
                  浏览…
                </ActionButton>
              </div>
            )}
          </>
        )}
        {importRes && (
          <div className="flex flex-col gap-3">
            {importRes.warnings.map((w) => (
              <Notice key={w} tone="warning" title={w} />
            ))}
            {importRes.branches.map((b) => (
              <div key={b.local} className="space-y-2">
                <h4 className="text-sm font-semibold">
                  {b.local}
                  <span className="font-normal text-muted">
                    {" "}
                    · 基于 origin/{b.base} · {b.commits.length} 个新提交
                  </span>
                </h4>
                <CommitList commits={b.commits} />
              </div>
            ))}
          </div>
        )}
        {patchOutcome && <OutcomeView outcome={patchOutcome} />}
        {(importRes || patchOutcome) && <WorkflowJump step={4}>检查分支并推送</WorkflowJump>}
      </StepCard>

      <StepCard
        step={4}
        label="Push"
        title="Rebase 并推送"
        description="基于各分支自己的基准（主线或发布分支）整理，确认提交后推送到 GitLab"
        actions={<RefreshButton onPress={reloadAll} />}
      >
        <InProgressBanners
          status={work.status}
          onDone={(o) => {
            if (o) setOpRes(o);
            reloadAll();
          }}
        />
        <DirtyTreesNotice status={work.status} suffix="rebase 前请先提交或 stash。" />
        <div className="rebase-layout">
          <div className="branch-table-compact">
            <BranchTable
              branches={(work.status?.branches ?? []).filter((b) => !candidates.includes(b.name))}
              emptyText="还没有开发分支（主线和发布分支不在这里列出）"
              selected={selected}
              onSelect={setSelected}
              onRebase={rebaseRow}
              repoPath={workDir}
              onDeleted={reloadAll}
            />
            <DetachedWorktreesNotice status={work.status} />
          </div>
          <div className="rebase-details">
            {!branch && <Empty>选择一个开发分支，检查相对基准的提交后再整理和推送。</Empty>}
            {branch && (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <BaseSelect label="基准分支" value={onto} options={candidates} mainline={base} onChange={setOntoPicked} />
                  {branchInfo?.baseInferred && !changingBase && (
                    <span className="pb-2 text-xs text-muted">没有记录，按分支名推断；rebase 后会记录下来</span>
                  )}
                </div>
                {changingBase && (
                  <Notice
                    tone="accent"
                    title={`将把 ${branch} 从 origin/${branchInfo?.base} 移到 origin/${onto}：rebase --onto，只搬运分支自己的提交`}
                  />
                )}
                {branchWarning && <Notice tone="warning" title={branchWarning} />}
                <h4 className="text-sm font-semibold">
                  {changingBase ? `将搬运到 origin/${onto} 的提交（相对 origin/${listFrom}）` : `${branch} 相对 origin/${onto} 的提交`}
                  {branchInfo && !changingBase && branchInfo.behind > 0 && (
                    <span className="font-normal text-warning"> · 落后 {branchInfo.behind} 个，建议先 rebase</span>
                  )}
                </h4>
                {currentCommits?.error ? (
                  <Notice tone="danger" title="读取提交列表失败，请刷新后重试">{currentCommits.error}</Notice>
                ) : !currentCommits ? (
                  <p role="status" className="text-sm text-muted">正在读取提交列表…</p>
                ) : (
                  <CommitList commits={commits} empty={`没有相对 origin/${listFrom} 的新提交`} />
                )}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <Check checked={fetchBeforeRebase} onChange={setFetchBeforeRebase}>
                    rebase 前 fetch origin
                  </Check>
                  <Check checked={forceLease} onChange={setForceLease}>
                    force-with-lease（已推送过又 rebase 时）
                  </Check>
                  <span className="flex-1" />
                  <ActionButton variant="outline" onPress={rebase} isDisabled={!workReady}>
                    Rebase 到 origin/{onto}
                  </ActionButton>
                  <ActionButton
                    variant={forceLease ? "danger" : "primary"}
                    onPress={push}
                    isDisabled={!workReady || !branchInfo || !commitsReady || !!work.status?.inProgress || !!work.status?.inProgressTrees.length || changingBase}
                  >
                    推送…
                  </ActionButton>
                </div>
              </>
            )}
            {opRes && <OutcomeView outcome={opRes} />}
          </div>
        </div>
      </StepCard>
    </Workflow>
  );
}

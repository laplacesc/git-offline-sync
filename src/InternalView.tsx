import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Input } from "@heroui/react";
import {
  api,
  CommitInfo,
  ExportOutcome,
  formatTime,
  ImportBackResult,
  InternalState,
  OpOutcome,
  PackageInfo,
  Profile,
  shortSha,
} from "./api";
import { useRunner } from "./runner";
import { BranchTable, InProgressBanner, useRepoStatus } from "./repoBits";
import {
  ActionButton,
  Check,
  Code,
  CommitList,
  Empty,
  KindChip,
  Notice,
  OutcomeView,
  PackageRow,
  StepCard,
  TextInput,
} from "./ui";

export function InternalView({ profile }: { profile: Profile }) {
  const { run, notify, confirm } = useRunner();
  const base = profile.baseBranch;
  const mirrorDir = profile.mirrorDir ?? "";
  const workDir = profile.workDir ?? "";

  const mirror = useRepoStatus(mirrorDir, base);
  const work = useRepoStatus(workDir, base);
  const [state, setState] = useState<InternalState | null>(null);
  const [packages, setPackages] = useState<PackageInfo[]>([]);

  const reloadAll = useCallback(async () => {
    await Promise.all([mirror.reload(), work.reload()]);
    setState(await api.internalState(mirrorDir).catch(() => null));
    setPackages(await api.listPackages(profile.transferDir).catch(() => []));
  }, [mirror.reload, work.reload, mirrorDir, profile.transferDir]);

  useEffect(() => {
    reloadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);

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

  const importBundle = async (path: string) => {
    setPatchOutcome(null);
    const r = await run("导入回传包", () => api.importBack(workDir, path, base));
    if (r) {
      setImportRes(r);
      const first = r.branches[0]?.local;
      if (first) setSelected([first]);
    }
    reloadAll();
  };

  const importPatch = async (pkg: PackageInfo) => {
    setImportRes(null);
    const def = pkg.manifest?.refs[0]?.name.replace(/^refs\/heads\//, "") ?? "";
    const branch = (patchBranch[pkg.payloadPath] ?? def).trim();
    if (!branch) return notify("warn", "请填写导入到的分支名");
    const r = await run("应用补丁", () =>
      api.importPatches({ workDir, patchDir: pkg.payloadPath, branch, baseBranch: base, fetchUpstream: true }),
    );
    if (r) {
      setPatchOutcome(r);
      setSelected([branch]);
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
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [fetchBeforeRebase, setFetchBeforeRebase] = useState(true);
  const [forceLease, setForceLease] = useState(false);
  const [opRes, setOpRes] = useState<OpOutcome | null>(null);

  useEffect(() => setOpRes(null), [branch]);

  useEffect(() => {
    if (!branch || !work.status?.isRepo) return setCommits([]);
    api
      .listCommits(workDir, `origin/${base}`, `refs/heads/${branch}`)
      .then(setCommits)
      .catch(() => setCommits([]));
  }, [branch, work.status, workDir, base]);

  const rebase = async () => {
    const r = await run("Rebase", () => api.rebaseOnto(workDir, branch, base, fetchBeforeRebase));
    if (r) setOpRes(r);
    reloadAll();
  };

  const push = async () => {
    const ok = await confirm({
      title: `推送 ${branch}`,
      tone: forceLease ? "warning" : "accent",
      confirmLabel: "推送",
      body: (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            推送到 <Code>origin</Code>
            {forceLease && "（force-with-lease）"}，共 {commits.length} 个相对 origin/{base} 的提交：
          </p>
          <CommitList commits={commits.slice(0, 20)} empty={`没有相对 origin/${base} 的新提交`} />
          {commits.length > 20 && <p className="text-xs text-muted">…另有 {commits.length - 20} 个</p>}
        </div>
      ),
    });
    if (!ok) return;
    const r = await run("推送", () => api.pushBranch(workDir, branch, forceLease));
    if (r) setOpRes(r);
    reloadAll();
  };

  const mirrorReady = !!mirror.status?.isRepo;
  const workReady = !!work.status?.isRepo && !work.status.isBare;
  const branchInfo = work.status?.branches.find((b) => b.name === branch);

  return (
    <div className="stagger flex flex-col gap-5">
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
          <ActionButton size="sm" variant="ghost" onPress={reloadAll}>
            刷新
          </ActionButton>
        }
      >
        {mirrorReady ? (
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
        description={state?.outSeq ? `将生成 #${state.outSeq + 1} 增量包，只含上次导出后的新提交` : "首次导出为全量包"}
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
                ⚠ {w}
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
          <ActionButton size="sm" variant="outline" onPress={browseBundle} isDisabled={!workReady}>
            选择其他文件…
          </ActionButton>
        }
      >
        {!workReady && <Notice tone="warning" title="工作仓库不存在或不是普通仓库，请先在该目录 clone 内网仓库。" />}
        {backPkgs.length === 0 ? (
          <Empty>传输目录中没有回传包。</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {backPkgs.map((p) => {
              const m = p.manifest;
              const isPatch = m?.kind === "patch";
              const def = m?.refs[0]?.name.replace(/^refs\/heads\//, "") ?? "";
              return (
                <PackageRow
                  key={p.payloadPath}
                  kind={m?.kind ?? null}
                  title={m ? `#${m.seq} · ${m.payload}` : p.payloadPath}
                  meta={
                    <>
                      {m ? formatTime(m.createdAt) : "无 manifest"}
                      {m && " · " + m.refs.map((r) => r.name.replace(/^refs\/heads\//, "")).join(", ")}
                    </>
                  }
                >
                  {isPatch && (
                    <Input
                      aria-label="应用到的新分支名"
                      className="w-52 font-mono text-[13px]"
                      value={patchBranch[p.payloadPath] ?? def}
                      onChange={(e) => setPatchBranch((x) => ({ ...x, [p.payloadPath]: e.target.value }))}
                    />
                  )}
                  <ActionButton
                    size="sm"
                    variant="secondary"
                    onPress={() => (isPatch ? importPatch(p) : importBundle(p.payloadPath))}
                    isDisabled={!workReady || !p.payloadExists}
                  >
                    导入
                  </ActionButton>
                </PackageRow>
              );
            })}
          </div>
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
                  <span className="font-normal text-muted"> · {b.commits.length} 个新提交</span>
                </h4>
                <CommitList commits={b.commits} />
              </div>
            ))}
          </div>
        )}
        {patchOutcome && <OutcomeView outcome={patchOutcome} />}
      </StepCard>

      <StepCard
        step={4}
        label="Push"
        title="Rebase 并推送"
        description={`基于最新 origin/${base} 整理分支，确认提交后推送到 GitLab`}
      >
        <InProgressBanner
          repo={workDir}
          status={work.status}
          onDone={(o) => {
            if (o) setOpRes(o);
            reloadAll();
          }}
        />
        {work.status?.dirty && <Notice tone="warning" title="工作区有未提交的修改，rebase 前请先提交或 stash。" />}
        <BranchTable
          branches={(work.status?.branches ?? []).filter((b) => b.name !== base)}
          baseLabel={`origin/${base}`}
          selected={selected}
          onSelect={setSelected}
        />
        {branch && (
          <>
            <h4 className="text-sm font-semibold">
              {branch} 相对 origin/{base} 的提交
              {branchInfo && branchInfo.behind > 0 && (
                <span className="font-normal text-warning"> · 落后 {branchInfo.behind} 个，建议先 rebase</span>
              )}
            </h4>
            <CommitList commits={commits} empty={`没有相对 origin/${base} 的新提交`} />
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Check checked={fetchBeforeRebase} onChange={setFetchBeforeRebase}>
                rebase 前 fetch origin
              </Check>
              <Check checked={forceLease} onChange={setForceLease}>
                force-with-lease（已推送过又 rebase 时）
              </Check>
              <span className="flex-1" />
              <ActionButton variant="outline" onPress={rebase} isDisabled={!workReady}>
                Rebase 到 origin/{base}
              </ActionButton>
              <ActionButton variant="primary" onPress={push} isDisabled={!workReady || !!work.status?.inProgress}>
                推送…
              </ActionButton>
            </div>
          </>
        )}
        {opRes && <OutcomeView outcome={opRes} />}
      </StepCard>
    </div>
  );
}

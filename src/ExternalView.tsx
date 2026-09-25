import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertDialog, Table, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import type { Key } from "@heroui/react";
import {
  api,
  baseCandidates,
  defaultBaseFor,
  ExportOutcome,
  formatTime,
  ImportInResult,
  MirrorState,
  OpOutcome,
  PackageInfo,
  prefixWarning,
  Profile,
  releasesOf,
  shortSha,
} from "./api";
import { useRunner } from "./runner";
import { BranchTable, DetachedWorktreesNotice, DirtyTreesNotice, InProgressBanners, useRefreshOnFocus, useRepoStatus } from "./repoBits";
import {
  ActionButton,
  BaseSelect,
  Check,
  Code,
  Empty,
  KindChip,
  Notice,
  OutcomeView,
  PackageRow,
  RefreshButton,
  StepCard,
  WorkflowNav,
  TextInput,
} from "./ui";

/** 开发仓库列表里的一行：尚未克隆的给「从镜像克隆」，已克隆的给「切换 / 同步」。 */
function DevRepoRow({
  path,
  current,
  cloned,
  stale,
  onSelect,
  onSync,
  onClone,
}: {
  path: string;
  current: boolean;
  cloned: boolean;
  stale: boolean;
  onSelect: () => void;
  onSync: () => void;
  onClone: () => void;
}) {
  return (
    <div
      className={
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-3 transition-shadow " +
        (current && cloned ? "selected-surface" : "border border-border bg-surface")
      }
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[13px]" title={path}>
          {path}
        </div>
        <div className="text-xs text-muted">
          {cloned ? (current ? "当前操作的仓库" : "已克隆") : "尚未克隆"}
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {cloned ? (
          <>
            {!current && (
              <ActionButton size="sm" variant="secondary" onPress={onSelect}>
                切换
              </ActionButton>
            )}
            <ActionButton size="sm" variant={stale ? "primary" : "outline"} onPress={onSync}>
              同步
            </ActionButton>
          </>
        ) : (
          <ActionButton size="sm" variant="primary" onPress={onClone}>
            从镜像克隆
          </ActionButton>
        )}
      </div>
    </div>
  );
}

export function ExternalView({ profile }: { profile: Profile }) {
  const { run, notify, busy } = useRunner();
  const base = profile.baseBranch;
  const releases = releasesOf(profile);
  const mirrorDir = profile.mirrorDir ?? "";
  const devRepos = profile.devRepos ?? [];

  // 当前操作的开发仓库。多个开发仓库共享同一个镜像，只是各自的工作副本。
  const [devIdx, setDevIdx] = useState(0);
  const devDir = devRepos[devIdx] ?? "";

  const mirror = useRepoStatus(mirrorDir, base, releases);
  const repo = useRepoStatus(devDir, base, releases);
  const [state, setState] = useState<MirrorState | null>(null);
  const [packages, setPackages] = useState<PackageInfo[]>([]);
  const [packageError, setPackageError] = useState<string | null>(null);
  const [devExists, setDevExists] = useState<Record<string, boolean>>({});

  const reloadAll = useCallback(async () => {
    // 镜像状态由 mirror.reload() 一次读出，别再单独查一遍：
    // 大仓库（上千分支）的 repo_status 很贵。
    const [, , nextState, nextPackages, devFlags] = await Promise.all([
      mirror.reload(),
      repo.reload(),
      mirrorDir ? api.mirrorState(mirrorDir).catch(() => null) : null,
      api.listPackages(profile.transferDir).then((items) => { setPackageError(null); return items; }).catch((error) => { setPackageError(String(error)); return []; }),
      Promise.all(
        devRepos.map(async (dir) => {
          const isRepo = await api
            .repoStatus(dir, base, releases)
            .then((s) => s.isRepo)
            .catch(() => false);
          return [dir, isRepo] as const;
        }),
      ),
    ]);
    setState(nextState);
    setPackages(nextPackages);
    setDevExists(Object.fromEntries(devFlags));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mirror.reload, repo.reload, mirrorDir, devRepos.join("\n"), base, releases.join("\n"), profile.transferDir]);

  useEffect(() => {
    reloadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);
  useRefreshOnFocus(reloadAll);

  // 镜像必须是本工具建的裸仓库
  const mirrorReady = !!mirror.status?.isRepo && !!mirror.status?.isBare;
  const devReady = !!repo.status?.isRepo;
  // 1.0.x 升级上来的配置没有这两个目录，先让用户去填，别让它报 create_dir_all("") 那种错
  const needsSetup = mirrorDir.trim() === "";

  // ---------- 1. 导入内网包到镜像 ----------
  const inPkgs = packages
    .filter((p) => !p.manifest || p.manifest.kind === "full" || p.manifest.kind === "incr")
    .sort((a, b) => (b.manifest?.seq ?? 0) - (a.manifest?.seq ?? 0));
  const lastIn = state?.lastInSeq ?? 0;
  const [allowGap, setAllowGap] = useState(false);
  const [importRes, setImportRes] = useState<ImportInResult | null>(null);
  // 导入只更新镜像，开发仓库要再 fetch 一次才看得到
  const [staleDevs, setStaleDevs] = useState(false);

  const importIn = async (path: string) => {
    const r = await run(mirrorReady ? "导入增量包" : "建立外网镜像", () =>
      api.importIn(path, mirrorDir, allowGap),
    );
    if (r) {
      setImportRes(r);
      setStaleDevs(true);
      notify("ok", r.created ? "已建立外网镜像" : `已导入 #${r.seq ?? "?"}`);
    }
    reloadAll();
  };

  const browse = async () => {
    const p = await open({ multiple: false, filters: [{ name: "Git bundle", extensions: ["bundle"] }] });
    if (typeof p === "string") importIn(p);
  };

  // ---------- 2. 开发仓库 ----------
  const cloneDev = async (dir: string) => {
    const ok = await run("克隆开发仓库", () =>
      api.createDevRepo(mirrorDir, dir, profile.userName ?? "", profile.userEmail ?? ""),
    );
    if (ok !== undefined) notify("ok", `已从镜像克隆到 ${dir}`);
    reloadAll();
  };

  const syncDev = async (dir: string) => {
    const ok = await run("同步开发仓库", () => api.syncDevRepo(dir, mirrorDir));
    if (ok !== undefined) notify("ok", `${dir} 已同步到镜像的最新状态`);
    setStaleDevs(false);
    reloadAll();
  };

  const syncAll = async () => {
    for (const d of devRepos.filter((x) => devExists[x])) {
      const ok = await run("同步开发仓库", () => api.syncDevRepo(d, mirrorDir));
      if (ok === undefined) return;
    }
    notify("ok", "所有开发仓库已同步");
    setStaleDevs(false);
    reloadAll();
  };

  const saveIdentity = async () => {
    const ok = await run("设置提交身份", () =>
      api.configureRepo(devDir, profile.userName ?? "", profile.userEmail ?? ""),
    );
    if (ok !== undefined) notify("ok", "已写入 user.name / user.email / core.autocrlf=input");
  };

  // ---------- 3. 分支与 worktree ----------
  const [newBranch, setNewBranch] = useState("feature/");
  // null：跟随分支名前缀自动选择；用户手动选过后固定
  const [newBasePicked, setNewBasePicked] = useState<string | null>(null);
  const newBase = newBasePicked ?? defaultBaseFor(newBranch.trim(), profile);
  const newBranchWarning = prefixWarning(newBranch.trim(), newBase, profile);
  const [asWorktree, setAsWorktree] = useState(false);
  const [worktreePath, setWorktreePath] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [opRes, setOpRes] = useState<OpOutcome | null>(null);
  const [rebaseTarget, setRebaseTarget] = useState<{ name: string; onto: string } | null>(null);

  useEffect(() => {
    setSelected([]);
    setRebaseTarget(null);
  }, [profile.id, devDir]);

  const createBranch = async () => {
    const name = newBranch.trim();
    const wt = asWorktree ? worktreePath.trim() : undefined;
    if (asWorktree && !wt) return;
    const ok = await run("新建分支", () => api.createBranch(devDir, name, newBase, wt));
    if (ok !== undefined) {
      notify("ok", wt ? `已在 ${wt} 创建 worktree ${name}` : `已基于 origin/${newBase} 创建并切换到 ${name}`);
      setNewBranch("feature/");
      setNewBasePicked(null);
      setWorktreePath("");
    }
    reloadAll();
  };

  const browseWorktree = async () => {
    const p = await open({ directory: true, multiple: false });
    if (typeof p === "string") setWorktreePath(p);
  };

  const rebaseInfo = repo.status?.branches.find((b) => b.name === rebaseTarget?.name);
  const rebaseWarning = rebaseTarget ? prefixWarning(rebaseTarget.name, rebaseTarget.onto, profile) : null;

  useEffect(() => {
    if (rebaseTarget && !rebaseInfo) setRebaseTarget(null);
  }, [rebaseTarget, rebaseInfo]);

  const rebase = async () => {
    if (!rebaseTarget || !rebaseInfo) return;
    const r = await run("Rebase", () => api.rebaseOnto(devDir, rebaseTarget.name, rebaseTarget.onto, false));
    if (r) {
      setOpRes(r);
      setRebaseTarget(null);
    }
    reloadAll();
  };

  // ---------- 4. 回传 ----------
  const [mode, setMode] = useState<"bundle" | "patch">("bundle");
  const [exportRes, setExportRes] = useState<ExportOutcome | null>(null);
  const candidates = baseCandidates(profile);
  const branches = (repo.status?.branches ?? []).filter((b) => !candidates.includes(b.name));

  const onModeChange = (keys: Set<Key>) => {
    const m = [...keys][0] as "bundle" | "patch" | undefined;
    if (!m) return;
    setMode(m);
    if (m === "patch") setSelected((s) => s.slice(0, 1));
  };

  const doExport = async () => {
    const common = {
      repo: devDir,
      mirrorDir,
      transferDir: profile.transferDir,
      repoName: profile.repoName,
      baseBranch: base,
      releaseBranches: releases,
    };
    const r =
      mode === "bundle"
        ? await run("导出回传包", () => api.exportBack({ ...common, branches: selected }))
        : await run("导出补丁", () => api.exportPatches({ ...common, branch: selected[0] }));
    if (r) setExportRes(r);
    reloadAll();
  };

  const branchNameOk = newBranch.trim() !== "" && !newBranch.trim().endsWith("/");
  const canCreate = branchNameOk && (!asWorktree || worktreePath.trim() !== "");

  return (
    <div className="workflow-layout">
      <WorkflowNav steps={["导入内网包", "开发仓库", "开发分支", "回传到内网"]} />
      {packageError && <Notice tone="danger" title="无法读取传输目录，请检查路径或 U 盘连接后刷新">{packageError}</Notice>}
      <AlertDialog.Backdrop
        isOpen={!!rebaseTarget}
        onOpenChange={(open) => { if (!open && !busy) setRebaseTarget(null); }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-md">
            <AlertDialog.Header>
              <AlertDialog.Heading>Rebase 分支</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="space-y-4">
              <p>分支：<Code>{rebaseTarget?.name}</Code></p>
              <BaseSelect
                label="Rebase 到"
                value={rebaseTarget?.onto ?? base}
                options={candidates}
                mainline={base}
                onChange={(onto) => setRebaseTarget((target) => target ? { ...target, onto } : null)}
              />
              {rebaseWarning && <Notice tone="warning" title={rebaseWarning} />}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <ActionButton variant="tertiary" onPress={() => setRebaseTarget(null)}>取消</ActionButton>
              <ActionButton variant="primary" onPress={rebase} isDisabled={!rebaseInfo}>
                Rebase 到 origin/{rebaseTarget?.onto}
              </ActionButton>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
      <StepCard
        step={1}
        label="Import"
        title="导入内网包到镜像"
        description={
          needsSetup ? (
            <>还没有设置外网镜像目录</>
          ) : mirrorReady ? (
            <>
              已导入到 #{lastIn}
              {state?.lastImportAt ? `（${formatTime(state.lastImportAt)}）` : ""}，下一个应为 #{lastIn + 1}
            </>
          ) : (
            <>
              首次导入：用全量包在 <Code>{mirrorDir}</Code> 建立外网镜像（裸仓库）
            </>
          )
        }
        actions={
          <>
            <RefreshButton onPress={reloadAll} />
            <ActionButton size="sm" variant="outline" onPress={browse}>
              选择其他文件…
            </ActionButton>
          </>
        }
      >
        {needsSetup && (
          <Notice tone="accent" title="先在「编辑配置」里填写外网镜像目录和开发仓库目录">
            1.0.x 的外网仓库不再兼容：包要先导入到<b>外网镜像</b>（一个空目录，会建成裸仓库），
            再从镜像克隆<b>开发仓库</b>。两个目录要分开填。旧的开发仓库目录可以删掉，
            如果里面还有没回传的提交，先用旧版本导出回传包。
          </Notice>
        )}
        {mirror.error && !needsSetup && <Notice tone="danger" title="读取外网镜像失败">{mirror.error}</Notice>}
        {mirror.status?.isRepo && !mirror.status.isBare && (
          <Notice tone="danger" title="这个目录不是裸仓库">
            外网镜像必须是本工具建立的裸仓库。如果这里是旧版本的开发仓库，请把它删掉后重新导入全量包。
          </Notice>
        )}
        {packageError ? null : inPkgs.length === 0 ? (
          <Empty>
            传输目录 <Code>{profile.transferDir}</Code> 中没有内网包。
          </Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {inPkgs.map((p) => {
              const m = p.manifest;
              const done = !!m && mirrorReady && m.seq <= lastIn;
              const next = mirrorReady ? !!m && m.seq === lastIn + 1 : m?.kind === "full";
              // 已导入的全量包仍可再次导入（重新同步）；已导入的增量包不可
              const usable = mirrorReady ? !(done && m?.kind === "incr") : !m || m.kind === "full";
              return (
                <PackageRow
                  key={p.payloadPath}
                  kind={m?.kind ?? null}
                  title={m ? `#${m.seq} · ${m.payload}` : p.payloadPath}
                  highlight={next && !done}
                  dim={done}
                  meta={
                    <>
                      {m ? formatTime(m.createdAt) : "无 manifest"}
                      {m && ` · ${m.refs.filter((r) => r.name.startsWith("refs/heads/")).length} 个分支`}
                      {done && " · 已导入"}
                      {next && !done && " · 下一个"}
                    </>
                  }
                >
                  <ActionButton
                    size="sm"
                    variant={next && !done ? "primary" : "secondary"}
                    onPress={() => importIn(p.payloadPath)}
                    isDisabled={needsSetup || !usable || !p.payloadExists}
                  >
                    导入
                  </ActionButton>
                </PackageRow>
              );
            })}
          </div>
        )}
        <Check checked={allowGap} onChange={setAllowGap}>
          允许跳号导入（确认中间的包不需要时）
        </Check>
        {importRes && (
          <div className="flex flex-col gap-3">
            <Notice
              tone="success"
              title={`${importRes.created ? "已建立外网镜像" : `已导入 #${importRes.seq ?? "?"}`}，${importRes.changes.length} 个引用变化`}
            />
            {importRes.changes.length > 0 && (
              <Table variant="secondary">
                <Table.ScrollContainer className="max-h-56">
                  <Table.Content aria-label="引用变化">
                    <Table.Header>
                      <Table.Column isRowHeader>引用</Table.Column>
                      <Table.Column>变化</Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {importRes.changes.slice(0, 100).map((c) => (
                        <Table.Row key={c.name} id={c.name}>
                          <Table.Cell className="font-mono text-[13px]">
                            {c.name.replace(/^refs\/heads\//, "")}
                          </Table.Cell>
                          <Table.Cell className="font-mono text-xs">
                            {shortSha(c.old)} → {c.new ? shortSha(c.new) : <span className="text-danger">已删除</span>}
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            )}
          </div>
        )}
      </StepCard>

      <StepCard
        step={2}
        label="Sync"
        title="开发仓库"
        description="开发仓库从镜像克隆，origin 指向本地镜像目录，可以随时 fetch、开 worktree"
        actions={
          <>
            {devRepos.filter((d) => devExists[d]).length > 1 && (
              <ActionButton size="sm" variant="secondary" onPress={syncAll}>
                全部同步
              </ActionButton>
            )}
            <RefreshButton onPress={reloadAll} />
          </>
        }
      >
        {!mirrorReady ? (
          <Empty>先导入全量包建立镜像。</Empty>
        ) : devRepos.length === 0 ? (
          <Empty>还没有配置开发仓库目录，去配置里添加。</Empty>
        ) : (
          <>
            {staleDevs && (
              <Notice
                tone="warning"
                title="镜像已更新，开发仓库还没跟上"
              >
                导入只更新镜像。点下面的「同步」在开发仓库里执行 <Code>git fetch origin --prune</Code>。
              </Notice>
            )}
            <div className="flex flex-col gap-2">
              {devRepos.map((d, i) => (
                <DevRepoRow
                  key={d}
                  path={d}
                  current={i === devIdx}
                  cloned={!!devExists[d]}
                  stale={staleDevs}
                  onSelect={() => setDevIdx(i)}
                  onSync={() => syncDev(d)}
                  onClone={() => cloneDev(d)}
                />
              ))}
            </div>
            {repo.error && <Notice tone="danger" title="读取开发仓库失败">{repo.error}</Notice>}
          </>
        )}
      </StepCard>

      <StepCard
        step={3}
        label="Develop"
        title="开发分支"
        description="在特性分支上用 AI 开发并提交，不要直接改基准分支。多个分支并行时给每个分支开一个 worktree"
        actions={
          <>
            {devReady && (profile.userName || profile.userEmail) && (
              <ActionButton size="sm" variant="ghost" onPress={saveIdentity}>
                写入提交身份
              </ActionButton>
            )}
            <RefreshButton onPress={reloadAll} />
          </>
        }
      >
        {repo.loading && !repo.status ? (
          <p role="status" className="py-6 text-sm text-muted">正在读取开发仓库和分支…</p>
        ) : !devReady ? (
          <Empty>先克隆开发仓库。</Empty>
        ) : (
          <>
            {/* 每个卡住的工作树一条横幅，含 linked worktree：
                重启应用后也能找到它们，不依赖上一次操作的返回值 */}
            <InProgressBanners
              status={repo.status}
              onDone={(o) => {
                if (o) setOpRes(o);
                reloadAll();
              }}
            />
            <div className="flex flex-wrap items-end gap-3">
              <TextInput
                label="新分支"
                value={newBranch}
                onChange={setNewBranch}
                mono
                className="max-w-sm min-w-56 flex-1"
              />
              <BaseSelect
                label="基于"
                value={newBase}
                options={candidates}
                mainline={base}
                onChange={setNewBasePicked}
              />
              <ActionButton variant="secondary" onPress={createBranch} isDisabled={!canCreate}>
                {asWorktree ? "新建 worktree" : "新建并切换"}
              </ActionButton>
            </div>
            <Check checked={asWorktree} onChange={setAsWorktree}>
              创建为独立 worktree（分支有自己的目录，可以和其他分支同时开着）
            </Check>
            {asWorktree && (
              <div className="flex flex-wrap items-end gap-3">
                <TextInput
                  label="worktree 目录"
                  value={worktreePath}
                  onChange={setWorktreePath}
                  mono
                  className="max-w-lg min-w-64 flex-1"
                />
                <ActionButton size="sm" variant="outline" onPress={browseWorktree}>
                  浏览…
                </ActionButton>
              </div>
            )}
            <p className="-mt-2 text-xs text-muted">feature/、bugfix/ 基于主线；hotfix/ 基于发布分支</p>
            {newBranchWarning && <Notice tone="warning" title={`新分支：${newBranchWarning}`} />}
            <BranchTable
              branches={branches}
              emptyText="还没有开发分支（主线和发布分支不在这里列出）"
              selected={selected}
              onSelect={setSelected}
              multi={mode === "bundle"}
              onRebase={(b) => setRebaseTarget({ name: b.name, onto: b.base })}
            />
            <DetachedWorktreesNotice status={repo.status} />
            <DirtyTreesNotice status={repo.status} suffix="回传只包含已提交的内容。" />
            {opRes && <OutcomeView outcome={opRes} />}
          </>
        )}
      </StepCard>

      <StepCard step={4} label="Return" title="回传到内网" description="只打包内网还没有的提交（--not --remotes=origin）">
        <div className="flex flex-wrap items-center gap-3">
          <ToggleButtonGroup
            aria-label="回传方式"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set<Key>([mode])}
            onSelectionChange={onModeChange}
          >
            <ToggleButton id="bundle">Bundle · 保留提交哈希</ToggleButton>
            <ToggleButton id="patch">
              <ToggleButtonGroup.Separator />
              Patch · 逐个审阅
            </ToggleButton>
          </ToggleButtonGroup>
          <span className="flex-1" />
          <span role="status" className="min-w-0 break-all text-sm text-muted">
            {selected.length ? `已选：${selected.join("、")}` : "在上方表格中选择分支"}
          </span>
          <ActionButton
            variant="primary"
            onPress={doExport}
            isDisabled={!devReady || selected.length === 0 || (mode === "patch" && selected.length !== 1)}
          >
            导出到 U 盘 →
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
    </div>
  );
}

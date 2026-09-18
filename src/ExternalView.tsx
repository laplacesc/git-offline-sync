import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Table, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import type { Key } from "@heroui/react";
import {
  api,
  baseCandidates,
  defaultBaseFor,
  ExportOutcome,
  ExternalState,
  formatTime,
  ImportInResult,
  OpOutcome,
  PackageInfo,
  prefixWarning,
  Profile,
  releasesOf,
  shortSha,
} from "./api";
import { useRunner } from "./runner";
import { BranchTable, InProgressBanner, useRepoStatus } from "./repoBits";
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
  StepCard,
  TextInput,
} from "./ui";

export function ExternalView({ profile }: { profile: Profile }) {
  const { run, notify } = useRunner();
  const base = profile.baseBranch;
  const releases = releasesOf(profile);
  const repoDir = profile.repoDir ?? "";

  const repo = useRepoStatus(repoDir, base, releases);
  const [state, setState] = useState<ExternalState | null>(null);
  const [packages, setPackages] = useState<PackageInfo[]>([]);

  const reloadAll = useCallback(async () => {
    const st = await api.repoStatus(repoDir, base, releases).catch(() => null);
    await repo.reload();
    setState(st?.isRepo ? await api.externalState(repoDir).catch(() => null) : null);
    setPackages(await api.listPackages(profile.transferDir).catch(() => []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.reload, repoDir, base, releases.join("\n"), profile.transferDir]);

  useEffect(() => {
    reloadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);

  const exists = !!repo.status?.isRepo;

  // ---------- 1. 导入内网包 ----------
  const inPkgs = packages
    .filter((p) => !p.manifest || p.manifest.kind === "full" || p.manifest.kind === "incr")
    .sort((a, b) => (b.manifest?.seq ?? 0) - (a.manifest?.seq ?? 0));
  const lastIn = state?.lastInSeq ?? 0;
  const [allowGap, setAllowGap] = useState(false);
  const [importRes, setImportRes] = useState<ImportInResult | null>(null);

  const importIn = async (path: string) => {
    const r = await run(exists ? "导入增量包" : "克隆全量包", () => api.importIn(path, repoDir, allowGap));
    if (r) {
      setImportRes(r);
      if (r.cloned && (profile.userName || profile.userEmail)) {
        await run("设置提交身份", () =>
          api.configureRepo(repoDir, profile.userName ?? "", profile.userEmail ?? ""),
        );
      }
      notify("ok", r.cloned ? "已克隆到开发目录" : `已导入 #${r.seq ?? "?"}`);
    }
    reloadAll();
  };

  const browse = async () => {
    const p = await open({ multiple: false, filters: [{ name: "Git bundle", extensions: ["bundle"] }] });
    if (typeof p === "string") importIn(p);
  };

  // ---------- 2. 分支 ----------
  const [newBranch, setNewBranch] = useState("feature/");
  // null：跟随分支名前缀自动选择；用户手动选过后固定
  const [newBasePicked, setNewBasePicked] = useState<string | null>(null);
  const newBase = newBasePicked ?? defaultBaseFor(newBranch.trim(), profile);
  const newBranchWarning = prefixWarning(newBranch.trim(), newBase, profile);
  const [selected, setSelected] = useState<string[]>([]);
  const [opRes, setOpRes] = useState<OpOutcome | null>(null);

  const createBranch = async () => {
    const name = newBranch.trim();
    const ok = await run("新建分支", () => api.createBranch(repoDir, name, newBase));
    if (ok !== undefined) {
      notify("ok", `已基于 origin/${newBase} 创建并切换到 ${name}`);
      setNewBranch("feature/");
      setNewBasePicked(null);
    }
    reloadAll();
  };

  const selectedInfo = selected.length === 1 ? repo.status?.branches.find((b) => b.name === selected[0]) : undefined;
  const selectedWarning = selectedInfo ? prefixWarning(selectedInfo.name, selectedInfo.base, profile) : null;

  const rebase = async () => {
    if (!selectedInfo) return;
    const { name, base: onto } = selectedInfo;
    const r = await run("Rebase", () => api.rebaseOnto(repoDir, name, onto, false));
    if (r) setOpRes(r);
    reloadAll();
  };

  const saveIdentity = async () => {
    const ok = await run("设置提交身份", () =>
      api.configureRepo(repoDir, profile.userName ?? "", profile.userEmail ?? ""),
    );
    if (ok !== undefined) notify("ok", "已写入 user.name / user.email / core.autocrlf=input");
  };

  // ---------- 3. 回传 ----------
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
      repo: repoDir,
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

  return (
    <div className="stagger flex flex-col gap-5">
      <StepCard
        step={1}
        label="Import"
        title="导入内网包"
        description={
          exists ? (
            <>
              已导入到 #{lastIn}
              {state?.lastImportAt ? `（${formatTime(state.lastImportAt)}）` : ""}，下一个应为 #{lastIn + 1}
            </>
          ) : (
            <>
              首次导入：用全量包克隆到 <Code>{repoDir}</Code>
            </>
          )
        }
        actions={
          <>
            <ActionButton size="sm" variant="ghost" onPress={reloadAll}>
              刷新
            </ActionButton>
            <ActionButton size="sm" variant="outline" onPress={browse}>
              选择其他文件…
            </ActionButton>
          </>
        }
      >
        {inPkgs.length === 0 ? (
          <Empty>
            传输目录 <Code>{profile.transferDir}</Code> 中没有内网包。
          </Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {inPkgs.map((p) => {
              const m = p.manifest;
              const done = !!m && exists && m.seq <= lastIn;
              const next = exists ? !!m && m.seq === lastIn + 1 : m?.kind === "full";
              // 已导入的全量包仍可再次导入（重新同步）；已导入的增量包不可
              const usable = exists ? !(done && m?.kind === "incr") : !m || m.kind === "full";
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
                    isDisabled={!usable || !p.payloadExists}
                  >
                    {exists ? "导入" : "克隆"}
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
              title={`${importRes.cloned ? "已克隆" : `已导入 #${importRes.seq ?? "?"}`}，${importRes.changes.length} 个引用变化`}
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
                            {c.name.replace(/^refs\/remotes\//, "")}
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
        label="Develop"
        title="开发分支"
        description="在特性分支上用 AI 开发并提交，不要直接改基准分支"
        actions={
          exists && (profile.userName || profile.userEmail) ? (
            <ActionButton size="sm" variant="ghost" onPress={saveIdentity}>
              写入提交身份
            </ActionButton>
          ) : undefined
        }
      >
        {!exists ? (
          <Empty>先导入全量包。</Empty>
        ) : (
          <>
            <InProgressBanner
              repo={repoDir}
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
              <ActionButton variant="secondary" onPress={createBranch} isDisabled={!branchNameOk}>
                新建并切换
              </ActionButton>
              <span className="flex-1" />
              <ActionButton variant="outline" onPress={rebase} isDisabled={!selectedInfo}>
                {selectedInfo ? `Rebase ${selectedInfo.name} 到 origin/${selectedInfo.base}` : "Rebase 所选分支"}
              </ActionButton>
            </div>
            <p className="-mt-2 text-xs text-muted">feature/、bugfix/ 基于主线；hotfix/ 基于发布分支</p>
            {newBranchWarning && <Notice tone="warning" title={`新分支：${newBranchWarning}`} />}
            {selectedWarning && <Notice tone="warning" title={`${selectedInfo?.name}：${selectedWarning}`} />}
            <BranchTable
              branches={branches}
              emptyText="还没有开发分支（主线和发布分支不在这里列出）"
              selected={selected}
              onSelect={setSelected}
              multi={mode === "bundle"}
            />
            {repo.status?.dirty && <Notice tone="warning" title="工作区有未提交的修改，回传只包含已提交的内容。" />}
            {opRes && <OutcomeView outcome={opRes} />}
          </>
        )}
      </StepCard>

      <StepCard step={3} label="Return" title="回传到内网" description="只打包内网还没有的提交（--not --remotes=origin）">
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
          <span className="text-sm text-muted">
            {selected.length ? `已选：${selected.join("、")}` : "在上方表格中选择分支"}
          </span>
          <ActionButton
            variant="primary"
            onPress={doExport}
            isDisabled={!exists || selected.length === 0 || (mode === "patch" && selected.length !== 1)}
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

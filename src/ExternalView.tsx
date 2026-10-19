import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertDialog, Checkbox, CheckboxGroup, Label, ListBox, Radio, RadioGroup, Select, Tabs } from "@heroui/react";
import { DateTime } from "./DateTime";
import {
  api, baseCandidates, defaultBaseFor, BranchInfo, ExportOutcome, MirrorState,
  OpOutcome, PackageInfo, prefixWarning, Profile, RefEntry, releasesOf, shortSha,
} from "./api";
import { Feedback, FeedbackScope, useRunner } from "./runner";
import { Icon } from "./icons";
import {
  BranchTable, DetachedWorktreesNotice, DirtyTreesNotice, InProgressBanners,
  useRefreshOnFocus, useRepoStatus, useRequestGeneration,
} from "./repoBits";
import { ActionButton, BaseSelect, Check, Code, Fold, Notice, OutcomeView, RefreshButton, TextInput } from "./ui";

function ReturnBranches({ branches, selected, onSelect, single, isDisabled }: {
  branches: BranchInfo[];
  selected: string[];
  onSelect: (names: string[]) => void;
  single: boolean;
  isDisabled: boolean;
}) {
  if (!branches.length) return <p className="sync-empty">还没有可回传的开发分支。</p>;
  if (single) return <RadioGroup className="sync-branches" aria-label="回传分支"
    value={selected[0] ?? ""} isDisabled={isDisabled} onChange={(name) => onSelect([name])}>
    {branches.map((branch) => <Radio key={branch.name} className="sync-branch-row" value={branch.name} aria-label={branch.name}>
      <Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>
        <span className="sync-branch-copy font-mono">{branch.name}</span>
      </Radio.Content>
    </Radio>)}
  </RadioGroup>;
  return <CheckboxGroup className="sync-branches" aria-label="回传分支"
    value={selected} isDisabled={isDisabled} onChange={onSelect}>
    {branches.map((branch) => <Checkbox key={branch.name} className="sync-branch-row" value={branch.name} aria-label={branch.name}>
      <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
        <span className="sync-branch-copy font-mono">{branch.name}</span>
      </Checkbox.Content>
    </Checkbox>)}
  </CheckboxGroup>;
}

export function ExternalView({ profile }: { profile: Profile }) {
  const [activeTab, setActiveTab] = useState("sync");
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
  const [picked, setPicked] = useState<{ key: string; path: string } | null>(null);

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
  const next = packages.find((p) => usable(p) && (needsFull || p.manifest!.seq === lastIn + 1));
  const chosen = picked?.key === refreshKey ? packages.find((p) => p.payloadPath === picked.path && usable(p)) : next;
  const missing = !needsFull && !next && packages.some((p) => p.manifest!.seq > lastIn + 1);
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
      setPicked(null);
    }
    await reloadAll();
  };

  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<"bundle" | "patch">("bundle");
  const [exportRes, setExportRes] = useState<ExportOutcome | null>(null);
  const [opRes, setOpRes] = useState<OpOutcome | null>(null);
  const [newBranch, setNewBranch] = useState("feature/");
  const [newBasePicked, setNewBasePicked] = useState<string | null>(null);
  const newBase = newBasePicked ?? defaultBaseFor(newBranch.trim(), profile);
  const newBranchWarning = prefixWarning(newBranch.trim(), newBase, profile);
  const [asWorktree, setAsWorktree] = useState(false);
  const [worktreePath, setWorktreePath] = useState("");
  const [rebaseTarget, setRebaseTarget] = useState<{ name: string; onto: string } | null>(null);
  const branches = (repo.status?.branches ?? []).filter((b) => !candidates.includes(b.name));
  const selectedBranches = selected.filter((name) => branches.some((b) => b.name === name));
  const rebaseInfo = branches.find((b) => b.name === rebaseTarget?.name);
  const rebaseWarning = rebaseTarget ? prefixWarning(rebaseTarget.name, rebaseTarget.onto, profile) : null;
  const canCreate = devReady && !!newBranch.trim() && !newBranch.trim().endsWith("/") && (!asWorktree || !!worktreePath.trim());

  useEffect(() => {
    setSelected([]);
    setExportRes(null);
    setOpRes(null);
    setRebaseTarget(null);
    setNewBranch("feature/");
    setNewBasePicked(null);
    setWorktreePath("");
  }, [refreshKey]);
  useEffect(() => {
    if (rebaseTarget && !rebaseInfo) setRebaseTarget(null);
  }, [rebaseTarget, rebaseInfo]);
  useEffect(() => {
    if (repo.loading) return;
    setSelected((previous) => previous.filter((name) => repo.status?.branches.some((b) => b.name === name && !candidates.includes(name))));
  }, [repo.status, repo.loading, base, JSON.stringify(releases)]);

  const createBranch = async () => {
    if (!canCreate) return;
    const isCurrent = beginAction();
    const outcome = await run("新建分支", () => api.createBranch(
      devDir, newBranch.trim(), newBase, asWorktree ? worktreePath.trim() : undefined,
    ));
    if (!isCurrent()) return;
    if (outcome !== undefined) {
      notify("ok", `已创建分支 ${newBranch.trim()}`);
      setNewBranch("feature/");
      setNewBasePicked(null);
      setWorktreePath("");
    }
    await reloadAll();
  };
  const saveIdentity = async () => {
    const isCurrent = beginAction();
    const outcome = await run("设置提交身份", () => api.configureRepo(
      devDir, profile.userName ?? "", profile.userEmail ?? "",
    ));
    if (outcome !== undefined && isCurrent()) notify("ok", "已写入提交身份");
  };
  const rebase = async () => {
    if (!rebaseTarget || !rebaseInfo || !devReady) return;
    const isCurrent = beginAction();
    const outcome = await run("Rebase", () => api.rebaseOnto(devDir, rebaseTarget.name, rebaseTarget.onto, false));
    if (!isCurrent()) return;
    if (outcome) {
      setOpRes(outcome);
      setRebaseTarget(null);
    }
    await reloadAll();
  };
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
  if (needsFull) summary = "请选择本项目的全量包开始同步。";
  if (chosen) summary = `本次更新 #${chosen.manifest!.seq} · ${chosen.manifest!.kind === "full" ? "全量" : "增量"}`;
  return <>
    {!current && <Feedback kind="progress" text="正在检查更新…" />}
    <Tabs className="sync-workspace" variant="secondary" selectedKey={activeTab} onSelectionChange={(key) => setActiveTab(String(key))}>
    <Tabs.ListContainer><Tabs.List className="sync-tabs" aria-label="外网同步">
      <Tabs.Tab id="sync">同步更新<Tabs.Indicator /></Tabs.Tab>
      <Tabs.Tab id="return">回传提交<Tabs.Indicator /></Tabs.Tab>
    </Tabs.List></Tabs.ListContainer>
    <div className="sync-location">
      <Icon name="folder" /><span className="min-w-0 flex-1 truncate" title={profile.transferDir}>{profile.transferDir}</span>
      <RefreshButton onPress={reloadAll} />
    </div>
    {!mirrorDir.trim() && <Feedback kind="warn" text="请在项目设置中填写外网镜像目录。" />}
    {!devRepos.length && <Feedback kind="warn" text="请在项目设置中添加开发仓库目录。" />}
    {current?.stateError && <Feedback kind="error" text={`无法读取同步记录，请检查后刷新。\n${current.stateError}`} />}
    {mirror.error && <Feedback kind="error" text={`无法读取外网镜像。\n${mirror.error}`} />}
    {mirror.status?.isRepo && !mirror.status.isBare && <Feedback kind="error" text="镜像目录必须是裸仓库，请检查项目设置。" />}
    {repo.error && <Feedback kind="error" text={`无法读取开发仓库。\n${repo.error}`} />}
    <Tabs.Panel className="sync-panel" id="sync" shouldForceMount style={({ isInert }) => ({ display: isInert ? "none" : undefined })}>
      <FeedbackScope value={activeTab === "sync"}>
      {current?.packageError && <Feedback kind="error" text={`无法读取传输目录，请检查连接后刷新。\n${current.packageError}`} />}
      {current?.devError && <Feedback kind="error" text={`无法检查开发仓库同步状态，请刷新或重试同步。\n${current.devError}`} />}
      {current && !current.loading && !current.stateError && <>
        {missing && <Feedback kind="warn" text={`缺少更新 #${lastIn + 1}，请补齐或选择较新的全量包。`} />}
        {missingImpact && <Feedback kind="warn" text="无法读取完整引用影响，请刷新后再使用全量包跳号。" />}
      </>}
      <div className="sync-action">
        <span className="sync-action-icon" aria-hidden="true"><Icon name="branch" /></span>
        <div className="sync-action-copy"><h1>同步内网更新</h1>
          {current && !current.loading && !current.stateError && !mirror.error && <p>{summary}</p>}
        </div>
        <ActionButton variant="primary" onPress={() => sync()} isDisabled={!canSync}>
          {!chosen && mirrorReady && pendingDevs ? "完成同步" : "同步更新"}
        </ActionButton>
      </div>
      <Fold className="sync-details" title={"更新包详情与选择"}>
        {chosen && <div><Code>{chosen.payloadPath}</Code> · <DateTime value={chosen.manifest?.createdAt} label="包创建时间" /></div>}
        {chosen?.manifest?.refs.map((ref) => <p key={ref.name}><Code>{ref.name}</Code> · {shortSha(ref.sha)}</p>)}
        <Select className="sync-select-field" fullWidth value={chosen?.payloadPath ?? "no-package"} isDisabled={!ready || !!busy}
          disabledKeys={packages.filter((p) => !usable(p)).map((p) => p.payloadPath)}
          onChange={(key) => { if (key != null) setPicked({ key: refreshKey, path: key === "no-package" ? "" : String(key) }); }}>
          <Label>选择更新包</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover><ListBox>
            <ListBox.Item id="no-package" textValue={mirrorReady ? "仅更新开发仓库" : "选择全量包"}>{mirrorReady ? "仅更新开发仓库" : "选择全量包"}<ListBox.ItemIndicator /></ListBox.Item>
            {packages.map((p) => {
              const label = `#${p.manifest!.seq} · ${p.manifest!.kind === "full" ? "全量" : "增量"} · ${p.manifest!.payload}${!p.payloadExists ? "（文件缺失）" : ""}`;
              return <ListBox.Item key={p.payloadPath} id={p.payloadPath} textValue={label}>{label}<ListBox.ItemIndicator /></ListBox.Item>;
            })}
          </ListBox></Select.Popover>
        </Select>
      </Fold>
      <Fold className="sync-details" title={"开发仓库管理"}>
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
      </Fold>
      </FeedbackScope>
    </Tabs.Panel>
    <Tabs.Panel className="sync-panel" id="return" shouldForceMount style={({ isInert }) => ({ display: isInert ? "none" : undefined })}>
      <FeedbackScope value={activeTab === "return"}>
      <InProgressBanners status={repo.status} onDone={(outcome) => {
        if (outcome) setOpRes(outcome);
        void reloadAll();
      }} />
      <DirtyTreesNotice status={repo.status} suffix="回传只包含已提交的内容。" />
      {!devReady ? (!repo.loading && <Feedback kind="warn" text="请先在同步更新页准备开发仓库。" />)
        : <ReturnBranches branches={branches} selected={selectedBranches} onSelect={setSelected} single={mode === "patch"} isDisabled={!!busy} />}
      <div className="sync-action">
        <ActionButton variant="primary" onPress={doExport}
          isDisabled={!ready || !devReady || !mirrorReady || !selectedBranches.length || mode === "patch" && selectedBranches.length !== 1}>
          导出回传
        </ActionButton>
      </div>
      <Fold className="sync-details" title={<>格式：{mode === "bundle" ? "Bundle" : "Patch"}</>}>
        <RadioGroup className="sync-format-options" orientation="horizontal" aria-label="回传格式" value={mode} isDisabled={!!busy}
          onChange={(value) => {
            setMode(value as "bundle" | "patch");
            if (value === "patch") setSelected((previous) => previous.slice(0, 1));
          }}>
        {(["bundle", "patch"] as const).map((value) => <Radio key={value} value={value}>
          <Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>
          {value === "bundle" ? "Bundle" : "Patch（单分支）"}
          </Radio.Content></Radio>)}
        </RadioGroup>
      </Fold>
      <Fold className="sync-details" title={"分支管理"}>
        <div className="sync-branch-form">
        <p>当前仓库：<Code>{devDir || "未配置"}</Code></p>
        <TextInput label="新分支" value={newBranch} onChange={setNewBranch} mono />
        <BaseSelect label="基于" value={newBase} options={candidates} mainline={base} onChange={setNewBasePicked} />
        <Check checked={asWorktree} onChange={setAsWorktree}>创建为独立 worktree</Check>
        {asWorktree && <><TextInput label="worktree 目录" value={worktreePath} onChange={setWorktreePath} mono />
          <ActionButton variant="outline" onPress={async () => {
            const isCurrent = beginAction();
            const path = await open({ directory: true, multiple: false });
            if (typeof path === "string" && isCurrent()) setWorktreePath(path);
          }}>浏览目录</ActionButton></>}
        {newBranchWarning && <Notice tone="warning" title={newBranchWarning} />}
        <div className="sync-button-group">
        <ActionButton variant="secondary" onPress={createBranch} isDisabled={!canCreate}>{asWorktree ? "新建 worktree" : "新建并切换"}</ActionButton>
        {(profile.userName || profile.userEmail) && <ActionButton variant="ghost" onPress={saveIdentity} isDisabled={!devReady}>写入提交身份</ActionButton>}
        </div>
        <BranchTable branches={branches} selected={selectedBranches}
          onSelect={(names) => setSelected(mode === "patch" ? names.slice(0, 1) : names)}
          multi={mode === "bundle"} onRebase={(b) => setRebaseTarget({ name: b.name, onto: b.base })}
          repoPath={devDir} onDeleted={reloadAll} />
        <DetachedWorktreesNotice status={repo.status} />
        </div>
      </Fold>
      {opRes && !opRes.ok && <OutcomeView outcome={opRes} />}
      {exportRes?.status === "exported" && <Fold className="sync-details" title={`查看回传 #${exportRes.seq} 文件`}>
        <Code>{exportRes.payload}</Code>
      </Fold>}
      </FeedbackScope>
    </Tabs.Panel>
    </Tabs>
    <AlertDialog.Backdrop isOpen={!!rebaseTarget} onOpenChange={(value) => { if (!value && !busy) setRebaseTarget(null); }}>
      <AlertDialog.Container><AlertDialog.Dialog>
        <AlertDialog.Header><AlertDialog.Heading>Rebase 分支</AlertDialog.Heading></AlertDialog.Header>
        <AlertDialog.Body><p>分支：<Code>{rebaseTarget?.name}</Code></p>
          <BaseSelect label="Rebase 到" value={rebaseTarget?.onto ?? base} options={candidates} mainline={base}
            onChange={(onto) => setRebaseTarget((target) => target ? { ...target, onto } : null)} />
          {rebaseWarning && <Notice tone="warning" title={rebaseWarning} />}
        </AlertDialog.Body>
        <AlertDialog.Footer><ActionButton variant="tertiary" onPress={() => setRebaseTarget(null)}>取消</ActionButton>
          <ActionButton variant="primary" onPress={rebase} isDisabled={!rebaseInfo || !devReady}>Rebase 到 origin/{rebaseTarget?.onto}</ActionButton>
        </AlertDialog.Footer>
      </AlertDialog.Dialog></AlertDialog.Container>
    </AlertDialog.Backdrop>
  </>;
}

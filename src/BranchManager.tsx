import { useEffect, useRef, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./components/ui/alert-dialog";
import { WindowControls } from "./WindowControls";
import { open } from "@tauri-apps/plugin-dialog";
import { api, baseCandidates, defaultBaseFor, prefixWarning, type BranchInfo, type OpOutcome, type Profile, type RepoStatus } from "./api";
import { Feedback, OperationStatus, useRunner } from "./runner";
import { BranchTable, useRequestGeneration } from "./repoBits";
import { ActionButton, ActionIconButton, BaseSelect, Check, Code, CommitList, Fold, Notice, OutcomeView, TextInput } from "./ui";
import { Icon } from "./icons";

export function BranchManager({ profile, repoPath, status, loading, error, onRefresh, selected, onSelect, multi = true, pushBlocked = false }: {
  profile: Profile; repoPath: string; status: RepoStatus | null; loading: boolean; error: string | null;
  onRefresh: () => Promise<unknown>; selected: string[]; onSelect: (names: string[]) => void;
  multi?: boolean; pushBlocked?: boolean;
}) {
  const { run, notify, confirm, busy } = useRunner();
  const context = JSON.stringify([profile, repoPath]);
  const beginAction = useRequestGeneration(context);
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(() => { contextRef.current = context; return () => { contextRef.current = ""; }; }, [context]);
  const base = profile.baseBranch;
  const candidates = baseCandidates(profile);
  const internal = profile.role === "internal";
  const ready = !!status?.isRepo && !status.isBare && !loading;
  const unfinished = !!status?.inProgress || !!status?.inProgressTrees.length;
  const branches = (status?.branches ?? []).filter((b) => !candidates.includes(b.name));
  const [newBranch, setNewBranch] = useState("feature/");
  const [newBasePicked, setNewBasePicked] = useState<string | null>(null);
  const newBase = newBasePicked ?? defaultBaseFor(newBranch.trim(), profile);
  const newBranchWarning = prefixWarning(newBranch.trim(), newBase, profile);
  const [asWorktree, setAsWorktree] = useState(false);
  const [worktreePath, setWorktreePath] = useState("");
  const [rebaseTarget, setRebaseTarget] = useState<{ name: string; onto: string } | null>(null);
  const rebaseReturnFocus = useRef<HTMLElement | null>(null);
  const rebaseInfo = branches.find((b) => b.name === rebaseTarget?.name);
  const rebaseWarning = rebaseTarget ? prefixWarning(rebaseTarget.name, rebaseTarget.onto, profile) : null;
  const [forceLease, setForceLease] = useState(false);
  const [outcome, setOutcome] = useState<OpOutcome | null>(null);
  const [identitySaved, setIdentitySaved] = useState(false);
  const canCreate = ready && !unfinished && !!newBranch.trim() && !newBranch.trim().endsWith("/") && (!asWorktree || !!worktreePath.trim());
  useEffect(() => { if (rebaseTarget && !rebaseInfo && !loading) setRebaseTarget(null); }, [rebaseTarget, rebaseInfo, loading]);

  async function createBranch() {
    if (!canCreate) return;
    const isCurrent = beginAction();
    const result = await run("新建分支", () => api.createBranch(repoPath, newBranch.trim(), newBase, asWorktree ? worktreePath.trim() : undefined));
    if (!isCurrent()) return;
    if (result !== undefined) {
      setNewBranch("feature/"); setNewBasePicked(null); setWorktreePath("");
    }
    await onRefresh();
  }
  async function saveIdentity() {
    const isCurrent = beginAction();
    setIdentitySaved(false);
    const result = await run("设置提交身份", () => api.configureRepo(repoPath, profile.userName ?? "", profile.userEmail ?? ""));
    if (!isCurrent()) return;
    if (result !== undefined) setIdentitySaved(true);
    await onRefresh();
  }
  async function rebase() {
    if (!rebaseTarget || !rebaseInfo || !ready || unfinished) return;
    const isCurrent = beginAction();
    const result = await run("Rebase", () => api.rebaseOnto(repoPath, rebaseTarget.name, rebaseTarget.onto, internal));
    if (!isCurrent()) return;
    if (result) { setOutcome(result); setRebaseTarget(null); }
    await onRefresh();
  }
  async function push(branch: BranchInfo) {
    if (!internal || !ready || unfinished || pushBlocked) return;
    const startedContext = contextRef.current;
    const plan = await run("检查推送提交", () => api.preparePush(repoPath, branch.name, forceLease));
    if (!plan || contextRef.current !== startedContext) return;
    if (plan.nonFastForward && !forceLease) return notify("warn", "目标分支需要非快进更新，请在推送选项中核对并启用覆盖确认");
    const approved = await confirm({
      title: `推送 ${plan.targetRef.replace(/^refs\/heads\//, "")}`,
      confirmLabel: plan.nonFastForward ? "确认覆盖并推送" : "确认推送",
      tone: plan.nonFastForward ? "danger" : "accent",
      body: <div className="space-y-3">
        <p className="text-sm break-all">{plan.remoteUrl} · {plan.targetRef.replace(/^refs\/heads\//, "")}</p>
        {plan.nonFastForward && <Notice tone="warning" title="此操作会替换远程分支的提交历史，其他人的工作可能受影响。" />}
        <p className="text-sm text-muted-foreground">共 {plan.commits.length} 个待检查提交</p>
        <CommitList commits={plan.commits} empty="没有相对基准的新提交" />
        <Fold className="sync-details" title="技术详情"><dl className="break-all text-xs space-y-2">
          <dt>源提交</dt><dd><Code>{plan.sourceOid}</Code></dd><dt>远程旧提交</dt><dd><Code>{plan.remoteOid ?? "新分支"}</Code></dd>
          <dt>基准</dt><dd><Code>{plan.baseOid}</Code></dd>
        </dl></Fold>
      </div>,
    });
    if (!approved) return;
    if (contextRef.current !== startedContext) return notify("warn", "工作区已变化，请重新检查后推送");
    const result = await run("推送", () => api.executePush(plan.planId));
    if (contextRef.current !== startedContext) return;
    if (result) setOutcome({ ...result, message: result.message.replace(/refs\/heads\//g, "") });
    await onRefresh();
  }

  return <>
    <section className="inline-branch-tools" aria-label="分支操作" aria-busy={loading}>
      <div className="sync-location"><Icon name="folder" /><span className="min-w-0 flex-1 truncate" title={repoPath}>{repoPath || "未配置工作仓库"}</span>
      </div>
      {error && <Feedback kind="error" text={`读取工作仓库失败\n${error}`} />}
      {!ready && !loading && !error && <Feedback kind="warn" text={internal ? "请先在项目设置中填写已克隆的内网工作仓库。" : "请先导入更新，再同步开发仓库。"} />}
      <div className="sync-branch-form">
        <div className="branch-create-form">
          <TextInput className="branch-create-name" label="新分支" value={newBranch} onChange={setNewBranch} />
          <BaseSelect className="branch-create-base" label="基于" value={newBase} options={candidates} mainline={base} onChange={setNewBasePicked} />
          <Check checked={asWorktree} onChange={setAsWorktree}>创建为独立 worktree</Check>
          {asWorktree && <div className="branch-worktree-path">
            <TextInput className="min-w-0 flex-1" label="worktree 目录" value={worktreePath} onChange={setWorktreePath} placeholder="输入或选择目录" />
            <ActionIconButton icon="folder" label="浏览目录" onClick={async () => {
              const isCurrent = beginAction();
              try {
                const path = await open({ directory: true, multiple: false });
                if (typeof path === "string" && isCurrent()) setWorktreePath(path);
              } catch (error) {
                if (isCurrent()) notify("error", `打开目录选择器失败：${String(error)}`);
              }
            }} />
          </div>}
          {newBranchWarning && <Notice tone="warning" title={newBranchWarning} />}
          <div className="sync-button-group">
            <ActionIconButton icon={asWorktree ? "worktree" : "plus"} label={asWorktree ? "新建 worktree" : "新建并切换"}
              variant="secondary" onClick={createBranch} disabled={!canCreate} />
            {(profile.userName || profile.userEmail) && <ActionIconButton icon="identity" label="写入提交身份" onClick={saveIdentity} disabled={!ready} />}
          </div>
        </div>
        {identitySaved && <Feedback kind="ok" text="已写入提交身份" />}
        {internal && <Fold className="sync-details" title="推送选项"><Check checked={forceLease} onChange={setForceLease}>允许非快进更新（推送前再次确认覆盖）</Check></Fold>}
        {loading && !status ? <Feedback kind="progress" text="正在读取本地分支…" /> : <BranchTable branches={branches} dirtyTrees={status?.dirtyTrees} selected={selected} onSelect={onSelect} multi={multi} isSelectionDisabled={!!busy || !ready}
        emptyText={internal ? "还没有本地开发分支。" : "还没有可回传的开发分支。"}
          onRebase={(b) => setRebaseTarget({ name: b.name, onto: b.base })} showPush={internal} onPush={internal ? push : undefined} pushDisabled={pushBlocked}
          actionsDisabled={!ready || unfinished} repoPath={repoPath} onDeleted={onRefresh} />}
      </div>
      {outcome && !outcome.ok && <OutcomeView outcome={outcome} />}
    </section>
    <AlertDialog open={!!rebaseTarget} onOpenChange={(open) => { if (!open && !busy) setRebaseTarget(null); }}>
      <AlertDialogContent className="app-surface"
        topLayer={<><WindowControls inline /><OperationStatus inline /></>}
        onOpenAutoFocus={() => { rebaseReturnFocus.current = document.activeElement as HTMLElement | null; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (rebaseReturnFocus.current?.isConnected) rebaseReturnFocus.current.focus(); }}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
        <AlertDialogHeader>
          <AlertDialogTitle>Rebase 分支</AlertDialogTitle>
          <AlertDialogDescription asChild><p>分支：<Code>{rebaseTarget?.name}</Code></p></AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3">
          <BaseSelect label="Rebase 到" value={rebaseTarget?.onto ?? base} options={candidates} mainline={base}
            onChange={(onto) => setRebaseTarget((target) => target ? { ...target, onto } : null)} />
          {rebaseWarning && <Notice tone="warning" title={rebaseWarning} />}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel asChild><ActionButton type="button" variant="outline">取消</ActionButton></AlertDialogCancel>
          <AlertDialogAction asChild><ActionButton type="button" variant="default" onClick={(event) => { event.preventDefault(); void rebase(); }}
            disabled={!rebaseInfo || !ready || unfinished}>Rebase 到 origin/{rebaseTarget?.onto}</ActionButton></AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

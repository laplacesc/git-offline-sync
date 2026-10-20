import { useEffect, useRef, useState } from "react";
import { AlertDialog, Button, Modal } from "@heroui/react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, baseCandidates, defaultBaseFor, prefixWarning, type BranchInfo, type OpOutcome, type Profile, type RepoStatus } from "./api";
import { Feedback, FeedbackScope, useRunner } from "./runner";
import { BranchTable, DetachedWorktreesNotice, DirtyTreesNotice, InProgressBanners, useRequestGeneration } from "./repoBits";
import { ActionButton, ActionIconButton, BaseSelect, Check, Code, CommitList, Fold, Notice, OutcomeView, RefreshButton, TextInput, WorkspaceNavigation } from "./ui";
import { Icon } from "./icons";

export function BranchManager({ profile, repoPath, status, loading, error, isOpen, onOpenChange, onRefresh, target, initialSelection = [], pushBlocked = false }: {
  profile: Profile; repoPath: string; status: RepoStatus | null; loading: boolean; error: string | null;
  isOpen: boolean; onOpenChange: (open: boolean) => void; onRefresh: () => Promise<void>;
  target?: HTMLElement | null; initialSelection?: string[]; pushBlocked?: boolean;
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
  const [selected, setSelected] = useState<string[]>([]);
  const [newBranch, setNewBranch] = useState("feature/");
  const [newBasePicked, setNewBasePicked] = useState<string | null>(null);
  const newBase = newBasePicked ?? defaultBaseFor(newBranch.trim(), profile);
  const newBranchWarning = prefixWarning(newBranch.trim(), newBase, profile);
  const [asWorktree, setAsWorktree] = useState(false);
  const [worktreePath, setWorktreePath] = useState("");
  const [rebaseTarget, setRebaseTarget] = useState<{ name: string; onto: string } | null>(null);
  const rebaseInfo = branches.find((b) => b.name === rebaseTarget?.name);
  const rebaseWarning = rebaseTarget ? prefixWarning(rebaseTarget.name, rebaseTarget.onto, profile) : null;
  const [forceLease, setForceLease] = useState(false);
  const [outcome, setOutcome] = useState<OpOutcome | null>(null);
  const canCreate = ready && !unfinished && !!newBranch.trim() && !newBranch.trim().endsWith("/") && (!asWorktree || !!worktreePath.trim());
  const selectionKey = JSON.stringify(initialSelection);
  useEffect(() => { if (isOpen && initialSelection.length) setSelected(initialSelection); }, [isOpen, selectionKey]);
  useEffect(() => { if (rebaseTarget && !rebaseInfo && !loading) setRebaseTarget(null); }, [rebaseTarget, rebaseInfo, loading]);

  async function createBranch() {
    if (!canCreate) return;
    const isCurrent = beginAction();
    const result = await run("新建分支", () => api.createBranch(repoPath, newBranch.trim(), newBase, asWorktree ? worktreePath.trim() : undefined));
    if (!isCurrent()) return;
    if (result !== undefined) {
      notify("ok", `已创建分支 ${newBranch.trim()}`);
      setNewBranch("feature/"); setNewBasePicked(null); setWorktreePath("");
    }
    await onRefresh();
  }
  async function saveIdentity() {
    const isCurrent = beginAction();
    const result = await run("设置提交身份", () => api.configureRepo(repoPath, profile.userName ?? "", profile.userEmail ?? ""));
    if (result !== undefined && isCurrent()) notify("ok", "已写入提交身份");
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
        <p className="text-sm text-muted">共 {plan.commits.length} 个待检查提交</p>
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
    <Modal isOpen={isOpen} onOpenChange={(open) => { if (!busy) onOpenChange(open); }}>
    <WorkspaceNavigation target={target}>
      <Button isIconOnly className="branch-manager-trigger" size="sm" variant="ghost" aria-label="分支管理" aria-haspopup="dialog"
        isDisabled={!!busy} onPress={() => onOpenChange(true)}><span title="分支管理"><Icon name="branch" /></span></Button>
    </WorkspaceNavigation>
    <Modal.Backdrop isOpen={isOpen} isDismissable={false} isKeyboardDismissDisabled={!!busy}
      onOpenChange={(open) => { if (!busy) onOpenChange(open); }}>
      <Modal.Container size="lg" scroll="inside" className="branch-manager-container">
        <Modal.Dialog className="branch-manager-dialog sync-panel" aria-label="分支管理">
          <Modal.Header className="branch-manager-heading">
            <Modal.Heading>分支管理</Modal.Heading>
            <ActionIconButton icon="clear" label="关闭分支管理" onPress={() => onOpenChange(false)} />
          </Modal.Header>
          <Modal.Body className="branch-manager-body">
            <FeedbackScope value={isOpen}>
              <div className="sync-location"><Icon name="folder" /><span className="min-w-0 flex-1 truncate" title={repoPath}>{repoPath || "未配置工作仓库"}</span><RefreshButton iconOnly onPress={onRefresh} /></div>
              {error && <Feedback kind="error" text={`读取工作仓库失败\n${error}`} />}
              {!ready && !loading && !error && <Feedback kind="warn" text={internal ? "请先在项目设置中填写已克隆的内网工作仓库。" : "请先同步更新并准备开发仓库。"} />}
              <InProgressBanners status={status} iconOnly onDone={(result) => { if (result) setOutcome(result); void onRefresh(); }} />
              <DirtyTreesNotice status={status} suffix="请先提交或暂存后再执行分支操作。" />
              <div className="sync-branch-form">
                <div className="branch-create-form">
                  <TextInput className="branch-create-name" label="新分支" value={newBranch} onChange={setNewBranch} mono />
                  <BaseSelect className="branch-create-base" label="基于" value={newBase} options={candidates} mainline={base} onChange={setNewBasePicked} />
                  <Check checked={asWorktree} onChange={setAsWorktree}>创建为独立 worktree</Check>
                  {asWorktree && <div className="branch-worktree-path">
                    <TextInput className="min-w-0 flex-1" label="worktree 目录" value={worktreePath} onChange={setWorktreePath} placeholder="输入或选择目录" mono />
                    <ActionIconButton icon="folder" label="浏览目录" onPress={async () => {
                      const isCurrent = beginAction();
                      const path = await open({ directory: true, multiple: false });
                      if (typeof path === "string" && isCurrent()) setWorktreePath(path);
                    }} />
                  </div>}
                  {newBranchWarning && <Notice tone="warning" title={newBranchWarning} />}
                  <div className="sync-button-group">
                    <ActionIconButton icon={asWorktree ? "worktree" : "plus"} label={asWorktree ? "新建 worktree" : "新建并切换"}
                      variant="secondary" onPress={createBranch} isDisabled={!canCreate} />
                    {(profile.userName || profile.userEmail) && <ActionIconButton icon="identity" label="写入提交身份" onPress={saveIdentity} isDisabled={!ready} />}
                  </div>
                </div>
                {internal && <Fold className="sync-details" title="推送选项"><Check checked={forceLease} onChange={setForceLease}>允许非快进更新（推送前再次确认覆盖）</Check></Fold>}
                <BranchTable branches={branches} selected={selected} onSelect={setSelected} multi
                  onRebase={(b) => setRebaseTarget({ name: b.name, onto: b.base })} showPush onPush={internal ? push : undefined} pushDisabled={pushBlocked}
                  actionsDisabled={!ready || unfinished} repoPath={repoPath} onDeleted={onRefresh} />
                <DetachedWorktreesNotice status={status} />
              </div>
              {outcome && !outcome.ok && <OutcomeView outcome={outcome} />}
            </FeedbackScope>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
    </Modal>
    <AlertDialog.Backdrop isOpen={isOpen && !!rebaseTarget} onOpenChange={(open) => { if (!open && !busy) setRebaseTarget(null); }}>
      <AlertDialog.Container><AlertDialog.Dialog>
        <AlertDialog.Header><AlertDialog.Heading>Rebase 分支</AlertDialog.Heading></AlertDialog.Header>
        <AlertDialog.Body><p>分支：<Code>{rebaseTarget?.name}</Code></p>
          <BaseSelect label="Rebase 到" value={rebaseTarget?.onto ?? base} options={candidates} mainline={base}
            onChange={(onto) => setRebaseTarget((target) => target ? { ...target, onto } : null)} />
          {rebaseWarning && <Notice tone="warning" title={rebaseWarning} />}
        </AlertDialog.Body>
        <AlertDialog.Footer><ActionButton variant="tertiary" onPress={() => setRebaseTarget(null)}>取消</ActionButton>
          <ActionButton variant="primary" onPress={rebase} isDisabled={!rebaseInfo || !ready || unfinished}>Rebase 到 origin/{rebaseTarget?.onto}</ActionButton>
        </AlertDialog.Footer>
      </AlertDialog.Dialog></AlertDialog.Container>
    </AlertDialog.Backdrop>
  </>;
}

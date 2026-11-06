import { AheadBehind } from "./ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { api, BranchInfo, InProgressOp, OpOutcome, PackageInfo, RepoStatus, Worktree, shortSha } from "./api";
import { useRunner } from "./runner";
import { Icon } from "./icons";
import { ActionButton, ActionIconButton, Code, Empty, TextInput } from "./ui";

/**
 * 应用窗口回到前台时调用 reload。
 * 用 Tauri 的原生窗口焦点事件（Windows 上 WebView2 的 DOM focus 事件不可靠）；
 * 有操作进行中时跳过，短时间内的重复焦点事件（如关闭文件对话框）只刷新一次。
 */
export function useRefreshOnFocus(reload: () => unknown) {
  const { busy } = useRunner();
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        clearTimeout(timer);
        if (!focused || disposed) return;
        timer = setTimeout(() => {
          if (!busyRef.current) reloadRef.current();
        }, 300);
      })
      .then((fn) => (disposed ? fn() : (unlisten = fn)))
      .catch(() => {});
    return () => {
      disposed = true;
      clearTimeout(timer);
      unlisten?.();
    };
  }, []);
}

/** Start a request and test whether it still belongs to this mounted input. */
export function useRequestGeneration(key: string) {
  const currentKey = useRef(key);
  currentKey.current = key;
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, [key]);
  return useCallback(() => {
    if (!mounted.current || currentKey.current !== key) return () => false;
    const id = ++generation.current;
    return () => mounted.current && currentKey.current === key && generation.current === id;
  }, [key]);
}

/** Keep package scans independent from local status, and discard stale results. */
export function usePackages(key: string, dir: string) {
  const beginRequest = useRequestGeneration(key);
  const [snapshot, setSnapshot] = useState<{
    key: string; loading: boolean; packages: PackageInfo[]; packageError: string | null;
  } | null>(null);
  const reload = useCallback(async () => {
    const isCurrent = beginRequest();
    if (!isCurrent()) return;
    setSnapshot((previous) => previous?.key === key ? { ...previous, loading: true } : null);
    const result = await api.listPackages(dir).then(
      (packages) => ({ packages, packageError: null }),
      (error) => ({ packages: [] as PackageInfo[], packageError: String(error) }),
    );
    if (isCurrent()) setSnapshot({ key, loading: false, ...result });
  }, [beginRequest, key, dir]);
  const current = snapshot?.key === key ? snapshot : null;
  return { current, loading: !current || current.loading, reload };
}

/** Read status for this exact input; the page owns when to refresh. */
export function useRepoStatus(path: string | undefined, baseBranch: string, releaseBranches: string[]) {
  const releasesKey = JSON.stringify(releaseBranches);
  const key = JSON.stringify([path, baseBranch, releasesKey]);
  const beginRequest = useRequestGeneration(key);
  const [result, setResult] = useState<{
    key: string; status: RepoStatus | null; loading: boolean; error: string | null;
  } | null>(null);
  const reload = useCallback(async (): Promise<RepoStatus | null> => {
    const isCurrent = beginRequest();
    if (!isCurrent()) return null;
    if (!path) {
      setResult({ key, status: null, loading: false, error: null });
      return null;
    }
    setResult((previous) => ({ key, status: previous?.key === key ? previous.status : null, loading: true, error: null }));
    try {
      const status = await api.repoStatus(path, baseBranch, JSON.parse(releasesKey) as string[]);
      if (!isCurrent()) return null;
      setResult({ key, status, loading: false, error: null });
      return status;
    } catch (error) {
      if (isCurrent()) setResult({ key, status: null, loading: false, error: String(error) });
      return null;
    }
  }, [path, baseBranch, releasesKey, key, beginRequest]);
  const current = result?.key === key ? result : null;
  return { status: current?.status ?? null, loading: current?.loading ?? !!path, error: current?.error ?? null, reload };
}

/**
 * 未完成的 rebase / am 横幅，提供继续与中止。
 *
 * 按工作树逐个渲染：rebase 的标记文件是每个 worktree 独立的，卡在 linked
 * worktree 里的操作必须把「继续 / 中止」发到那个目录，发给主仓库不起作用。
 */
export function InProgressBanners({
  status,
  onDone,
}: {
  status: RepoStatus | null;
  onDone: (o?: OpOutcome) => void;
}) {
  return (
    <>
      {(status?.inProgressTrees ?? []).map((t) => (
        <InProgressBanner key={t.path} tree={t} onDone={onDone} />
      ))}
    </>
  );
}

function InProgressBanner({ tree, onDone }: { tree: InProgressOp; onDone: (o?: OpOutcome) => void }) {
  const { run } = useRunner();
  const { op, path, branch, main } = tree;
  return (
    <Alert className="flex items-start gap-3" data-tone="warning" role="alert">
      <CircleAlertIcon aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <AlertTitle>
          {main ? "仓库中" : `worktree ${baseName(path)}`} 有未完成的 {op}
          {branch && <span className="ml-1 font-mono text-xs">（{branch}）</span>}
        </AlertTitle>
        <AlertDescription>
          在 <code className="font-mono break-all">{path}</code> 里解决冲突并执行{" "}
          <code className="font-mono">git add</code> 后点“继续”，或点“中止”回到操作前的状态。
        </AlertDescription>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-center">
        <ActionButton size="sm" variant="secondary"
          onClick={async () => onDone(await run(`继续 ${op}`, () => api.continueOp(path)))}>
          继续
        </ActionButton>
        <ActionButton size="sm" variant="destructive"
          onClick={async () => onDone(await run(`中止 ${op}`, () => api.abortOp(path)))}>
          中止
        </ActionButton>
      </div>
    </Alert>
  );
}

/** 分支表：显式受控的单选或多选，搜索保留隐藏的选择。 */
export function BranchTable({
  branches,
  dirtyTrees = [],
  selected,
  onSelect,
  multi,
  isSelectionDisabled = false,
  onRebase,
  showPush = false,
  onPush,
  pushDisabled = false,
  actionsDisabled = false,
  repoPath,
  onDeleted,
  emptyText = "没有本地分支",
}: {
  branches: BranchInfo[];
  dirtyTrees?: Worktree[];
  selected: string[];
  onSelect: (names: string[]) => void;
  multi?: boolean;
  isSelectionDisabled?: boolean;
  onRebase?: (b: BranchInfo) => void;
  showPush?: boolean;
  onPush?: (b: BranchInfo) => void;
  pushDisabled?: boolean;
  actionsDisabled?: boolean;
  repoPath?: string;
  onDeleted?: () => unknown;
  emptyText?: string;
}) {
  const [query, setQuery] = useState("");
  const [copiedBranch, setCopiedBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!copiedBranch) return;
    const timer = setTimeout(() => setCopiedBranch(null), 2000);
    return () => clearTimeout(timer);
  }, [copiedBranch]);
  const selectionRange = useRef<{ anchor: string; end: string } | null>(null);
  const { notify, confirm, run } = useRunner();
  const deleteBranch = async (b: BranchInfo) => {
    if (!repoPath || b.current || b.worktree) return;
    const approved = await confirm({
      title: `删除本地分支 ${b.name}？`,
      tone: "danger",
      confirmLabel: "删除本地分支",
      body: <div className="space-y-3">
        <p>从 <Code>{repoPath}</Code> 删除 <Code>{b.name}</Code>，远程分支保持不变。</p>
        <p className="text-sm text-muted-foreground">如果分支尚未合并，会再次询问是否强制删除。</p>
      </div>,
    });
    if (!approved) return;
    let result = await run("删除本地分支", () => api.deleteLocalBranch(repoPath, b.name));
    if (result?.status === "needsForce") {
      const forceAt = result.sha;
      const forceApproved = await confirm({
        title: `强制删除未合并分支 ${b.name}？`,
        tone: "danger",
        confirmLabel: "仍然强制删除",
        body: <div className="space-y-3">
          <p><Code>{b.name}</Code> 尚未合并，删除后可能丢失仅保存在此分支上的提交。</p>
          <p className="text-sm text-muted-foreground">仓库：<Code>{repoPath}</Code>；分支提交：<Code>{shortSha(forceAt)}</Code>。请确认这些提交已备份或不再需要。</p>
        </div>,
      });
      if (!forceApproved) return;
      result = await run("强制删除本地分支", () => api.deleteLocalBranch(repoPath, b.name, forceAt));
    }
    await onDeleted?.();
  };
  const copyBranch = async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
      setCopiedBranch(name);
    } catch {
      notify("error", "复制失败，请选择分支名手动复制");
    }
  };
  if (branches.length === 0) return <Empty>{emptyText}</Empty>;

  const visible = branches.filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase()));
  const visibleNames = new Set(visible.map((b) => b.name));
  const hiddenSelected = multi ? selected.filter((name) => !visibleNames.has(name)) : [];
  const selectedVisible = visible.filter((branch) => selected.includes(branch.name));
  const allVisibleSelected = selectedVisible.length === visible.length;
  const toggleBranch = (name: string) => {
    if (isSelectionDisabled) return;
    selectionRange.current = { anchor: name, end: name };
    if (selected.includes(name)) onSelect(selected.filter((selectedName) => selectedName !== name));
    else onSelect(multi ? [...selected, name] : [name]);
  };
  const extendSelection = (name: string, fallbackAnchor = name) => {
    if (isSelectionDisabled || !multi) return;
    const range = selectionRange.current;
    const anchor = range && visibleNames.has(range.anchor) ? range.anchor : fallbackAnchor;
    const anchorIndex = visible.findIndex((branch) => branch.name === anchor);
    const endIndex = visible.findIndex((branch) => branch.name === name);
    const previousEndIndex = range?.anchor === anchor ? visible.findIndex((branch) => branch.name === range.end) : -1;
    const previousEnd = previousEndIndex < 0 ? anchorIndex : previousEndIndex;
    const previousRange = new Set(visible.slice(Math.min(anchorIndex, previousEnd), Math.max(anchorIndex, previousEnd) + 1).map((branch) => branch.name));
    const nextRange = visible.slice(Math.min(anchorIndex, endIndex), Math.max(anchorIndex, endIndex) + 1).map((branch) => branch.name);
    selectionRange.current = { anchor, end: name };
    onSelect([...new Set([...selected.filter((selectedName) => !previousRange.has(selectedName)), ...nextRange])]);
  };
  const selectVisible = (checked: boolean) => {
    if (isSelectionDisabled) return;
    selectionRange.current = null;
    onSelect([...hiddenSelected, ...(checked ? visible.map((branch) => branch.name) : [])]);
  };

  return (
    <div className="branch-table min-w-0 space-y-3">
      <div className="branch-table-tools">
        <TextInput label="查找分支" value={query} onChange={setQuery} placeholder="输入分支名" className="min-w-0 flex-1 sm:max-w-sm" />
        <div className="branch-table-actions">
          <span role="status" className="text-sm text-muted-foreground">
            {visible.length} / {branches.length} 个分支 · <span className="branch-selection-count">已选 {selected.length} 个</span>
          </span>
          {query && <ActionIconButton icon="clear" label="清除搜索" onClick={() => setQuery("")} />}
          {selected.length > 0 && <ActionIconButton icon="deselect" label="清空选择" disabled={isSelectionDisabled} onClick={() => { selectionRange.current = null; onSelect([]); }} />}
        </div>
      </div>
      {query && multi && <p className="text-xs text-muted-foreground">全选仅作用于当前搜索结果，其他已选分支会保留。</p>}
      {visible.length === 0 ? <Empty>没有匹配的分支，请修改搜索条件。</Empty> : <Table role="grid" aria-label="本地分支" aria-multiselectable={!!multi}>
          <TableHeader>
            <TableRow><TableHead className="w-10">{multi ? <Checkbox aria-label="全选"
                checked={allVisibleSelected ? true : selectedVisible.length ? "indeterminate" : false}
                disabled={isSelectionDisabled} onCheckedChange={(checked) => selectVisible(checked === true)} /> : null}</TableHead>
            <TableHead>分支</TableHead>
            <TableHead className="whitespace-nowrap">提交</TableHead>
            <TableHead className="whitespace-nowrap">基准</TableHead>
            <TableHead className="whitespace-nowrap">相对基准</TableHead>
            {(onRebase || showPush || repoPath) && <TableHead className="whitespace-nowrap">操作</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((b) => (
              <TableRow
                key={b.name}
                aria-label={b.name}
                aria-selected={selected.includes(b.name)}
                aria-disabled={isSelectionDisabled || undefined}
                data-state={selected.includes(b.name) ? "selected" : undefined}
                tabIndex={isSelectionDisabled ? -1 : 0}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("button, input, a, [role='checkbox']")) return;
                  if (multi && event.shiftKey) extendSelection(b.name);
                  else toggleBranch(b.name);
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || isSelectionDisabled) return;
                  if (event.key === " " || event.key === "Enter") {
                    event.preventDefault();
                    toggleBranch(b.name);
                  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    const rows = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLTableRowElement>("tr"));
                    const index = rows.indexOf(event.currentTarget);
                    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
                      : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
                    if (multi && event.shiftKey) extendSelection(visible[next].name, b.name);
                    rows[next]?.focus();
                  } else if (multi && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
                    event.preventDefault();
                    selectVisible(true);
                  }
                }}
                className="branch-row"
              >
                <TableCell>
                  <Checkbox aria-label={`选择 ${b.name}`} checked={selected.includes(b.name)}
                    disabled={isSelectionDisabled} onCheckedChange={() => toggleBranch(b.name)}
                    onClick={(event) => {
                      if (multi && event.shiftKey) { event.preventDefault(); extendSelection(b.name); }
                    }} />
                </TableCell>
                <TableCell className="branch-name-cell">
                  <div className="branch-identity">
                    <span className="branch-name">
                      <span className="branch-name-text" title={b.name}>{breakAfterSlash(b.name)}</span>
                      <Button size="icon-sm" variant="ghost" className="action-icon-button shrink-0"
                        aria-label={`复制分支名 ${b.name}`}
                        onClick={() => copyBranch(b.name)}>
                        <span title={copiedBranch === b.name ? "已复制" : `复制分支名 ${b.name}`}>
                          {copiedBranch === b.name ? <CircleCheckIcon aria-hidden="true" className="size-4" /> : <Icon name="copy" />}
                          <span className="sr-only" role="status">{copiedBranch === b.name ? "分支名已复制" : ""}</span>
                        </span>
                      </Button>
                    </span>
                    <div className="branch-metadata">
                      {b.current && <Badge variant="secondary" className="branch-current">当前</Badge>}
                      {b.worktree && (
                        <span className="branch-worktree" title={b.worktree}>
                          worktree · {baseName(b.worktree)}
                        </span>
                      )}
                      {dirtyTrees.some((tree) => tree.branch === b.name) && (
                        <Badge variant="outline" className="branch-dirty" title="工作树有未提交的修改，回传只包含已提交的内容。">
                          <CircleAlertIcon aria-hidden="true" />未提交修改
                        </Badge>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Code>{shortSha(b.sha)}</Code>
                </TableCell>
                <TableCell className="branch-base-cell">
                  <Code>origin/{b.base}</Code>
                  {b.baseInferred && (
                    <span className="branch-base-inferred" title="没有记录，按分支名前缀推断">
                      推断
                    </span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <AheadBehind ahead={b.ahead} behind={b.behind} />
                </TableCell>
                {(onRebase || showPush || repoPath) && (
                  <TableCell>
                    <div className="branch-row-actions">
                      {onRebase && <ActionIconButton icon="rebase" label={`Rebase ${b.name}`}
                        disabled={actionsDisabled} title={`整理提交（Rebase）${b.name}`} onClick={() => onRebase(b)} />}
                      {showPush && <ActionIconButton icon="push" label={`检查并推送 ${b.name}`}
                        title={!onPush ? "仅内网端可推送" : pushDisabled ? "同步记录读取失败，请刷新后重试" : `检查并推送 ${b.name}`}
                        disabled={!onPush || actionsDisabled || pushDisabled} onClick={() => onPush?.(b)} />}
                      {repoPath && <ActionIconButton icon="trash" className="branch-delete"
                        aria-description={b.current || b.worktree ? "分支正在工作树中使用，暂不能删除" : undefined}
                        title={`删除本地分支 ${b.name}${b.current || b.worktree ? "（正在使用，暂不能删除）" : ""}`}
                        disabled={actionsDisabled || b.current || !!b.worktree} label={`删除本地分支 ${b.name}`} onClick={() => deleteBranch(b)} />}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
    </Table>}
    </div>
  );
}

/** 路径的最后一段，用于在分支表里简短标出 worktree */
function baseName(p: string) {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}

/** 分支名在 “/” 后允许换行（“-” 本身就是换行点），避免从单词中间断开 */
function breakAfterSlash(name: string) {
  const parts = name.split("/");
  return parts.flatMap((part, i) => (i < parts.length - 1 ? [part + "/", <wbr key={i} />] : [part]));
}

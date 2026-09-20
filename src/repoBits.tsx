import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Alert, Checkbox, Chip, Table } from "@heroui/react";
import type { Selection } from "@heroui/react";
import { api, BranchInfo, InProgressOp, OpOutcome, RepoStatus, shortSha } from "./api";
import { useRunner } from "./runner";
import { ActionButton, Code, Empty, Notice } from "./ui";

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
        if (!focused) return;
        clearTimeout(timer);
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

/**
 * 读取仓库状态；path 为空时返回 null。
 * loading：正在读取；error：读取失败的原因（不再静默当作“仓库不存在”）。
 */
export function useRepoStatus(path: string | undefined, baseBranch: string, releaseBranches: string[]) {
  // 数组每次渲染都是新对象，用字符串作依赖
  const releasesKey = releaseBranches.join("\n");
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 只采用最后一次请求的结果，避免较慢的旧请求覆盖新结果
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const id = ++seq.current;
    if (!path) {
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const st = await api.repoStatus(path, baseBranch, releasesKey ? releasesKey.split("\n") : []);
      if (id !== seq.current) return;
      setStatus(st);
      setError(null);
    } catch (e) {
      if (id !== seq.current) return;
      setStatus(null);
      setError(String(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [path, baseBranch, releasesKey]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { status, loading, error, reload };
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
    <Alert status="warning">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>
          {main ? "仓库中" : `worktree ${baseName(path)}`} 有未完成的 {op}
          {branch && <span className="ml-1 font-mono text-xs">（{branch}）</span>}
        </Alert.Title>
        <Alert.Description>
          在 <code className="font-mono break-all">{path}</code> 里解决冲突并执行{" "}
          <code className="font-mono">git add</code> 后点“继续”，或点“中止”回到操作前的状态。
        </Alert.Description>
      </Alert.Content>
      <div className="flex shrink-0 items-center gap-2 self-center">
        <ActionButton size="sm" variant="secondary" onPress={async () => onDone(await run(`继续 ${op}`, () => api.continueOp(path)))}>
          继续
        </ActionButton>
        <ActionButton size="sm" variant="danger-soft" onPress={async () => onDone(await run(`中止 ${op}`, () => api.abortOp(path)))}>
          中止
        </ActionButton>
      </div>
    </Alert>
  );
}

/** 分支表：HeroUI Table，单选或多选。 */
export function BranchTable({
  branches,
  selected,
  onSelect,
  multi,
  isSelectable,
  emptyText = "没有本地分支",
}: {
  branches: BranchInfo[];
  selected: string[];
  onSelect: (names: string[]) => void;
  multi?: boolean;
  isSelectable?: (b: BranchInfo) => boolean;
  emptyText?: string;
}) {
  if (branches.length === 0) return <Empty>{emptyText}</Empty>;

  const disabledKeys = isSelectable ? branches.filter((b) => !isSelectable(b)).map((b) => b.name) : [];
  const onSelectionChange = (keys: Selection) => {
    if (keys === "all") {
      onSelect(branches.filter((b) => !disabledKeys.includes(b.name)).map((b) => b.name));
    } else {
      onSelect([...keys].map(String));
    }
  };

  return (
    <Table variant="secondary">
      <Table.ScrollContainer>
        <Table.Content
          aria-label="本地分支"
          selectionMode={multi ? "multiple" : "single"}
          selectionBehavior="toggle"
          selectedKeys={new Set(selected)}
          onSelectionChange={onSelectionChange}
          disabledKeys={disabledKeys}
        >
          <Table.Header>
            <Table.Column className="w-10">{multi ? <SelectionBox label="全选" /> : null}</Table.Column>
            <Table.Column isRowHeader>分支</Table.Column>
            <Table.Column className="whitespace-nowrap">提交</Table.Column>
            <Table.Column className="whitespace-nowrap">基准</Table.Column>
            <Table.Column className="whitespace-nowrap">相对基准</Table.Column>
          </Table.Header>
          <Table.Body>
            {branches.map((b) => (
              <Table.Row
                key={b.name}
                id={b.name}
                className="transition-colors data-[selected=true]:bg-accent/[0.06] data-[selected=true]:[&_td]:bg-transparent"
              >
                <Table.Cell>
                  <SelectionBox label={`选择 ${b.name}`} />
                </Table.Cell>
                <Table.Cell className="break-words">
                  <span className="font-medium">{breakAfterSlash(b.name)}</span>
                  {b.current && (
                    <Chip size="sm" variant="secondary" className="ml-2">
                      当前
                    </Chip>
                  )}
                  {b.worktree && (
                    <Chip size="sm" variant="tertiary" className="ml-2" title={b.worktree}>
                      worktree · {baseName(b.worktree)}
                    </Chip>
                  )}
                </Table.Cell>
                <Table.Cell className="whitespace-nowrap">
                  <Code>{shortSha(b.sha)}</Code>
                </Table.Cell>
                <Table.Cell className="whitespace-nowrap">
                  <Code>origin/{b.base}</Code>
                  {b.baseInferred && (
                    <span className="ml-1.5 text-xs text-muted" title="没有记录，按分支名前缀推断">
                      推断
                    </span>
                  )}
                </Table.Cell>
                <Table.Cell className="whitespace-nowrap">
                  <span className="inline-flex gap-2 font-mono text-xs">
                    <span className={b.ahead > 0 ? "font-semibold text-success" : "text-muted"}>↑{b.ahead}</span>
                    <span className={b.behind > 0 ? "font-semibold text-warning" : "text-muted"}>↓{b.behind}</span>
                  </span>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}

/**
 * 有未提交修改的工作树提示。
 *
 * 分支常常是在 linked worktree 里开发的，只看主工作树会漏掉那里的改动，
 * 而那些改动同样进不了回传包。
 */
export function DirtyTreesNotice({ status, suffix }: { status: RepoStatus | null; suffix: string }) {
  const trees = status?.dirtyTrees ?? [];
  if (trees.length === 0) return null;
  const names = trees.map((w) => (w.branch ? `${w.branch}（${baseName(w.path)}）` : baseName(w.path)));
  return (
    <Notice tone="warning" title={`${names.join("、")} 有未提交的修改，${suffix}`}>
      {trees.map((w) => (
        <span key={w.path} className="block font-mono text-xs break-all">
          {w.path}
        </span>
      ))}
    </Notice>
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

/** 表格行选择框：slot="selection" 由 Table 接管选中状态 */
function SelectionBox({ label }: { label: string }) {
  return (
    <Checkbox slot="selection" aria-label={label}>
      <Checkbox.Control>
        <Checkbox.Indicator />
      </Checkbox.Control>
    </Checkbox>
  );
}

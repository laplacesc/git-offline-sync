import { useCallback, useEffect, useState } from "react";
import { Alert, Checkbox, Chip, Table } from "@heroui/react";
import type { Selection } from "@heroui/react";
import { api, BranchInfo, OpOutcome, RepoStatus, shortSha } from "./api";
import { useRunner } from "./runner";
import { ActionButton, Code, Empty } from "./ui";

/** 读取仓库状态；path 为空时返回 null。 */
export function useRepoStatus(path: string | undefined, baseBranch: string, releaseBranches: string[]) {
  // 数组每次渲染都是新对象，用字符串作依赖
  const releasesKey = releaseBranches.join("\n");
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const reload = useCallback(async () => {
    if (!path) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await api.repoStatus(path, baseBranch, releasesKey ? releasesKey.split("\n") : []));
    } catch {
      setStatus(null);
    }
  }, [path, baseBranch, releasesKey]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { status, reload };
}

/** 仓库里有未完成的 rebase / am 时显示，提供继续与中止。 */
export function InProgressBanner({
  repo,
  status,
  onDone,
}: {
  repo: string;
  status: RepoStatus | null;
  onDone: (o?: OpOutcome) => void;
}) {
  const { run } = useRunner();
  if (!status?.inProgress) return null;
  const op = status.inProgress;
  return (
    <Alert status="warning">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>仓库中有未完成的 {op}</Alert.Title>
        <Alert.Description>
          在编辑器中解决冲突并执行 <code className="font-mono">git add</code> 后点“继续”，或点“中止”回到操作前的状态。
        </Alert.Description>
      </Alert.Content>
      <div className="flex shrink-0 items-center gap-2 self-center">
        <ActionButton size="sm" variant="secondary" onPress={async () => onDone(await run(`继续 ${op}`, () => api.continueOp(repo)))}>
          继续
        </ActionButton>
        <ActionButton size="sm" variant="danger-soft" onPress={async () => onDone(await run(`中止 ${op}`, () => api.abortOp(repo)))}>
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
            <Table.Column>提交</Table.Column>
            <Table.Column>基准</Table.Column>
            <Table.Column>相对基准</Table.Column>
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
                <Table.Cell>
                  <span className="font-medium">{b.name}</span>
                  {b.current && (
                    <Chip size="sm" variant="secondary" className="ml-2">
                      当前
                    </Chip>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <Code>{shortSha(b.sha)}</Code>
                </Table.Cell>
                <Table.Cell>
                  <Code>origin/{b.base}</Code>
                  {b.baseInferred && (
                    <span className="ml-1.5 text-xs text-muted" title="没有记录，按分支名前缀推断">
                      推断
                    </span>
                  )}
                </Table.Cell>
                <Table.Cell>
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

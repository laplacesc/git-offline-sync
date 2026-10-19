/**
 * 应用级组合组件：全部基于 HeroUI v3，只在这里做一次“设计系统化”的组合，
 * 页面代码直接使用这些组件，避免到处写一次性样式。
 */
import { createContext, ReactNode, useContext, useId, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Button,
  Card,
  Checkbox,
  Chip,
  Description,
  Disclosure,
  EmptyState,
  Input,
  InputGroup,
  Label,
  ListBox,
  Select,
  Separator,
  Surface,
  TextField,
  FieldError,
  Fieldset,
  Meter,
  Typography,
  Tabs,
} from "@heroui/react";
import type { ButtonProps } from "@heroui/react";
import { DateTime } from "./DateTime";
import { BundleKind, CommitInfo, KIND_LABEL, OpOutcome, shortSha } from "./api";
import { useRunner } from "./runner";
import { Icon } from "./icons";
export { Notice, type Tone } from "./Notice";

// ---------------------------------------------------------------------------
// 按钮：全局串行执行，有操作进行中时自动禁用
// ---------------------------------------------------------------------------

export function ActionButton({ isDisabled, ...props }: ButtonProps) {
  const { busy } = useRunner();
  return <Button {...props} isDisabled={!!isDisabled || !!busy} />;
}

/** 卡片右上角的刷新按钮：重新读取仓库状态与传输目录 */
export function RefreshButton({ onPress }: { onPress: () => unknown }) {
  const { run } = useRunner();
  return <ActionButton size="sm" variant="ghost" onPress={() => run("刷新", async () => onPress())}>刷新</ActionButton>;
}

/** 业务折叠区只组合原生插槽，展开、键盘和焦点由 Disclosure 管理。 */
export function Fold({ title, children, className = "", defaultExpanded = false }: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  defaultExpanded?: boolean;
}) {
  return <Disclosure className={`fold ${className}`} defaultExpanded={defaultExpanded}>
    <Disclosure.Heading>
      <Disclosure.Trigger><Disclosure.Indicator />{title}</Disclosure.Trigger>
    </Disclosure.Heading>
    <Disclosure.Content><Disclosure.Body>{children}</Disclosure.Body></Disclosure.Content>
  </Disclosure>;
}

const WorkflowContext = createContext<{ step: number; select: (step: number) => void; id: string } | null>(null);

/** Keep panels mounted so switching steps preserves input and branch selection. */
export function Workflow({ children }: { children: ReactNode }) {
  const [step, select] = useState(1);
  const id = useId();
  return <WorkflowContext.Provider value={{ step, select, id }}>
    <Tabs className="workflow-layout" selectedKey={String(step)} onSelectionChange={(key) => select(Number(key))}>{children}</Tabs>
  </WorkflowContext.Provider>;
}

export function WorkflowNav({ steps, counts = [] }: { steps: string[]; counts?: (number | undefined)[] }) {
  const flow = useContext(WorkflowContext)!;
  return <nav aria-label="同步流程">
    <Tabs.List aria-label="同步步骤" className="workflow-nav">
      {steps.map((title, i) => <Tabs.Tab key={title} id={String(i + 1)} data-workflow-tab={`${flow.id}-${i + 1}`}>
        <span className="workflow-nav-number" aria-hidden="true">{i + 1}</span>{title}
        {counts[i] !== undefined && <span className="counter">{counts[i]}</span>}
        <Tabs.Indicator />
      </Tabs.Tab>)}
    </Tabs.List>
  </nav>;
}

export function WorkflowJump({ step, children }: { step: number; children: ReactNode }) {
  const flow = useContext(WorkflowContext)!;
  return <Button size="sm" variant="outline" onPress={() => {
    flow.select(step);
    document.querySelector<HTMLElement>(`[data-workflow-tab="${flow.id}-${step}"]`)?.focus();
  }}>{children}</Button>;
}

type PipelineNode = { title: string; detail: string; step: number; icon: Parameters<typeof Icon>[0]["name"] };
export function Pipeline({ lanes, next, onRefresh }: {
  lanes: { label: string; nodes: PipelineNode[]; commands: string[] }[];
  next: { title: string; detail: string; step: number };
  onRefresh: () => unknown;
}) {
  const flow = useContext(WorkflowContext)!;
  const [expanded, setExpanded] = useState(false);
  return <Disclosure className="pipeline" aria-label="同步链路总览" isExpanded={expanded} onExpandedChange={setExpanded}>
    <div className="pipeline-next"><span className="next-step-mark" aria-hidden="true"><Icon name="chevron" /></span>
      <div className="next-step-copy" aria-live="polite"><span className="section-label">建议下一步</span><strong>{next.title}</strong><p>{next.detail}</p></div>
      <WorkflowJump step={next.step}>前往处理<Icon name="chevron" /></WorkflowJump>
    </div>
    <div className="pipeline-header"><h2>同步链路总览</h2><div className="flex items-center gap-2">
      <Disclosure.Heading><Disclosure.Trigger>{expanded ? "收起链路" : "展开链路"}<Disclosure.Indicator /></Disclosure.Trigger></Disclosure.Heading>
      <RefreshButton onPress={onRefresh} />
    </div></div>
    <Disclosure.Content className="pipeline-details"><Disclosure.Body>
    {lanes.map((lane) => <div className="pipeline-lane" key={lane.label}>
      <span className="pipeline-label">{lane.label}</span>
      {lane.nodes.map((node, i) => <div className="pipeline-segment" key={i}>
        {i > 0 && <span className="pipeline-arrow"><code>{lane.commands[i - 1]}</code><span aria-hidden="true">⟶</span></span>}
        <Button variant="ghost" className="pipeline-node" onPress={() => {
          flow.select(node.step);
          document.querySelector<HTMLElement>(`[data-workflow-tab="${flow.id}-${node.step}"]`)?.focus();
        }}><span><Icon name={node.icon} />{node.title}</span><small title={node.detail}>{node.detail}</small></Button>
      </div>)}
    </div>)}
    </Disclosure.Body></Disclosure.Content>
  </Disclosure>;
}

export function AheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
  const total = Math.max(ahead + behind, 1);
  return <Meter className="ahead-behind" aria-label="分支提交差异" aria-valuetext={`落后 ${behind} 个提交，领先 ${ahead} 个提交`} value={behind} maxValue={total}>
    <span className={behind ? "text-warning" : "text-muted"}>↓{behind}</span>
    <Meter.Track className="ahead-behind-track" data-has-ahead={ahead > 0}><Meter.Fill className="ahead-behind-fill" /></Meter.Track>
    <span className={ahead ? "text-success" : "text-muted"}>↑{ahead}</span>
  </Meter>;
}

/** Only show observed sequences and the immediate next expected number. */
export function SeqChain({ last, sequences }: { last: number; sequences: number[] }) {
  const visible = [...new Set([last, last + 1, ...sequences])].filter((n) => n > 0 && n >= last).sort((a, b) => a - b).slice(0, 8);
  return <div className="seq-chain" aria-label="导入序号链">
    <span>导入进度</span>{visible.map((n, i) => <span key={n} className="seq-item">
      {i > 0 && n > visible[i - 1] + 1 && <span className="seq-gap">缺 #{visible[i - 1] + 1}{n > visible[i - 1] + 2 ? `–${n - 1}` : ""}</span>}
      <span className={n <= last ? "seq-done" : sequences.includes(n) ? "seq-available" : "seq-gap"}>
        #{n} · {n <= last ? "已导入" : sequences.includes(n) ? "待检查" : "未找到"}
      </span>
    </span>)}
  </div>;
}

/** Quiet section metadata, shared by configuration pages. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <span className="section-label">{children}</span>;
}

// ---------------------------------------------------------------------------
// 流程步骤卡片
// ---------------------------------------------------------------------------

export function StepCard({
  step,
  label,
  title,
  description,
  actions,
  children,
}: {
  step: number;
  label: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const flow = useContext(WorkflowContext);
  const card = (
    <Card aria-label={title} className="workflow-step gap-0 p-0">
      <Card.Header className="step-header">
        <div className="flex min-w-0 flex-1 gap-3">
          <span className="step-number" aria-hidden="true">{step}</span>
          <div className="min-w-0 space-y-1">
            <span className="sr-only">{label}</span>
            <Card.Title>{title}</Card.Title>
            {description && <Card.Description className="text-muted">{description}</Card.Description>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </Card.Header>
      <Card.Content className="step-content">{children}</Card.Content>
    </Card>
  );
  return flow ? <Tabs.Panel id={String(step)} shouldForceMount style={({ isInert }) => ({ display: isInert ? "none" : undefined })}>{card}</Tabs.Panel> : card;
}

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------

export function TextInput({
  label,
  value,
  onChange,
  description,
  placeholder,
  isReadOnly,
  mono,
  className,
  id,
  error,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  description?: string;
  placeholder?: string;
  isReadOnly?: boolean;
  mono?: boolean;
  className?: string;
  id?: string;
  error?: string;
}) {
  return (
    <TextField id={id} value={value} onChange={onChange} isReadOnly={isReadOnly} isInvalid={!!error} fullWidth className={className}>
      <Label>{label}</Label>
      <Input name={id ?? label} autoComplete="off" placeholder={placeholder} spellCheck={false} className={mono ? "font-mono text-[13px]" : undefined} />
      {description && <Description>{description}</Description>}
      {error && <FieldError>{error}</FieldError>}
    </TextField>
  );
}

/** 基准分支下拉框：主线在前，发布分支在后。 */
export function BaseSelect({
  label,
  value,
  options,
  onChange,
  mainline,
  className,
  hideLabel,
  isDisabled,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  /** 主线分支名，用于在选项里标注“主线 / 发布” */
  mainline: string;
  className?: string;
  /** 只保留给读屏器的标签（行内使用时） */
  hideLabel?: boolean;
  isDisabled?: boolean;
}) {
  // 记录的基准不在配置档列表里时（如发布分支已从配置中移除），也要能显示
  const all = options.includes(value) || !value ? options : [...options, value];
  function roleOf(branch: string) {
    if (branch === mainline) return "主线";
    return options.includes(branch) ? "发布" : "未配置";
  }
  return (
    <Select
      className={className ?? "w-56"}
      isDisabled={isDisabled}
      value={value}
      onChange={(k) => k != null && onChange(String(k))}
    >
      <Label className={hideLabel ? "sr-only" : undefined}>{label}</Label>
      <Select.Trigger className="font-mono text-[13px]">
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {all.map((b) => (
            <ListBox.Item key={b} id={b} textValue={b}>
              <span className="font-mono text-[13px]">{b}</span>
              <span className="ml-auto pr-6 pl-3 text-xs text-muted">{roleOf(b)}</span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export function PathInput({
  label,
  value,
  onChange,
  directory = true,
  extensions,
  placeholder,
  description,
  id,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  directory?: boolean;
  extensions?: string[];
  placeholder?: string;
  description?: string;
  id?: string;
  error?: string;
}) {
  const browse = async () => {
    const picked = await open({
      directory,
      multiple: false,
      defaultPath: value || undefined,
      filters: extensions ? [{ name: extensions.join(", "), extensions }] : undefined,
    });
    if (typeof picked === "string") onChange(picked);
  };
  return (
    <TextField id={id} value={value} onChange={onChange} isInvalid={!!error} fullWidth>
      <Label>{label}</Label>
      <InputGroup fullWidth>
        <InputGroup.Input name={id ?? label} autoComplete="off" placeholder={placeholder} spellCheck={false} className="font-mono text-[13px]" />
        <InputGroup.Suffix className="pr-1">
          <Button size="sm" variant="ghost" onPress={browse} aria-label={`浏览${label}`}>
            浏览…
          </Button>
        </InputGroup.Suffix>
      </InputGroup>
      {description && <Description>{description}</Description>}
      {error && <FieldError>{error}</FieldError>}
    </TextField>
  );
}

export function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Checkbox isSelected={checked} onChange={onChange}>
      <Checkbox.Content className="text-sm">
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        {children}
      </Checkbox.Content>
    </Checkbox>
  );
}

// ---------------------------------------------------------------------------
// 状态展示
// ---------------------------------------------------------------------------

const KIND_COLOR: Record<BundleKind, "accent" | "success" | "warning" | "default"> = {
  full: "accent",
  incr: "success",
  back: "warning",
  patch: "default",
};

export function KindChip({ kind }: { kind: BundleKind | null }) {
  return (
    <Chip size="sm" variant="soft" color={kind ? KIND_COLOR[kind] : "default"} className="shrink-0 font-medium">
      {kind ? KIND_LABEL[kind] : "未知"}
    </Chip>
  );
}

export function OutcomeView({ outcome }: { outcome: OpOutcome }) {
  if (outcome.ok || outcome.files.length === 0) return null;
  return <div className="mt-1 flex flex-wrap items-center gap-1.5">
    <span>{outcome.conflict ? "冲突文件：" : "相关文件："}</span>
    {outcome.files.map((file) => <Chip key={file} size="sm" variant="secondary" className="font-mono">{file}</Chip>)}
  </div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <EmptyState className="px-0 py-1">{children}</EmptyState>;
}

/** 带分隔线的只读列表容器 */
export function ListSurface({ children }: { children: ReactNode[] }) {
  return (
    <Surface variant="default" className="list-surface overflow-hidden rounded-2xl border border-border">
      {children.map((c, i) => (
        <div key={i}>
          {i > 0 && <Separator />}
          {c}
        </div>
      ))}
    </Surface>
  );
}

export function CommitList({ commits, empty = "没有提交" }: { commits: CommitInfo[]; empty?: string }) {
  if (commits.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="max-h-72 overflow-y-auto rounded-2xl">
      <ListSurface>
        {commits.map((c) => (
          <div key={c.sha} className="commit-row">
            <Code className="commit-sha">{shortSha(c.sha)}</Code>
            <span className="text-sm font-medium">{c.subject}</span>
            <div className="commit-author text-xs text-muted">
              {c.author} &lt;{c.email}&gt; · <DateTime value={c.date} label="提交时间" />
            </div>
          </div>
        ))}
      </ListSurface>
    </div>
  );
}

export function Code({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <Typography.Code className={"rounded-2xl bg-default px-1.5 py-0.5 font-mono text-[12px] break-all text-foreground " + className}>
      {children}
    </Typography.Code>
  );
}

/** 传输目录中的一个包。highlight = 下一个应导入的包，dim = 已处理。 */
export function PackageRow({
  kind,
  title,
  meta,
  highlight,
  dim,
  children,
}: {
  kind: BundleKind | null;
  title: string;
  meta: ReactNode;
  highlight?: boolean;
  dim?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={
        "package-row flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl px-4 py-3 transition-colors " +
        (highlight ? "selected-surface " : "border border-border bg-surface ") +
        (dim ? "package-done" : "")
      }
    >
      <div className="package-identity flex min-w-0 flex-1 items-center gap-3">
        <KindChip kind={kind} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[13px]" title={title}>
            {title}
          </div>
          <div className="text-xs text-muted">{meta}</div>
        </div>
      </div>
      {/* 空间不够时整组控件换到标题下方并靠右 */}
      {children && <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{children}</div>}
    </div>
  );
}

/** 应用标志符号：与应用图标（assets/icon/*.svg）同一图形，颜色跟随 currentColor */
export function AppGlyph({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="236 300 552 424" className={className} aria-hidden fill="none">
      <g stroke="currentColor" strokeWidth={58} strokeLinecap="round" strokeLinejoin="round">
        <path d="M372 420 H692" />
        <path d="M616 344 L692 420 L616 496" />
        <path d="M652 604 H332" />
        <path d="M408 528 L332 604 L408 680" />
      </g>
      <g fill="currentColor">
        <circle cx="316" cy="420" r="50" />
        <circle cx="708" cy="604" r="50" />
      </g>
    </svg>
  );
}

/** 配置与设置共用的分组布局，说明列与字段列随可用宽度切换。 */
export function FormSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const titleId = useId();
  return <Fieldset<"section"> render={(props) => <section {...props} />} role="group" aria-labelledby={titleId} className="form-section">
    <div className="space-y-1">
      <Fieldset.Legend<"h2"> render={(props) => <h2 {...props} />} id={titleId} className="text-base font-semibold">{title}</Fieldset.Legend>
      <Description className="text-sm leading-relaxed text-muted">{description}</Description>
    </div>
    <Fieldset.Group className="min-w-0">{children}</Fieldset.Group>
  </Fieldset>;
}

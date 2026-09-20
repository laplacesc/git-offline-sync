/**
 * 应用级组合组件：全部基于 HeroUI v3，只在这里做一次“设计系统化”的组合，
 * 页面代码直接使用这些组件，避免到处写一次性样式。
 */
import { ReactNode, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Chip,
  Description,
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
  Spinner,
} from "@heroui/react";
import type { ButtonProps } from "@heroui/react";
import { BundleKind, CommitInfo, KIND_LABEL, OpOutcome, shortSha } from "./api";
import { useRunner } from "./runner";

// ---------------------------------------------------------------------------
// 按钮：全局串行执行，有操作进行中时自动禁用
// ---------------------------------------------------------------------------

export function ActionButton({ isDisabled, ...props }: ButtonProps) {
  const { busy } = useRunner();
  return <Button {...props} isDisabled={!!isDisabled || !!busy} />;
}

/** 卡片右上角的刷新按钮：重新读取仓库状态与传输目录 */
export function RefreshButton({ onPress }: { onPress: () => unknown }) {
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const { notify } = useRunner();
  async function refresh() {
    if (running.current) return;
    running.current = true;
    setPending(true);
    try {
      await onPress();
    } catch (error) {
      notify("error", `刷新失败：${String(error)}`);
    } finally {
      running.current = false;
      setPending(false);
    }
  }
  return (
    <ActionButton size="sm" variant="ghost" onPress={refresh} isDisabled={pending} aria-busy={pending}>
      {pending && <Spinner size="sm" />}{pending ? "刷新中…" : "刷新"}
    </ActionButton>
  );
}

export function WorkflowNav({ steps }: { steps: string[] }) {
  return (
    <nav aria-label="同步流程" className="workflow-nav grid grid-cols-2 gap-1 rounded-xl border border-border bg-surface p-2">
      {steps.map((title, i) => (
        <a key={title} href={`#step-${i + 1}`} className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-default hover:text-foreground"
          onClick={(event) => {
            event.preventDefault();
            const target = document.getElementById(`step-${i + 1}`);
            target?.scrollIntoView({ block: "start" });
            target?.focus({ preventScroll: true });
          }}>
          <span className="mr-2 font-mono text-accent">{i + 1}</span>{title}
        </a>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// 区块标签：圆角胶囊 + 圆点 + 等宽大写文字（设计系统的 Section Label）
// ---------------------------------------------------------------------------

export function SectionLabel({
  children,
  pulse,
}: {
  children: ReactNode;
  pulse?: boolean;
}) {
  return (
    <span className="inline-flex w-fit items-center gap-2 self-start rounded-full border border-accent/30 bg-accent/5 px-3 py-1">
      <span className={"size-1.5 rounded-full bg-accent " + (pulse ? "animate-pulse-dot" : "")} />
      <span className="font-mono text-[11px] tracking-[0.15em] text-accent uppercase">
        {children}
      </span>
    </span>
  );
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
  return (
    <Card id={`step-${step}`} tabIndex={-1} aria-label={title} className="workflow-step scroll-mt-4 gap-0 p-0">
      <Card.Header className="flex flex-row flex-wrap items-start gap-3 px-5 pt-5 pb-4">
        <div className="flex min-w-0 flex-1 gap-3">
          <span className="step-number" aria-hidden="true">{String(step).padStart(2, "0")}</span>
          <div className="min-w-0 space-y-1">
            <span className="sr-only">{label}</span>
            <Card.Title className="text-base font-semibold">{title}</Card.Title>
            {description && <Card.Description className="text-sm leading-relaxed text-muted">{description}</Card.Description>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </Card.Header>
      <Card.Content className="flex min-w-0 flex-col gap-4 px-5 pb-5">{children}</Card.Content>
    </Card>
  );
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
      <Input placeholder={placeholder} spellCheck={false} className={mono ? "font-mono text-[13px]" : undefined} />
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
        <InputGroup.Input placeholder={placeholder} spellCheck={false} className="font-mono text-[13px]" />
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

export type Tone = "success" | "warning" | "danger" | "accent" | "default";

export function Notice({ tone, title, children }: { tone: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <Alert status={tone}>
      <Alert.Indicator />
      <Alert.Content>
        {title && <Alert.Title>{title}</Alert.Title>}
        {children && <Alert.Description className="break-words">{children}</Alert.Description>}
      </Alert.Content>
    </Alert>
  );
}

export function OutcomeView({ outcome }: { outcome: OpOutcome }) {
  if (outcome.ok) return <Notice tone="success" title={outcome.message} />;
  return (
    <Notice tone={outcome.conflict ? "warning" : "danger"} title={outcome.message}>
      {outcome.files.length > 0 && (
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          冲突文件：
          {outcome.files.map((f) => (
            <Chip key={f} size="sm" variant="secondary" className="font-mono">
              {f}
            </Chip>
          ))}
        </span>
      )}
    </Notice>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <EmptyState className="px-0 py-1">{children}</EmptyState>;
}

/** 带分隔线的只读列表容器 */
export function ListSurface({ children }: { children: ReactNode[] }) {
  return (
    <Surface variant="default" className="overflow-hidden rounded-xl border border-border shadow-none">
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
    <div className="max-h-72 overflow-y-auto rounded-xl">
      <ListSurface>
        {commits.map((c) => (
          <div key={c.sha} className="grid grid-cols-[auto_1fr] gap-x-3 px-4 py-2.5">
            <Code>{shortSha(c.sha)}</Code>
            <span className="truncate text-sm font-medium">{c.subject}</span>
            <span className="col-start-2 text-xs text-muted">
              {c.author} &lt;{c.email}&gt; · {c.date}
            </span>
          </div>
        ))}
      </ListSurface>
    </div>
  );
}

export function Code({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <code className={"rounded-md bg-default px-1.5 py-0.5 font-mono text-[12px] break-all text-foreground " + className}>
      {children}
    </code>
  );
}

/** 传输目录中的一个包。highlight = 下一个应导入的包（渐变描边），dim = 已处理 */
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
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-3 transition-shadow " +
        (highlight ? "gradient-border shadow-accent " : "border border-border bg-surface ") +
        (dim ? "opacity-55" : "")
      }
    >
      <div className="flex min-w-64 flex-1 items-center gap-3">
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
  return <section className="form-section">
    <div className="space-y-1">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm leading-relaxed text-muted">{description}</p>
    </div>
    <div className="min-w-0">{children}</div>
  </section>;
}

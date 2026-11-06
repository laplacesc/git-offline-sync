import { type ComponentProps, type ReactNode, useId } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronRight } from "lucide-react";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Checkbox } from "./components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { Empty as EmptyState, EmptyDescription } from "./components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "./components/ui/field";
import { Input } from "./components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Separator } from "./components/ui/separator";
import { cn } from "./lib/utils";
import { DateTime } from "./DateTime";
import { CommitInfo, OpOutcome, shortSha } from "./api";
import { useRunner } from "./runner";
import { Icon, type IconName } from "./icons";
export { Notice, type Tone } from "./Notice";

type ButtonProps = ComponentProps<typeof Button>;

/** 操作进行中时，统一禁用会修改仓库的按钮。 */
export function ActionButton({ disabled, type = "button", ...props }: ButtonProps) {
  const { busy } = useRunner();
  return <Button {...props} type={type} disabled={disabled || !!busy} />;
}

export function ActionIconButton({ icon, label, title = label, className, ...props }: Omit<ButtonProps, "children" | "aria-label"> & {
  icon: IconName; label: string; title?: string;
}) {
  return <ActionButton variant="ghost" size="icon-sm" {...props} className={cn("action-icon-button", className)} aria-label={label} title={title}>
    <Icon name={icon} />
  </ActionButton>;
}

export function RefreshButton({ onClick, loading = false, label = "刷新" }: {
  onClick: () => unknown; loading?: boolean; label?: string;
}) {
  return <ActionButton size="sm" variant="ghost" disabled={loading} aria-busy={loading}
    onClick={() => void onClick()}>{label}</ActionButton>;
}

export function Fold({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return <Collapsible className={cn("fold", className)}>
    <CollapsibleTrigger className="fold-trigger"><ChevronRight aria-hidden />{title}</CollapsibleTrigger>
    <CollapsibleContent className="fold-content">{children}</CollapsibleContent>
  </Collapsible>;
}

export function AheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
  const total = Math.max(ahead + behind, 1);
  return <span className="ahead-behind" role="meter" aria-label="分支提交差异" aria-valuemin={0} aria-valuemax={total} aria-valuenow={behind}
    aria-valuetext={`落后 ${behind} 个提交，领先 ${ahead} 个提交`}>
    <span className={behind ? "text-warning" : "text-muted-foreground"}>↓{behind}</span>
    <span className="ahead-behind-track" data-has-ahead={ahead > 0}><span className="ahead-behind-fill" style={{ width: `${behind / total * 100}%` }} /></span>
    <span className={ahead ? "text-success" : "text-muted-foreground"}>↑{ahead}</span>
  </span>;
}

export function TextInput({ label, value, onChange, description, placeholder, readOnly, className, id, error }: {
  label: string; value: string; onChange?: (v: string) => void; description?: string; placeholder?: string;
  readOnly?: boolean; className?: string; id?: string; error?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const describedBy = [description && `${inputId}-description`, error && `${inputId}-error`].filter(Boolean).join(" ") || undefined;
  return <Field className={className} data-invalid={!!error}>
    <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
    <Input id={inputId} name={id ?? label} autoComplete="off" placeholder={placeholder} spellCheck={false} readOnly={readOnly}
      value={value} onChange={(event) => onChange?.(event.target.value)} aria-invalid={!!error} aria-describedby={describedBy} />
    {description && <FieldDescription id={`${inputId}-description`}>{description}</FieldDescription>}
    {error && <FieldError id={`${inputId}-error`}>{error}</FieldError>}
  </Field>;
}

/** 记录的基准不在配置列表里时，也保留显示。 */
export function BaseSelect({ label, value, options, onChange, mainline, className, disabled }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void; mainline: string; className?: string; disabled?: boolean;
}) {
  const id = useId();
  const all = options.includes(value) || !value ? options : [...options, value];
  return <Field className={className ?? "w-56"} data-disabled={disabled}>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <Select disabled={disabled} value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full"><SelectValue placeholder="选择基准分支" /></SelectTrigger>
      <SelectContent><SelectGroup>{all.map((branch) => <SelectItem key={branch} value={branch}>
        <span>{branch}</span>
        <span className="ml-auto pl-3 text-xs text-muted-foreground">{branch === mainline ? "主线" : options.includes(branch) ? "发布" : "未配置"}</span>
      </SelectItem>)}</SelectGroup></SelectContent>
    </Select>
  </Field>;
}

export function PathInput({ label, value, onChange, directory = true, placeholder, description, id, error }: {
  label: string; value: string; onChange: (v: string) => void; directory?: boolean; placeholder?: string; description?: string; id?: string; error?: string;
}) {
  const { notify } = useRunner();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const describedBy = [description && `${inputId}-description`, error && `${inputId}-error`].filter(Boolean).join(" ") || undefined;
  const browse = async () => {
    try {
      const picked = await open({ directory, multiple: false, defaultPath: value || undefined });
      if (typeof picked === "string") onChange(picked);
    } catch (error) {
      notify("error", `打开路径选择器失败：${String(error)}`);
    }
  };
  return <Field data-invalid={!!error}>
    <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
    <InputGroup>
      <InputGroupInput id={inputId} name={id ?? label} autoComplete="off" placeholder={placeholder} spellCheck={false} value={value}
        onChange={(event) => onChange(event.target.value)} aria-invalid={!!error} aria-describedby={describedBy} />
      <InputGroupAddon align="inline-end"><InputGroupButton size="sm" onClick={browse} aria-label={`浏览${label}`}>浏览…</InputGroupButton></InputGroupAddon>
    </InputGroup>
    {description && <FieldDescription id={`${inputId}-description`}>{description}</FieldDescription>}
    {error && <FieldError id={`${inputId}-error`}>{error}</FieldError>}
  </Field>;
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  const id = useId();
  return <Field orientation="horizontal">
    <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
    <FieldLabel htmlFor={id}>{children}</FieldLabel>
  </Field>;
}

export function OutcomeView({ outcome }: { outcome: OpOutcome }) {
  if (outcome.ok || outcome.files.length === 0) return null;
  return <div className="mt-1 flex flex-wrap items-center gap-1.5">
    <span>{outcome.conflict ? "冲突文件：" : "相关文件："}</span>
    {outcome.files.map((file) => <Badge key={file} variant="secondary" className="font-mono">{file}</Badge>)}
  </div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <EmptyState className="empty-state border-0 px-0 py-1"><EmptyDescription>{children}</EmptyDescription></EmptyState>;
}

function ListSurface({ children }: { children: ReactNode[] }) {
  return <div className="list-surface overflow-hidden rounded-lg border">
    {children.map((child, index) => <div key={index}>{index > 0 && <Separator />}{child}</div>)}
  </div>;
}

export function CommitList({ commits, empty = "没有提交" }: { commits: CommitInfo[]; empty?: string }) {
  if (commits.length === 0) return <Empty>{empty}</Empty>;
  return <div className="max-h-72 overflow-y-auto rounded-lg"><ListSurface>
    {commits.map((commit) => <div key={commit.sha} className="commit-row">
      <Code className="commit-sha">{shortSha(commit.sha)}</Code>
      <span className="text-sm font-medium">{commit.subject}</span>
      <div className="commit-author text-xs text-muted-foreground">{commit.author} &lt;{commit.email}&gt; · <DateTime value={commit.date} label="提交时间" /></div>
    </div>)}
  </ListSurface></div>;
}

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn("workbench-code font-mono text-xs break-all", className)}>{children}</code>;
}

/** 应用标志符号与打包图标共享路径。 */
export function AppGlyph({ className = "size-5" }: { className?: string }) {
  return <svg viewBox="236 300 552 424" className={className} aria-hidden fill="none">
    <g stroke="currentColor" strokeWidth={58} strokeLinecap="round" strokeLinejoin="round">
      <path d="M372 420 H692" /><path d="M616 344 L692 420 L616 496" />
      <path d="M652 604 H332" /><path d="M408 528 L332 604 L408 680" />
    </g>
    <g fill="currentColor"><circle cx="316" cy="420" r="50" /><circle cx="708" cy="604" r="50" /></g>
  </svg>;
}

export function FormSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <FieldSet className="form-section">
    <FieldLegend>{title}</FieldLegend>
    <FieldDescription>{description}</FieldDescription>
    <FieldGroup className="min-w-0">{children}</FieldGroup>
  </FieldSet>;
}

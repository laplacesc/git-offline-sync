import { useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field";
import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group";
import { parseBranchList, Profile, releasesOf, Role } from "./api";
import { FormSection, PathInput, TextInput } from "./ui";
import { OperationStatus, useRunner } from "./runner";
import { WindowControls } from "./WindowControls";
import "./profile-editor.css";

export function blankProfile(role: Role, id: string): Profile {
  return {
    id,
    name: "",
    role,
    repoName: "",
    baseBranch: "main",
    releaseBranches: [],
    transferDir: "",
    remoteUrl: "",
    mirrorDir: "",
    workDir: "",
    devRepos: [],
    userName: "",
    userEmail: "",
  };
}

function missing(p: Profile): { key: keyof Profile; label: string }[] {
  const m: { key: keyof Profile; label: string }[] = [];
  if (!p.name.trim()) m.push({ key: "name", label: "名称" });
  if (!p.repoName.trim()) m.push({ key: "repoName", label: "包名前缀" });
  if (!p.baseBranch.trim()) m.push({ key: "baseBranch", label: "主线分支" });
  if (!p.transferDir.trim()) m.push({ key: "transferDir", label: "传输目录" });
  if (!p.mirrorDir?.trim()) m.push({ key: "mirrorDir", label: "镜像仓库目录" });
  if (p.role === "internal" && !p.workDir?.trim()) m.push({ key: "workDir", label: "工作仓库目录" });
  return m;
}

const ROLES: { id: Role; title: string; desc: string }[] = [
  { id: "internal", title: "内网端", desc: "能访问 GitLab：镜像、导出到 U 盘、导入回传、推送" },
  { id: "external", title: "外网端", desc: "AI 开发：导入内网包、开发提交、回传到内网" },
];

export function ProfileEditor({
  initial,
  isNew,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: Profile;
  isNew: boolean;
  onSave: (p: Profile) => void | boolean | Promise<void | boolean>;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const { notify } = useRunner();
  const [p, setP] = useState<Profile>(initial);
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP((x) => ({ ...x, [k]: v }));
  // 至少显示一行，保存时把空行去掉
  const devRepos = p.devRepos?.length ? p.devRepos : [""];
  const setDev = (i: number, v: string) =>
    set("devRepos", devRepos.map((d, j) => (j === i ? v : d)));
  const addDev = () => set("devRepos", [...devRepos, ""]);
  const removeDev = (i: number) => set("devRepos", devRepos.filter((_, j) => j !== i));
  // 发布分支按原文编辑（允许输入中途的逗号），保存时再拆分
  const [releasesText, setReleasesText] = useState(releasesOf(initial).join(", "));
  const miss = missing(p);
  const internal = p.role === "internal";
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const discardReturnFocus = useRef<HTMLElement | null>(null);
  const dirty = JSON.stringify(p) !== JSON.stringify(initial) || releasesText !== releasesOf(initial).join(", ");
  const summary = useRef<HTMLDivElement>(null);
  const errorFor = (key: keyof Profile) => submitted && miss.some((m) => m.key === key) ? "请填写此项" : undefined;
  async function save() {
    setSubmitted(true);
    if (miss.length) {
      requestAnimationFrame(() => summary.current?.focus());
      return;
    }
    setSaving(true);
    try {
      await onSave({
        ...p,
        name: p.name.trim(), repoName: p.repoName.trim(), baseBranch: p.baseBranch.trim(),
        transferDir: p.transferDir.trim(), mirrorDir: p.mirrorDir?.trim(), workDir: p.workDir?.trim(),
        releaseBranches: parseBranchList(releasesText),
        devRepos: [...new Set(devRepos.map((d) => d.trim()).filter(Boolean))],
      });
    } catch (error) { notify("error", `保存失败：${String(error)}`); }
    finally { setSaving(false); }
  }

  return (
    <form noValidate className="profile-editor-form" onSubmit={(event) => { event.preventDefault(); if (!saving) void save(); }}>
      <Card className="profile-editor">
        <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
          <AlertDialogContent className="app-surface" topLayer={<><WindowControls inline /><OperationStatus inline /></>}
            onOpenAutoFocus={() => { discardReturnFocus.current = document.activeElement as HTMLElement | null; }}
            onCloseAutoFocus={(event) => { event.preventDefault(); if (discardReturnFocus.current?.isConnected) discardReturnFocus.current.focus(); }}>
            <AlertDialogHeader>
              <AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle>
              <AlertDialogDescription>当前填写的内容尚未保存。</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel type="button">继续编辑</AlertDialogCancel>
              <AlertDialogAction type="button" variant="destructive" onClick={onCancel}>放弃修改</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <CardHeader className="profile-editor-header">
          <CardTitle className="profile-editor-title">{isNew ? "新建同步配置" : initial.name}</CardTitle>
          <p className="profile-editor-description">设置此电脑的运行环境、仓库和同步路径。</p>
        </CardHeader>

        <CardContent className="profile-editor-content">
          {submitted && miss.length > 0 && (
            <Alert ref={summary} variant="destructive" role="alert" aria-label="配置校验错误" tabIndex={-1} className="profile-editor-errors">
              <AlertTitle>请补全以下 {miss.length} 项</AlertTitle>
              <AlertDescription>
                <ul className="profile-editor-error-links">
                  {miss.map(({ key, label }) => <li key={key}><a href={`#profile-${key}`}
                    onClick={(event) => { event.preventDefault(); document.getElementById(`profile-${key}`)?.focus(); }}>{label}</a></li>)}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <FormSection title="运行环境" description="选择这台电脑在同步流程中的角色。已有配置的角色不能更改。">
            {isNew ? (
              <RadioGroup
                aria-label="角色"
                value={p.role}
                onValueChange={(value) => set("role", value as Role)}
                orientation="horizontal"
                className="profile-editor-roles"
              >
                {ROLES.map((r) => (
                  <Field key={r.id} orientation="horizontal" className="profile-editor-role" data-selected={p.role === r.id}>
                    <RadioGroupItem id={`profile-role-${r.id}`} value={r.id} aria-describedby={`profile-role-${r.id}-description`} />
                    <FieldGroup className="profile-editor-role-copy">
                      <FieldLabel htmlFor={`profile-role-${r.id}`}>{r.title}</FieldLabel>
                      <FieldDescription id={`profile-role-${r.id}-description`}>{r.desc}</FieldDescription>
                    </FieldGroup>
                  </Field>
                ))}
              </RadioGroup>
            ) : (
              <div className="profile-editor-role-summary">
                <span className="profile-editor-role-name">{internal ? "内网端" : "外网端"}</span>
                <p>{internal ? "连接 GitLab，导出内网包并接收回传。" : "导入内网包，在开发仓库中提交并回传。"}</p>
              </div>
            )}
          </FormSection>

          <FormSection title="基本信息" description="名称用于区分项目，包名前缀和基准分支需要在内外网保持一致。">
            <div className="profile-editor-field-grid">
              <TextInput id="profile-name" error={errorFor("name")} label="名称" value={p.name} onChange={(v) => set("name", v)} placeholder="例如：订单服务" description="用于在顶部项目菜单中区分项目" />
              <TextInput
                id="profile-repoName" error={errorFor("repoName")} label="包名前缀"
                value={p.repoName}
                onChange={(v) => set("repoName", v)}
                placeholder="order-service"
                description="文件名形如 <前缀>-out-0001-full.bundle，两端要一致"
              />
              <TextInput
                id="profile-baseBranch" error={errorFor("baseBranch")} label="主线分支"
                value={p.baseBranch}
                onChange={(v) => set("baseBranch", v)}
                description="feature/、bugfix/ 分支的基准，通常是 main 或 master"
              />
              <TextInput
                label="发布分支"
                value={releasesText}
                onChange={setReleasesText}
                placeholder="release/1.2, release/1.3"
                description="hotfix/ 分支的基准，多个用逗号或空格分隔；两端要一致"
              />
            </div>
          </FormSection>

          <FormSection title="仓库与传输路径" description="镜像用于存放同步数据，工作仓库用于开发。传输目录是两端交换包的位置。">
            <div className="profile-editor-paths">
              <PathInput id="profile-transferDir" error={errorFor("transferDir")} label="传输目录（U 盘）" value={p.transferDir} onChange={(v) => set("transferDir", v)} description="导出的包写到这里，导入时从这里列出" />
              {internal ? (
                <>
                  <TextInput
                    label="GitLab 仓库地址"
                    value={p.remoteUrl ?? ""}
                    onChange={(v) => set("remoteUrl", v)}
                    placeholder="http://gitlab.internal/group/project.git"
                    description="首次克隆镜像时使用"
                  />
                  <PathInput
                    id="profile-mirrorDir" error={errorFor("mirrorDir")} label="镜像仓库目录"
                    value={p.mirrorDir ?? ""}
                    onChange={(v) => set("mirrorDir", v)}
                    placeholder="D:\git-sync\project.git"
                    description="git clone --mirror 的目标，只用来打包，不在这里推送"
                  />
                  <PathInput
                    id="profile-workDir" error={errorFor("workDir")} label="工作仓库目录"
                    value={p.workDir ?? ""}
                    onChange={(v) => set("workDir", v)}
                    placeholder="D:\work\project"
                    description="平时开发用的普通克隆，用于接收回传、rebase 和推送"
                  />
                </>
              ) : (
                <>
                  <PathInput
                    id="profile-mirrorDir" error={errorFor("mirrorDir")} label="外网镜像目录"
                    value={p.mirrorDir ?? ""}
                    onChange={(v) => set("mirrorDir", v)}
                    placeholder="~/mirrors/project.git"
                    description="内网包导入到这里（裸仓库）。开发仓库以它为 origin，不要在这里开发"
                  />
                  <div className="profile-editor-dev-repos">
                    {devRepos.map((d, i) => (
                      <div key={i} className="profile-editor-dev-row">
                        <div className="profile-editor-dev-path">
                          <PathInput
                            label={i === 0 ? "开发仓库目录" : `开发仓库 ${i + 1}`}
                            value={d}
                            onChange={(v) => setDev(i, v)}
                            placeholder="~/code/project"
                            description={i === 0 ? "从镜像克隆出来的工作仓库，可以在里面开 worktree" : undefined}
                          />
                        </div>
                        {devRepos.length > 1 && (
                          <Button type="button" size="sm" variant="ghost" className="profile-editor-remove" onClick={() => removeDev(i)}>
                            移除
                          </Button>
                        )}
                      </div>
                    ))}
                    <div>
                      <Button type="button" size="sm" variant="ghost" onClick={addDev}>
                        + 再加一个开发仓库
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </FormSection>
          {!internal && (
            <FormSection title="提交身份" description="使用与内网账号一致的姓名和邮箱，确保回传提交的作者信息正确。">
              <div className="profile-editor-field-grid">
                <TextInput label="提交用户名" value={p.userName ?? ""} onChange={(v) => set("userName", v)} description="与内网账号一致，推送后作者才正确" />
                <TextInput label="提交邮箱" value={p.userEmail ?? ""} onChange={(v) => set("userEmail", v)} />
              </div>
            </FormSection>
          )}
        </CardContent>

        <CardFooter className="profile-editor-footer">
          {miss.length > 0 && <p className="profile-editor-missing">还需填写：{miss.map((m) => m.label).join("、")}</p>}
          <div className="profile-editor-actions">
            {onDelete && (
              <Button type="button" className="profile-editor-delete" variant="destructive" onClick={onDelete} disabled={saving}>
                删除配置
              </Button>
            )}
            <div className="profile-editor-submit-actions">
              <Button type="button" variant="secondary" onClick={() => dirty ? setDiscardOpen(true) : onCancel()} disabled={saving}>
                取消
              </Button>
              <Button variant="default" disabled={saving} aria-busy={saving} type="submit">保存</Button>
            </div>
          </div>
        </CardFooter>
      </Card>
    </form>
  );
}

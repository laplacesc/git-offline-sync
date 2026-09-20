import { useRef, useState } from "react";
import { AlertDialog, Button, Card, Description, Label, Radio, RadioGroup } from "@heroui/react";
import { parseBranchList, Profile, releasesOf, Role } from "./api";
import { FormSection, PathInput, SectionLabel, TextInput } from "./ui";

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
  const [saveError, setSaveError] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
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
    setSaveError("");
    try {
      const result = await onSave({
        ...p,
        name: p.name.trim(), repoName: p.repoName.trim(), baseBranch: p.baseBranch.trim(),
        transferDir: p.transferDir.trim(), mirrorDir: p.mirrorDir?.trim(), workDir: p.workDir?.trim(),
        releaseBranches: parseBranchList(releasesText),
        devRepos: [...new Set(devRepos.map((d) => d.trim()).filter(Boolean))],
      });
      if (result === false) setSaveError("保存失败，请检查错误提示后重试。填写内容已保留。");
    } catch (error) { setSaveError(`保存失败：${String(error)}`); }
    finally { setSaving(false); }
  }

  return (
    <Card className="form-page animate-enter gap-0 p-0">
      <AlertDialog.Backdrop isOpen={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header><AlertDialog.Heading>放弃未保存的修改？</AlertDialog.Heading></AlertDialog.Header>
            <AlertDialog.Body>当前填写的内容尚未保存。</AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" onPress={() => setDiscardOpen(false)}>继续编辑</Button>
              <Button variant="danger" onPress={onCancel}>放弃修改</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
      <Card.Header className="space-y-3 px-8 pt-8 pb-6">
        <SectionLabel>{isNew ? "New profile" : "Edit profile"}</SectionLabel>
        <Card.Title className="font-display text-3xl leading-tight font-normal">
          {isNew ? (
            <>
              新建<span className="text-gradient">同步配置</span>
            </>
          ) : (
            initial.name
          )}
        </Card.Title>
      </Card.Header>

      <Card.Content className="flex flex-col gap-8 px-8 pb-8">
        {submitted && miss.length > 0 && (
          <div ref={summary} role="alert" tabIndex={-1} className="rounded-xl border border-danger p-4 text-sm">
            <p className="font-semibold">请补全以下 {miss.length} 项</p>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              {miss.map(({ key, label }) => <li key={key}><a className="text-danger underline" href={`#profile-${key}`}
                onClick={(event) => { event.preventDefault(); document.getElementById(`profile-${key}`)?.focus(); }}>{label}</a></li>)}
            </ul>
          </div>
        )}
        {saveError && <p role="alert" className="text-sm text-danger">{saveError}</p>}
        <FormSection title="运行环境" description="选择这台电脑在同步流程中的角色。已有配置的角色不能更改。">
        {isNew ? <RadioGroup
          value={p.role}
          onChange={(v) => set("role", v as Role)}
          isDisabled={!isNew}
          orientation="horizontal"
          className="grid gap-3 sm:grid-cols-2"
        >
          <Label className="sr-only">角色</Label>
          {ROLES.map((r) => (
            <Radio
              key={r.id}
              value={r.id}
              className={
                "rounded-xl border p-4 transition-all duration-200 " +
                (p.role === r.id ? "gradient-border shadow-accent" : "border-border hover:border-accent/30")
              }
            >
              <Radio.Content className="items-start gap-3">
                <Radio.Control className="mt-0.5">
                  <Radio.Indicator />
                </Radio.Control>
                <div className="space-y-1">
                  <div className="font-semibold">{r.title}</div>
                  <Description>{r.desc}</Description>
                </div>
              </Radio.Content>
            </Radio>
          ))}
        </RadioGroup> : (
          <div className="rounded-xl border border-border bg-default/50 p-4">
            <p className="font-semibold">{internal ? "内网端" : "外网端"}</p>
            <p className="mt-1 text-sm text-muted">{internal ? "连接 GitLab，导出内网包并接收回传。" : "导入内网包，在开发仓库中提交并回传。"}</p>
          </div>
        )}
        </FormSection>

        <FormSection title="基本信息" description="名称用于区分项目，包名前缀和基准分支需要在内外网保持一致。">
        <div className="form-fields">
          <TextInput id="profile-name" error={errorFor("name")} label="名称" value={p.name} onChange={(v) => set("name", v)} placeholder="例如：订单服务" description="只用来在左侧列表里区分" />
          <TextInput
            id="profile-repoName" error={errorFor("repoName")} label="包名前缀"
            value={p.repoName}
            onChange={(v) => set("repoName", v)}
            placeholder="order-service"
            description="文件名形如 <前缀>-out-0001-full.bundle，两端要一致"
            mono
          />
          <TextInput
            id="profile-baseBranch" error={errorFor("baseBranch")} label="主线分支"
            value={p.baseBranch}
            onChange={(v) => set("baseBranch", v)}
            description="feature/、bugfix/ 分支的基准，通常是 main 或 master"
            mono
          />
          <TextInput
            label="发布分支"
            value={releasesText}
            onChange={setReleasesText}
            placeholder="release/1.2, release/1.3"
            description="hotfix/ 分支的基准，多个用逗号或空格分隔；两端要一致"
            mono
          />
        </div>

        </FormSection>

        <FormSection title="仓库与传输路径" description="镜像用于存放同步数据，工作仓库用于开发。传输目录是两端交换包的位置。">
        <div className="space-y-5">
          <PathInput id="profile-transferDir" error={errorFor("transferDir")} label="传输目录（U 盘）" value={p.transferDir} onChange={(v) => set("transferDir", v)} description="导出的包写到这里，导入时从这里列出" />
        {internal ? (
          <div className="grid gap-5">
            <TextInput
              label="GitLab 仓库地址"
              value={p.remoteUrl ?? ""}
              onChange={(v) => set("remoteUrl", v)}
              placeholder="http://gitlab.internal/group/project.git"
              description="首次克隆镜像时使用"
              mono
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
          </div>
        ) : (
          <div className="grid gap-5">
            <PathInput
              id="profile-mirrorDir" error={errorFor("mirrorDir")} label="外网镜像目录"
              value={p.mirrorDir ?? ""}
              onChange={(v) => set("mirrorDir", v)}
              placeholder="~/mirrors/project.git"
              description="内网包导入到这里（裸仓库）。开发仓库以它为 origin，不要在这里开发"
            />
            <div className="flex flex-col gap-3">
              {devRepos.map((d, i) => (
                <div key={i} className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <PathInput
                      label={i === 0 ? "开发仓库目录" : `开发仓库 ${i + 1}`}
                      value={d}
                      onChange={(v) => setDev(i, v)}
                      placeholder="~/code/project"
                      description={
                        i === 0 ? "从镜像克隆出来的工作仓库，可以在里面开 worktree" : undefined
                      }
                    />
                  </div>
                  {devRepos.length > 1 && (
                    <Button size="sm" variant="ghost" onPress={() => removeDev(i)}>
                      移除
                    </Button>
                  )}
                </div>
              ))}
              <div>
                <Button size="sm" variant="ghost" onPress={addDev}>
                  + 再加一个开发仓库
                </Button>
              </div>
            </div>

          </div>
        )}
        </div>
        </FormSection>
        {!internal && <FormSection title="提交身份" description="使用与内网账号一致的姓名和邮箱，确保回传提交的作者信息正确。">
          <div className="form-fields">
            <TextInput label="提交用户名" value={p.userName ?? ""} onChange={(v) => set("userName", v)} description="与内网账号一致，推送后作者才正确" />
            <TextInput label="提交邮箱" value={p.userEmail ?? ""} onChange={(v) => set("userEmail", v)} />
          </div>
        </FormSection>}
      </Card.Content>

      <Card.Footer className="flex flex-wrap items-center gap-3 border-t border-border px-8 py-5">
        {onDelete && (
          <Button variant="danger-soft" onPress={onDelete} isDisabled={saving}>
            删除配置
          </Button>
        )}
        <span className="min-w-0 flex-1" />
        {miss.length > 0 && <span className="text-sm text-muted">还需填写：{miss.map((m) => m.label).join("、")}</span>}
        <Button variant="tertiary" onPress={() => dirty ? setDiscardOpen(true) : onCancel()} isDisabled={saving}>
          取消
        </Button>
        <Button
          variant="primary"
          isDisabled={saving}
          onPress={save}
        >
          {saving ? "保存中…" : "保存"}
        </Button>
      </Card.Footer>
    </Card>
  );
}

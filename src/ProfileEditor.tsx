import { useState } from "react";
import { Button, Card, Description, Label, Radio, RadioGroup } from "@heroui/react";
import { Profile, Role } from "./api";
import { PathInput, SectionLabel, TextInput } from "./ui";

export function blankProfile(role: Role, id: string): Profile {
  return {
    id,
    name: "",
    role,
    repoName: "",
    baseBranch: "main",
    transferDir: "",
    remoteUrl: "",
    mirrorDir: "",
    workDir: "",
    repoDir: "",
    userName: "",
    userEmail: "",
  };
}

function missing(p: Profile): string[] {
  const m: string[] = [];
  if (!p.name.trim()) m.push("名称");
  if (!p.repoName.trim()) m.push("包名前缀");
  if (!p.baseBranch.trim()) m.push("基准分支");
  if (!p.transferDir.trim()) m.push("传输目录");
  if (p.role === "internal") {
    if (!p.mirrorDir?.trim()) m.push("镜像仓库目录");
    if (!p.workDir?.trim()) m.push("工作仓库目录");
  } else if (!p.repoDir?.trim()) {
    m.push("开发仓库目录");
  }
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
  onSave: (p: Profile) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [p, setP] = useState<Profile>(initial);
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP((x) => ({ ...x, [k]: v }));
  const miss = missing(p);
  const internal = p.role === "internal";

  return (
    <Card className="animate-enter max-w-4xl gap-0 p-0">
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
        <RadioGroup
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
        </RadioGroup>

        <div className="grid gap-5 md:grid-cols-2">
          <TextInput label="名称" value={p.name} onChange={(v) => set("name", v)} placeholder="例如：订单服务" description="只用来在左侧列表里区分" />
          <TextInput
            label="包名前缀"
            value={p.repoName}
            onChange={(v) => set("repoName", v)}
            placeholder="order-service"
            description="文件名形如 <前缀>-out-0001-full.bundle，两端要一致"
            mono
          />
          <TextInput label="基准分支" value={p.baseBranch} onChange={(v) => set("baseBranch", v)} description="内网主干分支，通常是 main 或 master" mono />
          <PathInput label="传输目录（U 盘）" value={p.transferDir} onChange={(v) => set("transferDir", v)} description="导出的包写到这里，导入时从这里列出" />
        </div>

        {internal ? (
          <div className="grid gap-5 md:grid-cols-2">
            <TextInput
              label="GitLab 仓库地址"
              value={p.remoteUrl ?? ""}
              onChange={(v) => set("remoteUrl", v)}
              placeholder="http://gitlab.internal/group/project.git"
              description="首次克隆镜像时使用"
              mono
            />
            <PathInput
              label="镜像仓库目录"
              value={p.mirrorDir ?? ""}
              onChange={(v) => set("mirrorDir", v)}
              placeholder="D:\git-sync\project.git"
              description="git clone --mirror 的目标，只用来打包，不在这里推送"
            />
            <PathInput
              label="工作仓库目录"
              value={p.workDir ?? ""}
              onChange={(v) => set("workDir", v)}
              placeholder="D:\work\project"
              description="平时开发用的普通克隆，用于接收回传、rebase 和推送"
            />
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2">
            <PathInput
              label="开发仓库目录"
              value={p.repoDir ?? ""}
              onChange={(v) => set("repoDir", v)}
              placeholder="~/code/project"
              description="首次导入全量包时克隆到这里（目录需不存在或为空）"
            />
            <div className="hidden md:block" />
            <TextInput label="提交用户名" value={p.userName ?? ""} onChange={(v) => set("userName", v)} description="与内网账号一致，推送后作者才正确" />
            <TextInput label="提交邮箱" value={p.userEmail ?? ""} onChange={(v) => set("userEmail", v)} />
          </div>
        )}
      </Card.Content>

      <Card.Footer className="flex flex-wrap items-center gap-3 border-t border-border px-8 py-5">
        {onDelete && (
          <Button variant="danger-soft" onPress={onDelete}>
            删除配置
          </Button>
        )}
        <span className="flex-1" />
        {miss.length > 0 && <span className="text-sm text-muted">还需填写：{miss.join("、")}</span>}
        <Button variant="tertiary" onPress={onCancel}>
          取消
        </Button>
        <Button variant="primary" isDisabled={miss.length > 0} onPress={() => onSave(p)}>
          保存
        </Button>
      </Card.Footer>
    </Card>
  );
}

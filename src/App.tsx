import { useEffect, useState } from "react";
import { Button, Card, ListBox, Spinner, Toast } from "@heroui/react";
import type { Selection } from "@heroui/react";
import { api, AppConfig, Environment, newId, Profile, Role } from "./api";
import { ExternalView } from "./ExternalView";
import { InternalView } from "./InternalView";
import { LogPanel, useGitLog } from "./LogPanel";
import { blankProfile, ProfileEditor } from "./ProfileEditor";
import { RunnerProvider, useRunner } from "./runner";
import { AppGlyph, Code, Notice, PathInput, SectionLabel, TextInput } from "./ui";
import "./index.css";

/**
 * macOS 使用 Overlay 标题栏（隐藏标题、保留红黄绿按钮），需要自己提供可拖动区域；
 * Windows 保留原生标题栏，不需要。
 */
const IS_MAC = navigator.userAgent.includes("Mac");

/** 标题栏拖动条：只在 macOS 显示，双击最大化 */
function TitleBarDrag({ className = "" }: { className?: string }) {
  if (!IS_MAC) return null;
  return <div data-tauri-drag-region className={"h-10 shrink-0 select-none " + className} />;
}

type Mode = { kind: "view" } | { kind: "edit"; profile: Profile; isNew: boolean } | { kind: "settings" };

function Shell() {
  const { busy, notify, confirm } = useRunner();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [logOpen, setLogOpen] = useState(true);
  const log = useGitLog();

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.loadConfig();
        setConfig({ ...cfg, profiles: cfg.profiles ?? [] });
      } catch (e) {
        notify("error", String(e));
        setConfig({ profiles: [] });
      }
      setEnv(await api.environment().catch(() => null));
    })();
  }, [notify]);

  const persist = async (next: AppConfig) => {
    setConfig(next);
    try {
      await api.saveConfig(next);
    } catch (e) {
      notify("error", `保存配置失败：${String(e)}`);
    }
  };

  if (!config) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner size="lg" />
      </div>
    );
  }

  const current = config.profiles.find((p) => p.id === config.lastProfileId) ?? config.profiles[0];
  const select = (id: string) => {
    setMode({ kind: "view" });
    persist({ ...config, lastProfileId: id });
  };
  const startNew = (role: Role) => setMode({ kind: "edit", profile: blankProfile(role, newId()), isNew: true });

  const saveProfile = (p: Profile) => {
    const exists = config.profiles.some((x) => x.id === p.id);
    const profiles = exists ? config.profiles.map((x) => (x.id === p.id ? p : x)) : [...config.profiles, p];
    persist({ ...config, profiles, lastProfileId: p.id });
    setMode({ kind: "view" });
  };

  const deleteProfile = async (p: Profile) => {
    const ok = await confirm({
      title: `删除配置“${p.name}”`,
      body: <p className="text-sm text-muted">只删除本工具中的配置，不会删除任何仓库或文件。</p>,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    const profiles = config.profiles.filter((x) => x.id !== p.id);
    persist({ ...config, profiles, lastProfileId: profiles[0]?.id });
    setMode({ kind: "view" });
  };

  const gitOk = !!env && "Ok" in env.git;
  const recommended: Role = env?.os === "windows" ? "internal" : "external";
  const selectedKeys: Selection = new Set(mode.kind === "view" && current ? [current.id] : []);

  return (
    <div className="grid h-full grid-cols-[248px_1fr]">
      {/* ---------- 侧栏：白色表面 + 右侧细边框，左上角一抹淡蓝光晕 ---------- */}
      <aside className="relative flex min-h-0 flex-col overflow-hidden border-r border-border bg-surface">
        <div className="pointer-events-none absolute -top-28 -left-28 size-64 rounded-full bg-accent/[0.06] blur-[80px]" />
        <TitleBarDrag className="relative" />
        <div className={"relative flex items-center gap-3 px-5 pb-5 " + (IS_MAC ? "pt-1" : "pt-6")}>
          <span className="bg-gradient-accent grid size-9 place-items-center rounded-xl text-white shadow-accent">
            <AppGlyph className="size-5" />
          </span>
          <div>
            <div className="font-display text-lg leading-none">Git 离线同步</div>
            <div className="mt-1 font-mono text-[10px] tracking-[0.15em] text-muted uppercase">mirror · bundle</div>
          </div>
        </div>

        <div className="relative px-5 pb-2">
          <SectionLabel>Profiles</SectionLabel>
        </div>
        <div className="relative min-h-0 flex-1 overflow-y-auto px-3">
          {config.profiles.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted">还没有配置</p>
          ) : (
            <ListBox
              aria-label="同步配置"
              selectionMode="single"
              selectedKeys={selectedKeys}
              onSelectionChange={(keys) => {
                const id = keys === "all" ? undefined : [...keys][0];
                if (id) select(String(id));
              }}
              className="gap-1 bg-transparent p-0"
            >
              {config.profiles.map((p) => (
                <ListBox.Item
                  key={p.id}
                  id={p.id}
                  textValue={p.name}
                  className="rounded-lg px-3 py-2 text-foreground/80 data-[hovered=true]:bg-default data-[selected=true]:bg-accent/[0.08] data-[selected=true]:font-medium data-[selected=true]:text-accent"
                >
                  <span className={"size-2 shrink-0 rounded-full " + (p.role === "internal" ? "bg-[#fbbf24]" : "bg-accent-secondary")} />
                  <span className="flex-1 truncate">{p.name}</span>
                  <span className="font-mono text-[10px] tracking-wider text-muted uppercase">
                    {p.role === "internal" ? "内网" : "外网"}
                  </span>
                </ListBox.Item>
              ))}
            </ListBox>
          )}
        </div>

        <div className="relative space-y-2 border-t border-border p-3">
          <Button fullWidth variant="outline" onPress={() => startNew(recommended)}>
            ＋ 新建配置
          </Button>
          <Button
            fullWidth
            variant="ghost"
            className="justify-start gap-2 text-xs text-muted hover:text-foreground"
            onPress={() => setMode({ kind: "settings" })}
          >
            <span className={"size-1.5 rounded-full " + (gitOk ? "animate-pulse-dot bg-success" : env ? "bg-danger" : "bg-border")} />
            <span className="flex-1 truncate text-left font-mono">
              {env ? ("Ok" in env.git ? env.git.Ok.replace("git version ", "git ") : "git 不可用") : "检测中…"}
            </span>
            <span>⚙</span>
          </Button>
        </div>
      </aside>

      {/* ---------- 主区域 ---------- */}
      <main className="flex min-h-0 min-w-0 flex-col">
        <TitleBarDrag />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={"mx-auto max-w-5xl px-8 pb-12 " + (IS_MAC ? "pt-2" : "pt-8")}>
            {env && !gitOk && (
              <div className="mb-6">
                <Notice tone="danger" title="找不到可用的 git">
                  {"Err" in env.git ? env.git.Err : ""}。请安装 Git，或在设置中指定 git 可执行文件路径。
                </Notice>
              </div>
            )}

            {mode.kind === "edit" && (
              <ProfileEditor
                key={mode.profile.id}
                initial={mode.profile}
                isNew={mode.isNew}
                onSave={saveProfile}
                onCancel={() => setMode({ kind: "view" })}
                onDelete={mode.isNew ? undefined : () => deleteProfile(mode.profile)}
              />
            )}

            {mode.kind === "settings" && (
              <Settings
                config={config}
                env={env}
                onSave={async (c) => {
                  await persist(c);
                  setEnv(await api.environment().catch(() => null));
                  setMode({ kind: "view" });
                }}
                onCancel={() => setMode({ kind: "view" })}
              />
            )}

            {mode.kind === "view" &&
              (current ? (
                <>
                  <header className="animate-enter mb-8 flex items-end justify-between gap-6">
                    <div className="min-w-0 flex-1 space-y-3">
                      <SectionLabel pulse>{current.role === "internal" ? "Intranet side" : "Internet side"}</SectionLabel>
                      <h1 className="font-display text-4xl leading-[1.1] tracking-[-0.02em]">
                        {current.name}
                        <span className="text-gradient"> · {current.role === "internal" ? "内网端" : "外网端"}</span>
                      </h1>
                      <p className="flex min-w-0 items-center gap-2 text-sm text-muted">
                        <span className="shrink-0">主线</span>
                        <Code className="shrink-0">{current.baseBranch}</Code>
                        {(current.releaseBranches?.length ?? 0) > 0 && (
                          <span className="shrink-0" title={current.releaseBranches?.join("\n")}>
                            · 发布分支 {current.releaseBranches?.length} 个
                          </span>
                        )}
                        <span className="ml-2 shrink-0">传输目录</span>
                        <span className="min-w-0 truncate font-mono text-[12px] text-foreground" title={current.transferDir}>
                          {current.transferDir}
                        </span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {busy && (
                        <span className="inline-flex items-center gap-2 text-sm text-accent">
                          <Spinner size="sm" /> {busy}…
                        </span>
                      )}
                      <Button
                        variant="outline"
                        onPress={() => setMode({ kind: "edit", profile: current, isNew: false })}
                        isDisabled={!!busy}
                      >
                        编辑配置
                      </Button>
                    </div>
                  </header>
                  {current.role === "internal" ? (
                    <InternalView key={current.id} profile={current} />
                  ) : (
                    <ExternalView key={current.id} profile={current} />
                  )}
                </>
              ) : (
                <Welcome onNew={startNew} recommended={recommended} />
              ))}
          </div>
        </div>

        <LogPanel lines={log.lines} clear={log.clear} open={logOpen} setOpen={setLogOpen} />
      </main>
    </div>
  );
}

/** 欢迎页：非对称两栏 + 缓慢旋转的环与漂浮的“包”卡片 */
function Welcome({ onNew, recommended }: { onNew: (r: Role) => void; recommended: Role }) {
  const steps = [
    ["内网", "克隆镜像 → 导出全量包"],
    ["外网", "克隆全量包 → 新建分支 → AI 开发并提交 → 导出回传包"],
    ["内网", "导入回传 → rebase 到最新 main → 确认后推送"],
    ["之后", "内网只导出增量包，外网按序号导入"],
  ];
  return (
    <div className="grid items-center gap-10 py-6 lg:grid-cols-[1.1fr_0.9fr]">
      <div className="stagger space-y-7">
        <SectionLabel pulse>Offline git sync</SectionLabel>
        <h1 className="font-display text-5xl leading-[1.05] tracking-[-0.02em]">
          在离线内网与外网之间
          <span className="relative inline-block">
            <span className="text-gradient">同步 Git 仓库</span>
            <span className="absolute inset-x-0 -bottom-1 h-3 rounded-sm bg-gradient-to-r from-accent/15 to-accent-secondary/10" />
          </span>
        </h1>
        <p className="max-w-xl text-lg leading-relaxed text-muted">
          内网用 <Code>git clone --mirror</Code> 维护镜像并打包成 bundle，经 U 盘带到外网；外网在特性分支上开发，
          把新提交打包带回内网 rebase 后推送。
        </p>
        <ol className="space-y-3">
          {steps.map(([who, what], i) => (
            <li key={i} className="flex items-start gap-4">
              <span className="bg-gradient-accent grid size-7 shrink-0 place-items-center rounded-lg font-mono text-xs text-white shadow-accent">
                {i + 1}
              </span>
              <span className="pt-0.5 text-sm">
                <strong className="mr-2 font-semibold text-accent">{who}</strong>
                {what}
              </span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-3 pt-2">
          <Button size="lg" variant={recommended === "internal" ? "primary" : "outline"} onPress={() => onNew("internal")}>
            新建内网端配置 →
          </Button>
          <Button size="lg" variant={recommended === "external" ? "primary" : "outline"} onPress={() => onNew("external")}>
            新建外网端配置 →
          </Button>
        </div>
      </div>

      <HeroGraphic />
    </div>
  );
}

function HeroGraphic() {
  return (
    <div aria-hidden className="relative hidden aspect-square w-full max-w-md justify-self-center lg:block">
      <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle,rgba(0,82,255,0.08),transparent_65%)]" />
      <div className="animate-spin-slow absolute inset-6 rounded-full border-2 border-dashed border-accent/20" />
      <div className="absolute inset-20 rounded-full border border-border bg-surface shadow-xl" />
      <div className="absolute top-1/2 left-1/2 grid size-24 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-3xl bg-gradient-accent text-white shadow-accent-lg">
        <AppGlyph className="size-12" />
      </div>

      <Card className="animate-float absolute top-10 -left-2 w-52 gap-1 p-4 shadow-lg">
        <span className="font-mono text-[10px] tracking-[0.15em] text-accent uppercase">Intranet</span>
        <span className="font-mono text-xs">proj-out-0003-incr.bundle</span>
        <span className="text-xs text-muted">+12 commits · 3 branches</span>
      </Card>
      <Card className="animate-float-slow absolute right-0 bottom-12 w-48 gap-1 p-4 shadow-lg">
        <span className="font-mono text-[10px] tracking-[0.15em] text-accent uppercase">Return</span>
        <span className="font-mono text-xs">proj-back-0002.bundle</span>
        <span className="text-xs text-muted">feature/ai-login ↑2</span>
      </Card>

      <div className="absolute top-4 right-10 grid grid-cols-3 gap-2">
        {Array.from({ length: 9 }).map((_, i) => (
          <span key={i} className="size-1.5 rounded-full bg-accent/30" />
        ))}
      </div>
      <div className="absolute bottom-6 left-10 size-10 rounded-tl-2xl rounded-br-2xl bg-accent shadow-accent" />
    </div>
  );
}

function Settings({
  config,
  env,
  onSave,
  onCancel,
}: {
  config: AppConfig;
  env: Environment | null;
  onSave: (c: AppConfig) => void;
  onCancel: () => void;
}) {
  const [gitPath, setGitPath] = useState(config.gitPath ?? "");
  return (
    <Card className="animate-enter max-w-3xl gap-0 p-0">
      <Card.Header className="space-y-3 px-8 pt-8 pb-6">
        <SectionLabel>Settings</SectionLabel>
        <Card.Title className="font-display text-3xl font-normal">设置</Card.Title>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5 px-8 pb-8">
        <PathInput
          label="git 可执行文件"
          value={gitPath}
          onChange={setGitPath}
          directory={false}
          placeholder="留空则使用 PATH 中的 git"
          description={
            env?.os === "windows"
              ? "例如 C:\\Program Files\\Git\\cmd\\git.exe"
              : "例如 /usr/bin/git 或 /Library/Developer/CommandLineTools/usr/bin/git"
          }
        />
        <TextInput label="当前检测结果" value={env ? ("Ok" in env.git ? env.git.Ok : env.git.Err) : "—"} isReadOnly mono />
        <TextInput label="配置文件位置" value={env?.configPath ?? "—"} isReadOnly mono />
      </Card.Content>
      <Card.Footer className="flex justify-end gap-3 border-t border-border px-8 py-5">
        <Button variant="tertiary" onPress={onCancel}>
          取消
        </Button>
        <Button variant="primary" onPress={() => onSave({ ...config, gitPath: gitPath.trim() || undefined })}>
          保存并重新检测
        </Button>
      </Card.Footer>
    </Card>
  );
}

export default function App() {
  return (
    <RunnerProvider>
      <Toast.Provider placement="top end" />
      <Shell />
    </RunnerProvider>
  );
}

import { useEffect, useRef, useState } from "react";
import { Button, Card, ListBox, Spinner, Toast } from "@heroui/react";
import type { Selection } from "@heroui/react";
import { api, AppConfig, Environment, newId, Profile, Role } from "./api";
import { ExternalView } from "./ExternalView";
import { InternalView } from "./InternalView";
import { LogPanel, useGitLog } from "./LogPanel";
import { blankProfile, ProfileEditor } from "./ProfileEditor";
import { OperationStatus, RunnerProvider, useRunner } from "./runner";
import { AppGlyph, Code, FormSection, Notice, PathInput, SectionLabel, TextInput } from "./ui";
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const contentRef = useRef<HTMLDivElement>(null);
  const pageKey = mode.kind === "edit" ? mode.profile.id : config?.lastProfileId;
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [mode.kind, pageKey]);
  // 默认收起；开始执行操作或出现错误时自动展开
  const [logOpen, setLogOpen] = useState(false);
  const log = useGitLog();
  const logErrors = log.lines.filter((l) => l.kind === "error").length;
  useEffect(() => {
    if (busy) setLogOpen(true);
  }, [busy]);
  useEffect(() => {
    if (logErrors > 0) setLogOpen(true);
  }, [logErrors]);

  useEffect(() => {
    (async () => {
      try {
        setLoadError(null);
        const cfg = await api.loadConfig();
        setConfig({ ...cfg, profiles: cfg.profiles ?? [] });
      } catch (e) {
        setLoadError(String(e));
      }
      setEnv(await api.environment().catch(() => null));
    })();
  }, [notify, loadAttempt]);

  const persist = async (next: AppConfig) => {
    try {
      await api.saveConfig(next);
      setConfig(next);
      return true;
    } catch (e) {
      notify("error", `保存配置失败：${String(e)}`);
      return false;
    }
  };

  if (loadError) {
    return <div className="grid h-full place-items-center p-6"><div className="max-w-lg space-y-4">
      <Notice tone="danger" title="无法读取同步配置">{loadError}</Notice>
      <Button onPress={() => setLoadAttempt((n) => n + 1)}>重新读取配置</Button>
    </div></div>;
  }
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

  const saveProfile = async (p: Profile) => {
    const exists = config.profiles.some((x) => x.id === p.id);
    const profiles = exists ? config.profiles.map((x) => (x.id === p.id ? p : x)) : [...config.profiles, p];
    const saved = await persist({ ...config, profiles, lastProfileId: p.id });
    if (saved) setMode({ kind: "view" });
    return saved;
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
    if (await persist({ ...config, profiles, lastProfileId: profiles[0]?.id })) setMode({ kind: "view" });
  };

  const gitOk = !!env && "Ok" in env.git;
  // git 检测的三态：env 还没回来 = 检测中；Ok = 可用；Err = 不可用
  function gitIndicator() {
    if (!env) return { dot: "bg-border", text: "检测中…" };
    if ("Ok" in env.git) {
      return { dot: "bg-success", text: env.git.Ok.replace("git version ", "git ") };
    }
    return { dot: "bg-danger", text: "git 不可用" };
  }
  const gitBits = gitIndicator();
  const recommended: Role = env?.os === "windows" ? "internal" : "external";
  const selectedKeys: Selection = new Set(mode.kind === "view" && current ? [current.id] : []);

  return (
    <div className="app-shell grid h-full grid-cols-[248px_1fr]">
      <a href="#main-content" className="skip-link">跳到主要内容</a>
      {/* ---------- 侧栏：白色表面 + 右侧细边框，左上角一抹淡蓝光晕 ---------- */}
      <aside className="relative flex min-h-0 flex-col overflow-hidden border-r border-border bg-surface">
        <div className="pointer-events-none absolute -top-28 -left-28 size-64 rounded-full bg-accent/[0.06] blur-[80px]" />
        <TitleBarDrag className="relative" />
        <div className={"app-brand relative flex items-center gap-3 px-5 pb-5 " + (IS_MAC ? "pt-1" : "pt-6")}>
          <span className="bg-gradient-accent grid size-9 place-items-center rounded-xl text-white shadow-accent">
            <AppGlyph className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-semibold whitespace-nowrap leading-none">Git 离线同步</span>
              {env && <span className="font-mono text-[11px] leading-none text-muted">v{env.version}</span>}
            </div>
            <div className="mt-1 font-mono text-[10px] tracking-[0.15em] text-muted uppercase">mirror · bundle</div>
          </div>
        </div>

        <div className="app-profiles-title relative px-5 pb-2">
          <SectionLabel>Profiles</SectionLabel>
        </div>
        <div className="app-profile-list relative min-h-0 flex-1 overflow-y-auto px-3">
          {config.profiles.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted">还没有配置</p>
          ) : (
            <ListBox
              aria-label="同步配置"
              disabledKeys={busy || mode.kind === "edit" ? config.profiles.map((p) => p.id) : []}
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

        <div className="app-sidebar-actions relative space-y-2 border-t border-border p-3">
          <Button fullWidth variant="outline" onPress={() => startNew(recommended)} isDisabled={!!busy || mode.kind === "edit"}>
            ＋ 新建配置
          </Button>
          <Button
            fullWidth
            variant="ghost"
            className="justify-start gap-2 text-xs text-muted hover:text-foreground"
            isDisabled={!!busy || mode.kind === "edit"}
            aria-label="打开设置"
            onPress={() => setMode({ kind: "settings" })}
          >
            <span className={"size-1.5 rounded-full " + gitBits.dot} />
            <span className="flex-1 truncate text-left font-mono">{gitBits.text}</span>
            <span>设置</span>
          </Button>
        </div>
      </aside>

      {/* ---------- 主区域 ---------- */}
      <main id="main-content" tabIndex={-1} className="flex min-h-0 min-w-0 flex-col">
        <OperationStatus />
        <TitleBarDrag />
        <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className={"workspace-content mx-auto w-full max-w-[1440px] px-4 lg:px-6 pb-8 " + (IS_MAC ? "pt-2" : "pt-8")}>
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
                  if (!await persist(c)) return false;
                  setEnv(await api.environment().catch(() => null));
                  setMode({ kind: "view" });
                  return true;
                }}
                onCancel={() => setMode({ kind: "view" })}
              />
            )}

            {mode.kind === "view" &&
              (current ? (
                <>
                  <header className="page-header mb-5 flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1 space-y-2">
                      <SectionLabel>{current.role === "internal" ? "Intranet side" : "Internet side"}</SectionLabel>
                      <h1 className="font-display text-2xl leading-tight font-semibold tracking-[-0.02em]">
                        {current.name}
                        <span className="text-gradient"> · {current.role === "internal" ? "内网端" : "外网端"}</span>
                      </h1>
                      <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted">
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

/** 首次使用：先选择当前环境，再了解完整同步路线。 */
function Welcome({ onNew, recommended }: { onNew: (r: Role) => void; recommended: Role }) {
  const steps = [
    ["内网准备", "克隆镜像，将全量包导出到 U 盘。"],
    ["外网开发", "导入内网包，克隆开发仓库，在分支或 worktree 中开发并提交。"],
    ["回传与推送", "将新提交带回内网，整理到主线或发布分支后推送。"],
    ["持续同步", "之后按序号交换增量包，只传输新增内容。"],
  ];
  return (
    <div className="welcome-layout">
      <section className="min-w-0 space-y-6">
        <SectionLabel>Offline git sync</SectionLabel>
        <h1 className="text-3xl leading-tight font-semibold tracking-tight">让内网与外网的<br /><span className="text-accent">Git 开发保持同步</span></h1>
        <p className="max-w-lg text-base leading-relaxed text-muted">通过 U 盘交换 Git 提交，在外网开发，在内网整理并推送。先为当前电脑创建一个同步配置。</p>
        <div className="grid gap-3">
          {(["internal", "external"] as Role[]).map((role) => (
            <div key={role} className="rounded-xl border border-border bg-surface p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-semibold">{role === "internal" ? "内网端" : "外网端"}</h2>
                {recommended === role && <span className="text-xs text-accent">适合当前系统</span>}
              </div>
              <p className="mb-4 text-sm text-muted">{role === "internal" ? "可访问 GitLab，负责导出、接收回传和推送。" : "使用 AI 等开发工具，导入内网包并回传提交。"}</p>
              <Button fullWidth variant={recommended === role ? "primary" : "outline"} onPress={() => onNew(role)}>
                新建{role === "internal" ? "内网端" : "外网端"}配置
              </Button>
            </div>
          ))}
        </div>
      </section>
      <aside className="rounded-2xl border border-border bg-surface p-6">
        <h2 className="mb-6 text-lg font-semibold">一次完整的同步</h2>
        <ol className="space-y-6">
          {steps.map(([title, description], i) => (
            <li key={title} className="flex gap-4">
              <span className="step-number shrink-0">{i + 1}</span>
              <div className="min-w-0 space-y-1"><h3 className="font-medium">{title}</h3><p className="text-sm leading-relaxed text-muted">{description}</p></div>
            </li>
          ))}
        </ol>
      </aside>
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
  onSave: (c: AppConfig) => boolean | void | Promise<boolean | void>;
  onCancel: () => void;
}) {
  const [gitPath, setGitPath] = useState(config.gitPath ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setSaving(true);
    setError("");
    try {
      if (await onSave({ ...config, gitPath: gitPath.trim() || undefined }) === false) setError("保存失败，请检查错误提示后重试。");
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  return (
    <Card className="form-page animate-enter gap-0 p-0">
      <Card.Header className="space-y-3 px-8 pt-8 pb-6">
        <SectionLabel>Settings</SectionLabel>
        <Card.Title className="font-display text-3xl font-normal">设置</Card.Title>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5 px-8 pb-8">
        {error && <p role="alert" className="text-danger">{error}</p>}
        <FormSection title="Git 环境" description="默认自动检测 Git。只有自动检测失败或需要指定版本时，才填写可执行文件路径。">
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
        </FormSection>
        <FormSection title="诊断信息" description="检查 Git 状态、配置位置和应用版本。这些信息由应用自动读取。">
        <div className="space-y-5">
        <TextInput label="当前检测结果" value={env ? ("Ok" in env.git ? env.git.Ok : env.git.Err) : "—"} isReadOnly mono />
        <TextInput label="配置文件位置" value={env?.configPath ?? "—"} isReadOnly mono />
        <TextInput
          label="应用版本"
          value={env ? `v${env.version}` : "—"}
          isReadOnly
          mono
          description="导出包的 manifest 里会记下这个版本（toolVersion）"
        />
        </div>
        </FormSection>
      </Card.Content>
      <Card.Footer className="flex flex-wrap justify-end gap-3 border-t border-border px-8 py-5">
        <Button variant="tertiary" onPress={onCancel} isDisabled={saving}>
          取消
        </Button>
        <Button variant="primary" onPress={save} isDisabled={saving}>
          {saving ? "保存并检测中…" : "保存并重新检测"}
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

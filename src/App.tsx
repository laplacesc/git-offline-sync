import { useEffect, useRef, useState } from "react";
import { Button, Card, Input, Label, ListBox, Select, Spinner, Toast } from "@heroui/react";
import type { Selection } from "@heroui/react";
import { api, AppConfig, Environment, newId, Profile, Role, Theme } from "./api";
import { ExternalView } from "./ExternalView";
import { InternalView } from "./InternalView";
import { LogPanel, useGitLog } from "./LogPanel";
import { blankProfile, ProfileEditor } from "./ProfileEditor";
import { Icon } from "./icons";
import { OperationStatus, RunnerProvider, useRunner } from "./runner";
import { AppGlyph, Code, FormSection, Notice, PathInput, SectionLabel, TextInput } from "./ui";
import { useTheme } from "./theme";
import "./index.css";

/**
 * macOS 使用 Overlay 标题栏（隐藏标题、保留红黄绿按钮），需要自己提供可拖动区域；
 * Windows 保留原生标题栏，不需要。
 */
const IS_MAC = navigator.userAgent.includes("Mac");

/** 标题栏拖动条：只在 macOS 显示，双击最大化 */
function TitleBarDrag({ className = "" }: { className?: string }) {
  if (!IS_MAC) return null;
  return <div data-tauri-drag-region className={"titlebar-drag " + className} />;
}

type Mode = { kind: "view" } | { kind: "edit"; profile: Profile; isNew: boolean } | { kind: "settings" };

function Shell() {
  const { busy, notify, confirm } = useRunner();
  const [config, setConfig] = useState<AppConfig | null>(null);
  useTheme(config?.theme);
  const [env, setEnv] = useState<Environment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [profileSearch, setProfileSearch] = useState("");
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
  const query = profileSearch.trim().toLocaleLowerCase();
  const visibleProfiles = config.profiles.filter((p) => `${p.name} ${p.repoName}`.toLocaleLowerCase().includes(query));
  let workspaceTitle = current?.name ?? "同步工作区";
  if (mode.kind === "settings") workspaceTitle = "设置";
  if (mode.kind === "edit") workspaceTitle = mode.isNew ? "新建同步配置" : "编辑同步配置";

  return (
    <div className="app-shell" data-sidebar-open={sidebarOpen} data-platform={IS_MAC ? "mac" : "other"}>
      <a href="#main-content" className="skip-link">跳到主要内容</a>
      <aside id="app-sidebar" className="app-sidebar" aria-label="工作区导航" hidden={!sidebarOpen}>
        <TitleBarDrag />
        <div className="app-brand">
          <span className="brand-mark"><AppGlyph className="size-5" /></span>
          <span className="font-semibold">Git 离线同步</span>
        </div>
        <div className="sidebar-tools">
          <Button fullWidth variant="ghost" className="new-profile-button" onPress={() => startNew(recommended)} isDisabled={!!busy || mode.kind === "edit"}>
            <Icon name="plus" />新建配置
          </Button>
          <div className="profile-search">
            <Icon name="search" />
            <Input aria-label="搜索同步配置" placeholder="搜索配置…" value={profileSearch} onChange={(event) => setProfileSearch(event.target.value)} />
          </div>
        </div>
        <div className="app-profiles-title"><span>同步配置</span><span>{config.profiles.length}</span></div>
        <div className="app-profile-list">
          {visibleProfiles.length === 0 ? (
            <p className="sidebar-empty" role="status">{config.profiles.length ? "没有匹配的配置" : "还没有配置，点击上方新建。"}</p>
          ) : (
            <ListBox
              aria-label="同步配置"
              disabledKeys={busy || mode.kind === "edit" ? config.profiles.map((p) => p.id) : []}
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={selectedKeys}
              onSelectionChange={(keys) => {
                const id = keys === "all" ? undefined : [...keys][0];
                if (id) select(String(id));
              }}
              className="profile-listbox"
            >
              {visibleProfiles.map((p) => (
                <ListBox.Item key={p.id} id={p.id} textValue={p.name} className="profile-item">
                  <Icon name="folder" />
                  <span className="flex-1 truncate" title={p.name}>{p.name}</span>
                  <span className="profile-role">{p.role === "internal" ? "内网" : "外网"}</span>
                </ListBox.Item>
              ))}
            </ListBox>
          )}
        </div>
        <div className="app-sidebar-footer">
          <div className="sidebar-environment">
            <span className={"status-dot " + gitBits.dot} />
            <span className="truncate">{gitBits.text}</span>
            {env && <span className="ml-auto">v{env.version}</span>}
          </div>
          <Button fullWidth variant="ghost" className="settings-button" isDisabled={!!busy || mode.kind === "edit"}
            aria-label="打开设置" aria-pressed={mode.kind === "settings"} onPress={() => setMode({ kind: "settings" })}>
            <Icon name="settings" /><span>设置</span>
          </Button>
        </div>
      </aside>

      <main id="main-content" tabIndex={-1} className="app-main">
        <header className="workspace-toolbar" data-tauri-drag-region>
          <Button isIconOnly size="sm" variant="ghost" className="sidebar-toggle" aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
            aria-expanded={sidebarOpen} aria-controls="app-sidebar" onPress={() => setSidebarOpen(!sidebarOpen)}>
            <Icon name="panel" />
          </Button>
          <div className="workspace-title" data-tauri-drag-region>
            <span className="truncate" title={workspaceTitle} data-tauri-drag-region>{workspaceTitle}</span>
            {mode.kind === "view" && current && <span className="role-badge">{current.role === "internal" ? "内网端" : "外网端"}</span>}
          </div>
          {mode.kind === "view" && current && <Button size="sm" variant="ghost" isDisabled={!!busy}
            onPress={() => setMode({ kind: "edit", profile: current, isNew: false })}>
            <Icon name="settings" />编辑配置
          </Button>}
        </header>
        <OperationStatus />
        <div ref={contentRef} className="workspace-scroll">
          <div className="workspace-content">
            {env && !gitOk && (
              <div className="mb-5">
                <Notice tone="danger" title="找不到可用的 git">
                  {"Err" in env.git ? env.git.Err : ""}。请安装 Git，或在设置中指定 git 可执行文件路径。
                </Notice>
              </div>
            )}
            {mode.kind === "edit" && <ProfileEditor key={mode.profile.id} initial={mode.profile} isNew={mode.isNew}
              onSave={saveProfile} onCancel={() => setMode({ kind: "view" })}
              onDelete={mode.isNew ? undefined : () => deleteProfile(mode.profile)} />}
            {mode.kind === "settings" && <Settings config={config} env={env}
              onSave={async (c) => {
                if (!await persist(c)) return false;
                setEnv(await api.environment().catch(() => null));
                setMode({ kind: "view" });
                return true;
              }} onCancel={() => setMode({ kind: "view" })} />}
            {mode.kind === "view" && (current ? (
              <>
                <section className="workspace-summary" aria-label="当前同步配置">
                  <div className="workspace-heading">
                    <h1>同步工作区</h1>
                    <p>{current.role === "internal" ? "管理镜像、导出内网包，并接收外网回传。" : "导入内网包，在开发仓库中工作，再将提交带回内网。"}</p>
                  </div>
                  <div className="workspace-metadata">
                    <span className="branch-meta"><Icon name="branch" /><span className="sr-only">主线分支</span><Code>{current.baseBranch}</Code></span>
                    {(current.releaseBranches?.length ?? 0) > 0 && <span title={current.releaseBranches?.join("\n")}>发布分支 {current.releaseBranches?.length} 个</span>}
                    <span className="transfer-meta"><Icon name="folder" /><span className="sr-only">传输目录</span><span title={current.transferDir}>{current.transferDir}</span></span>
                  </div>
                </section>
                {current.role === "internal" ? <InternalView key={current.id} profile={current} /> : <ExternalView key={current.id} profile={current} />}
              </>
            ) : <Welcome onNew={startNew} recommended={recommended} />)}
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
      <section className="welcome-intro">
        <span className="welcome-mark"><AppGlyph className="size-8" /></span>
        <h1>从一个同步配置开始</h1>
        <p>用 U 盘连接内网与外网的 Git 工作流。<br />选择当前电脑的角色，配置仓库和传输目录。</p>
        <div className="welcome-roles">
          {(["internal", "external"] as Role[]).map((role) => (
            <div key={role} className="welcome-role">
              <Icon name={role === "internal" ? "monitor" : "globe"} />
              <div className="welcome-role-heading">
                <h2>{role === "internal" ? "内网端" : "外网端"}</h2>
                {recommended === role && <span className="role-badge">当前系统推荐</span>}
              </div>
              <p>{role === "internal" ? "连接 GitLab，导出内网包，接收回传并推送。" : "导入同步包，在开发仓库中提交，再回传到内网。"}</p>
              <Button fullWidth variant={recommended === role ? "primary" : "secondary"} onPress={() => onNew(role)}>
                新建{role === "internal" ? "内网端" : "外网端"}配置
              </Button>
            </div>
          ))}
        </div>
      </section>
      <section className="welcome-guide" aria-label="同步流程说明">
        <h2>一次完整的同步</h2>
        <ol>
          {steps.map(([title, description], i) => (
            <li key={title}>
              <span className="step-number" aria-hidden="true">{i + 1}</span>
              <div><h3>{title}</h3><p>{description}</p></div>
            </li>
          ))}
        </ol>
      </section>
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
  const [theme, setTheme] = useState<Theme>(config.theme ?? "system");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setSaving(true);
    setError("");
    try {
      if (await onSave({ ...config, theme, gitPath: gitPath.trim() || undefined }) === false) setError("保存失败，请检查错误提示后重试。");
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  return (
    <Card className="form-page gap-0 p-0">
      <Card.Header className="form-page-header">
        <SectionLabel>应用偏好</SectionLabel>
        <Card.Title className="text-xl font-semibold">设置</Card.Title>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5 px-8 pb-8">
        {error && <p role="alert" className="text-danger">{error}</p>}
        <FormSection title="外观" description="选择应用主题，保存后生效。系统模式会自动跟随系统的浅色或深色设置。">
          <Select value={theme} onChange={(value) => {
            if (value === "system" || value === "light" || value === "dark") setTheme(value);
          }} isDisabled={saving} className="theme-select">
            <Label>主题</Label>
            <Select.Trigger aria-label="主题" className="theme-select-trigger">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {([{ value: "system", label: "系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" }] as const).map((option) => (
                  <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                    {option.label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </FormSection>
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

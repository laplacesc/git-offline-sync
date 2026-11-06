import { useEffect, useRef, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { api, AppConfig, Environment, newId, Profile, Role } from "./api";
import { ExternalView } from "./ExternalView";
import { InternalView } from "./InternalView";
import { LogPanel, useGitLog } from "./LogPanel";
import { blankProfile, ProfileEditor } from "./ProfileEditor";
import { Icon } from "./icons";
import { Feedback, OperationStatus, RunnerProvider, useRunner } from "./runner";
import { AppGlyph, PathInput, TextInput } from "./ui";
import { UpdatePanel } from "./UpdatePanel";
import { WindowControls } from "./WindowControls";
import { startAutoCheck } from "./updater";
import { useInputModality } from "./motion";
import { useAppearance, type AppearancePreference } from "./appearance";
import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group";
import { Label } from "./components/ui/label";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./index.css";

type Mode = { kind: "view" } | { kind: "edit"; profile: Profile; isNew: boolean } | { kind: "settings" };

function Shell() {
  const platform = navigator.userAgent.includes("Windows") ? "windows" : navigator.userAgent.includes("Mac") ? "mac" : "other";
  useInputModality();
  const { appearance, preference, setPreference } = useAppearance();
  const { busy, run, confirm, notify, operations, clearOperations } = useRunner();
  useEffect(() => {
    if (platform !== "mac" || !isTauri()) return;
    let active = true;
    const appWindow = getCurrentWindow();
    void Promise.all([
      appWindow.setTheme(appearance),
      appWindow.setBackgroundColor(appearance === "dark" ? "#181818" : "#ffffff"),
    ]).catch((error) => { if (active) notify("error", `更新标题栏外观失败：${String(error)}`); });
    return () => { active = false; };
  }, [appearance, platform, notify]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [savingConfig, setSavingConfig] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(() => !window.matchMedia("(max-width: 800px)").matches);
  const contentRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const newConfigButtonRef = useRef<HTMLButtonElement>(null);
  const logButtonRef = useRef<HTMLButtonElement>(null);
  const log = useGitLog();

  useEffect(() => startAutoCheck(), []);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 800px)");
    const collapse = () => { if (narrow.matches) setProjectsOpen(false); };
    narrow.addEventListener("change", collapse);
    return () => narrow.removeEventListener("change", collapse);
  }, []);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [config?.lastProfileId]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoadError(null);
        const cfg = await api.loadConfig();
        if (!cancelled) setConfig({ ...cfg, profiles: cfg.profiles ?? [] });
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
      const environment = await api.environment().catch(() => null);
      if (!cancelled) setEnv(environment);
    })();
    return () => { cancelled = true; };
  }, [loadAttempt]);

  const persist = async (next: AppConfig) => {
    setSavingConfig(true);
    try {
      const saved = await run("保存配置", async () => { await api.saveConfig(next); return true; });
      if (!saved) return false;
      setConfig(next);
      return true;
    } finally {
      setSavingConfig(false);
    }
  };

  const current = config?.profiles.find((p) => p.id === config.lastProfileId) ?? config?.profiles[0];
  const locked = !!busy || savingConfig || mode.kind !== "view";
  const selectProfile = async (id: string) => {
    if (!config || locked) return;
    const saved = id === current?.id || await persist({ ...config, lastProfileId: id });
    if (saved) closeNavigation();
  };
  const startNew = (role: Role, returnFocus: HTMLElement | null = document.activeElement as HTMLElement | null) => {
    dialogReturnFocus.current = returnFocus;
    setMode({ kind: "edit", profile: blankProfile(role, newId()), isNew: true });
  };
  const saveProfile = async (p: Profile) => {
    if (!config) return false;
    const exists = config.profiles.some((x) => x.id === p.id);
    const profiles = exists ? config.profiles.map((x) => (x.id === p.id ? p : x)) : [...config.profiles, p];
    const saved = await persist({ ...config, profiles, lastProfileId: p.id });
    if (saved) {
      setMode({ kind: "view" });
    }
    return saved;
  };
  const deleteProfile = async (p: Profile) => {
    if (!config || savingConfig) return;
    const ok = await confirm({
      title: `删除配置“${p.name}”`,
      body: <p className="text-sm text-muted-foreground">只删除本工具中的配置，不会删除任何仓库或文件。</p>,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    const profiles = config.profiles.filter((x) => x.id !== p.id);
    if (await persist({ ...config, profiles, lastProfileId: profiles[0]?.id })) {
      setMode({ kind: "view" });
    }
  };
  const closeDialog = () => {
    if (savingConfig) return;
    // 复用表单取消入口，让 Escape 同样遵守未保存修改确认及保存中禁用规则。
    const cancel = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((button) => button.textContent?.trim() === "取消");
    cancel?.click();
  };
  const closeLog = (open: boolean) => {
    setLogOpen(open);
    if (!open) (projectsOpen ? logButtonRef : navigationButtonRef).current?.focus();
  };
  let dialogTitle = "设置";
  if (mode.kind === "edit") dialogTitle = mode.isNew ? "新建同步配置" : "编辑同步配置";
  const closeNavigation = () => {
    if (window.matchMedia("(max-width: 800px)").matches) {
      setProjectsOpen(false);
      navigationButtonRef.current?.focus();
    }
  };

  return (
    <div className="app-shell app-surface" data-platform={platform} data-projects-open={projectsOpen}>
      <a href="#main-content" className="skip-link">跳到主要内容</a>
      <main id="main-content" tabIndex={-1} className="app-window" aria-label="Git 离线同步">
        <div className="window-drag-region" data-tauri-drag-region="deep" aria-hidden="true" />
        <Button type="button" ref={navigationButtonRef} className="navigation-toggle" size="icon-sm" variant="ghost" aria-label={projectsOpen ? "收起配置列表" : "展开配置列表"}
          aria-expanded={projectsOpen} aria-controls="project-navigation" onClick={() => setProjectsOpen((open) => !open)}>
          <Icon name="panel" />
        </Button>
        <WindowControls />
          <nav id="project-navigation" className="sidebar" aria-label="工作区导航" hidden={!projectsOpen}>
            <div className="sidebar-header">
              <h2>同步项目</h2>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button ref={newConfigButtonRef} type="button" size="icon-sm" variant="ghost" aria-label="新建配置" disabled={locked || !config}>
                    <span title="新建配置"><Icon name="plus" /></span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" aria-label="新建同步配置">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={() => { if (!locked && config) startNew("internal", newConfigButtonRef.current); }}><Icon name="plus" />新建内网端配置</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => { if (!locked && config) startNew("external", newConfigButtonRef.current); }}><Icon name="plus" />新建外网端配置</DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <ul className="profile-navigation-list" aria-label="配置文件">
              {(config?.profiles ?? []).map((profile) => (
                <li key={profile.id}>
                  <Button type="button" className="profile-navigation-item" variant="ghost" aria-label={`切换配置：${profile.name}`}
                    aria-current={profile.id === current?.id ? "page" : undefined} disabled={locked}
                    onClick={() => void selectProfile(profile.id)}>
                    <Icon name="folder" />
                    <span className="profile-navigation-copy">
                      <span className="profile-navigation-name" title={profile.name}>{profile.name}</span>
                      <span className="profile-navigation-scope" title={profile.repoName}>{profile.role === "internal" ? "内网端" : "外网端"} · {profile.repoName}</span>
                    </span>
                  </Button>
                </li>
              ))}
              {config && !config.profiles.length && <li className="profile-navigation-empty">暂无配置</li>}
            </ul>
            <div className="sidebar-footer">
              <Button type="button" size="icon-sm" variant="ghost" aria-label="打开设置" disabled={locked || !config}
                onClick={(event) => { dialogReturnFocus.current = event.currentTarget; setMode({ kind: "settings" }); }}><Icon name="settings" /></Button>
              <Button type="button" ref={logButtonRef} size="icon-sm" variant="ghost" aria-label={logOpen ? "收起记录" : "查看记录"}
                aria-expanded={logOpen} aria-controls={logOpen ? "operation-records" : undefined}
                onClick={() => { closeLog(!logOpen); closeNavigation(); }}>
                <span title={logOpen ? "收起操作记录" : "操作记录"}><Icon name="terminal" /></span>
              </Button>
              {env && <span className="sidebar-version">v{env.version}</span>}
            </div>
          </nav>
          <div className="workspace">
            <header className="workspace-toolbar" data-tauri-drag-region="deep">
              <span className="workspace-title">{current?.name ?? "Git 离线同步"}</span>
              {current && <span className="workspace-role">{current.role === "internal" ? "内网端" : "外网端"}</span>}
              <Button type="button" size="icon-sm" variant="ghost" aria-label="编辑当前配置" disabled={locked || !current}
                onClick={(event) => { if (current) { dialogReturnFocus.current = event.currentTarget; setMode({ kind: "edit", profile: current, isNew: false }); } }}>
                <Icon name="settings" />
              </Button>
            </header>
            <OperationStatus />
            <div ref={contentRef} className="page-scroll">
              <div className="page-content">
                {loadError ? <div className="space-y-4">
                  <Feedback kind="error" text={`无法读取同步配置\n${loadError}`} />
                  <Button type="button" onClick={() => setLoadAttempt((n) => n + 1)}>重新读取配置</Button>
                </div> : !config ? <Feedback kind="progress" text="正在读取配置…" /> : <>
                  {env && "Err" in env.git && <Feedback kind="error" text={`找不到可用的 git\n${env.git.Err}。请安装 Git，或在设置中指定 git 可执行文件路径。`} />}
                  {current ? (current.role === "internal"
                    ? <InternalView key={current.id} profile={current} refreshVersion={refreshVersion} />
                    : <ExternalView key={current.id} profile={current} refreshVersion={refreshVersion} />)
                    : <div className="welcome-page">
                      <AppGlyph className="welcome-glyph" />
                      <h1>添加同步项目</h1>
                      <p>选择当前电脑的角色，配置仓库和传输目录。</p>
                      <div className="welcome-actions">
                        <Button type="button" onClick={(event) => startNew("internal", event.currentTarget)} disabled={locked}>新建内网端配置</Button>
                        <Button type="button" variant="secondary" onClick={(event) => startNew("external", event.currentTarget)} disabled={locked}>新建外网端配置</Button>
                      </div>
                    </div>}
                </>}
              </div>
            </div>

            {logOpen && <div id="operation-records" onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); closeLog(false); }
            }}>
              <LogPanel lines={log.lines} operations={operations} clear={() => { log.clear(); clearOperations(); }} open setOpen={closeLog} />
            </div>}
          </div>
      </main>
      <Dialog open={mode.kind !== "view"} onOpenChange={(open) => { if (!open) closeDialog(); }}>
          <DialogContent className={`app-dialog app-surface${mode.kind === "settings" ? " settings-dialog" : ""}`} aria-label={dialogTitle} aria-describedby={undefined} showCloseButton={false}
            topLayer={<><WindowControls inline /><OperationStatus inline /></>}
            onCloseAutoFocus={(event) => { event.preventDefault(); if (dialogReturnFocus.current?.isConnected) dialogReturnFocus.current.focus(); }}
            onEscapeKeyDown={(event) => { event.preventDefault(); if (!savingConfig) closeDialog(); }}
            onPointerDownOutside={(event) => event.preventDefault()} onInteractOutside={(event) => event.preventDefault()}>
            <DialogTitle className="sr-only">{dialogTitle}</DialogTitle>
            <div ref={dialogRef} className="app-dialog-body">
              {mode.kind === "edit" && <ProfileEditor key={mode.profile.id} initial={mode.profile} isNew={mode.isNew}
                onSave={saveProfile} onCancel={() => setMode({ kind: "view" })}
                onDelete={mode.isNew ? undefined : () => deleteProfile(mode.profile)} />}
              {mode.kind === "settings" && config && <Settings config={config} env={env} preference={preference} onAppearanceChange={setPreference}
                onSave={async (next) => {
                  if (!await persist(next)) return false;
                  setEnv(await api.environment().catch(() => null));
                  setRefreshVersion((version) => version + 1);
                  setMode({ kind: "view" });
                  return true;
                }} onCancel={() => setMode({ kind: "view" })} />}
            </div>
          </DialogContent>
      </Dialog>
    </div>
  );
}

function Settings({
  config,
  env,
  preference,
  onAppearanceChange,
  onSave,
  onCancel,
}: {
  config: AppConfig;
  env: Environment | null;
  preference: AppearancePreference;
  onAppearanceChange: (preference: AppearancePreference) => void;
  onSave: (c: AppConfig) => boolean | void | Promise<boolean | void>;
  onCancel: () => void;
}) {
  const { notify } = useRunner();
  const [gitPath, setGitPath] = useState(config.gitPath ?? "");
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const discardReturnFocus = useRef<HTMLElement | null>(null);
  const dirty = gitPath !== (config.gitPath ?? "");
  async function save() {
    setSaving(true);
    try {
      await onSave({ ...config, gitPath: gitPath.trim() || undefined });
    } catch (e) { notify("error", `保存失败：${String(e)}`); }
    finally { setSaving(false); }
  }
  return (
    <div className="settings-layout">
      <nav className="settings-navigation" aria-label="设置导航">
        <Button type="button" className="settings-back" variant="ghost" disabled={saving} onClick={() => dirty ? setDiscardOpen(true) : onCancel()}>
          <Icon name="chevron" className="rotate-180" />返回应用
        </Button>
        <h2>偏好</h2>
        <a href="#settings-appearance" onClick={(event) => { event.preventDefault(); document.getElementById("settings-appearance")?.scrollIntoView({ block: "start" }); }}><Icon name="monitor" />外观</a>
        <a href="#settings-git" onClick={(event) => { event.preventDefault(); document.getElementById("settings-git")?.scrollIntoView({ block: "start" }); }}><Icon name="terminal" />Git 环境</a>
        <h2>系统</h2>
        <a href="#settings-updates" onClick={(event) => { event.preventDefault(); document.getElementById("settings-updates")?.scrollIntoView({ block: "start" }); }}><Icon name="refresh" />版本更新</a>
        <a href="#settings-diagnostics" onClick={(event) => { event.preventDefault(); document.getElementById("settings-diagnostics")?.scrollIntoView({ block: "start" }); }}><Icon name="folder" />诊断信息</a>
      </nav>
      <form noValidate className="settings-form" onSubmit={(event) => { event.preventDefault(); if (!saving) void save(); }}>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent className="app-surface" topLayer={<><WindowControls inline /><OperationStatus inline /></>}
          onOpenAutoFocus={() => { discardReturnFocus.current = document.activeElement as HTMLElement | null; }}
          onCloseAutoFocus={(event) => { event.preventDefault(); if (discardReturnFocus.current?.isConnected) discardReturnFocus.current.focus(); }}>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle>
            <AlertDialogDescription>Git 路径的修改尚未保存。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">继续编辑</AlertDialogCancel>
            <AlertDialogAction type="button" variant="destructive" onClick={onCancel}>放弃修改</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
        <div className="settings-scroll">
          <div className="settings-content">
            <h1>设置</h1>
            <section id="settings-appearance" className="settings-section" aria-labelledby="settings-appearance-title">
              <h2 id="settings-appearance-title">外观</h2>
              <div className="settings-tile settings-row">
                <div className="settings-copy"><h3>主题</h3><p>跟随系统、浅色或深色。立即应用并保存在本机。</p></div>
                <RadioGroup aria-label="主题" className="appearance-options" value={preference}
                  onValueChange={(value) => { if (value === "light" || value === "dark" || value === "system") onAppearanceChange(value); }}>
                  <Label className="appearance-option"><RadioGroupItem value="system" />跟随系统</Label>
                  <Label className="appearance-option"><RadioGroupItem value="light" />浅色</Label>
                  <Label className="appearance-option"><RadioGroupItem value="dark" />深色</Label>
                </RadioGroup>
              </div>
            </section>
            <section id="settings-git" className="settings-section" aria-labelledby="settings-git-title">
              <h2 id="settings-git-title">Git 环境</h2>
              <div className="settings-tile">
                <PathInput label="git 可执行文件" value={gitPath} onChange={setGitPath} directory={false}
                  placeholder="留空则使用 PATH 中的 git"
                  description={env?.os === "windows"
                    ? "默认自动检测。需要指定版本时，填写路径，例如 C:\\Program Files\\Git\\cmd\\git.exe。"
                    : "默认自动检测。需要指定版本时，填写路径，例如 /usr/bin/git。"} />
              </div>
            </section>
            <section id="settings-updates" className="settings-section" aria-labelledby="settings-updates-title">
              <h2 id="settings-updates-title">版本更新</h2>
              <div className="settings-tile">
                <UpdatePanel currentVersion={env?.version} />
                <p className="mt-3 text-xs text-muted-foreground">从 GitHub Releases 检查新版本。内网离线环境可在外网下载安装包后拷贝安装。</p>
              </div>
            </section>
            <section id="settings-diagnostics" className="settings-section" aria-labelledby="settings-diagnostics-title">
              <h2 id="settings-diagnostics-title">诊断信息</h2>
              <div className="settings-tile">
                <TextInput label="当前检测结果" value={env ? ("Ok" in env.git ? env.git.Ok : env.git.Err) : "—"} readOnly />
                <TextInput label="配置文件位置" value={env?.configPath ?? "—"} readOnly />
                <TextInput label="应用版本" value={env ? `v${env.version}` : "—"} readOnly description="导出包的 manifest 里会记下这个版本（toolVersion）" />
              </div>
            </section>
          </div>
        </div>
        <footer className="settings-footer">
          <Button type="button" variant="secondary" onClick={() => dirty ? setDiscardOpen(true) : onCancel()} disabled={saving}>取消</Button>
          <Button type="submit" disabled={saving} aria-busy={saving}>保存并重新检测</Button>
        </footer>
      </form>
    </div>
  );
}

export default function App() {
  return (
    <RunnerProvider>
      <Shell />
    </RunnerProvider>
  );
}

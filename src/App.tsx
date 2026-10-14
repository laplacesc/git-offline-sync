import { useEffect, useRef, useState } from "react";
import { Button, Card, Dropdown, Header, Input, ListBox, Spinner, Toast } from "@heroui/react";
import type { Selection } from "@heroui/react";
import { api, AppConfig, Environment, newId, Profile, Role } from "./api";
import { ExternalView } from "./ExternalView";
import { InternalView } from "./InternalView";
import { LogPanel, useGitLog } from "./LogPanel";
import { blankProfile, ProfileEditor } from "./ProfileEditor";
import { Icon } from "./icons";
import { OperationStatus, RunnerProvider, useRunner } from "./runner";
import { AppGlyph, Code, FormSection, Notice, PathInput, SectionLabel, TextInput } from "./ui";
import { UpdatePanel, VersionChip } from "./UpdatePanel";
import { startAutoCheck } from "./updater";
import { useAppearance } from "./appearance";
import { useDisclosureMotion, useInputModality } from "./motion";
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
  useInputModality();
  const { preference, setPreference } = useAppearance();
  const appearanceLabel = preference === "system" ? "跟随系统" : preference === "light" ? "浅色" : "深色";
  const { busy, error, notify, confirm, operations, clearOperations } = useRunner();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => startAutoCheck(), []);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [smallScreen, setSmallScreen] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia("(max-width: 1023px)").matches);
  const sidebarMotion = useDisclosureMotion<HTMLElement>(sidebarOpen, "drawer", smallScreen);
  const sidebarRef = sidebarMotion.ref;
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => { setSmallScreen(media.matches); setSidebarOpen(!media.matches); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!smallScreen || !sidebarOpen) return;
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const controls = () => [...sidebar.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
    controls()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setSidebarOpen(false); }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    sidebar.addEventListener("keydown", onKeyDown);
    return () => { sidebar.removeEventListener("keydown", onKeyDown); sidebarToggleRef.current?.focus(); };
  }, [smallScreen, sidebarOpen]);
  const [profileSearch, setProfileSearch] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const pageKey = mode.kind === "edit" ? mode.profile.id : config?.lastProfileId;
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [mode.kind, pageKey]);
  // 默认收起；仅出现错误时自动展开，正常执行不改变用户的展开选择
  const [logOpen, setLogOpen] = useState(false);
  const log = useGitLog();
  const logErrors = log.lines.filter((l) => l.kind === "error").length;
  useEffect(() => {
    if (error) setLogOpen(true);
  }, [error]);
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
    if (smallScreen) setSidebarOpen(false);
  };
  const startNew = (role: Role) => {
    setMode({ kind: "edit", profile: blankProfile(role, newId()), isNew: true });
    if (smallScreen) setSidebarOpen(false);
  };

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
      {smallScreen && sidebarMotion.visible && <button className="sidebar-backdrop" data-open={sidebarOpen}
        aria-hidden={!sidebarOpen} aria-label="关闭侧栏遮罩" tabIndex={-1} onClick={() => setSidebarOpen(false)} />}
      <aside ref={sidebarRef} id="app-sidebar" className="app-sidebar" aria-label="工作区导航" hidden={!sidebarMotion.visible}
        aria-hidden={!sidebarOpen} inert={!sidebarOpen}
        role={smallScreen && sidebarOpen ? "dialog" : undefined} aria-modal={smallScreen && sidebarOpen ? true : undefined}>
        <TitleBarDrag />
        <div className="app-brand">
          <span className="brand-mark"><AppGlyph className="size-5" /></span>
          <span className="brand-copy"><strong>Git 离线同步</strong><small>离线开发工作台</small></span>
          <Button isIconOnly size="sm" variant="ghost" className="sidebar-close" aria-label="关闭侧栏" onPress={() => setSidebarOpen(false)}>×</Button>
        </div>
        <div className="sidebar-tools">
          <Button fullWidth variant="ghost" className="new-profile-button" onPress={() => startNew(recommended)} isDisabled={!!busy || mode.kind === "edit"}>
            <Icon name="plus" />新建配置
          </Button>
          <div className="profile-search">
            <Icon name="search" />
            <Input aria-label="搜索同步配置" name="profile-search" autoComplete="off" placeholder="搜索配置…" value={profileSearch} onChange={(event) => setProfileSearch(event.target.value)} />
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
              {(["internal", "external"] as Role[]).filter((role) => visibleProfiles.some((p) => p.role === role)).map((role) => (
                <ListBox.Section key={role}>
                  <Header className="profile-group-label">{role === "internal" ? "内网端" : "外网端"}</Header>
                  {visibleProfiles.filter((p) => p.role === role).map((p) => (
                <ListBox.Item key={p.id} id={p.id} textValue={p.name} className="profile-item">
                  <Icon name="folder" />
                  <span className="flex-1 truncate" title={p.name}>{p.name}</span>
                  <span className="profile-role">{p.role === "internal" ? "内网" : "外网"}</span>
                </ListBox.Item>
                  ))}
                </ListBox.Section>
              ))}
            </ListBox>
          )}
        </div>
        <div className="app-sidebar-footer">
          <div className="sidebar-environment">
            <span className={"status-dot " + gitBits.dot} />
            <span className="truncate">{gitBits.text}</span>
            <span className="ml-auto" />
            <VersionChip version={env?.version} isDisabled={!!busy || mode.kind === "edit"}
              onOpenUpdates={() => setMode({ kind: "settings" })} />
          </div>
          <Button fullWidth variant="ghost" className="settings-button" isDisabled={!!busy || mode.kind === "edit"}
            aria-label="打开设置" aria-pressed={mode.kind === "settings"} onPress={() => { setMode({ kind: "settings" }); if (smallScreen) setSidebarOpen(false); }}>
            <Icon name="settings" /><span>设置</span>
          </Button>
        </div>
      </aside>

      <main id="main-content" tabIndex={-1} className="app-main" inert={smallScreen && sidebarOpen}>
        <header className="workspace-toolbar" data-tauri-drag-region>
          <Button ref={sidebarToggleRef} isIconOnly size="sm" variant="ghost" className="sidebar-toggle" aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
            aria-expanded={sidebarOpen} aria-controls="app-sidebar" onPress={() => setSidebarOpen(!sidebarOpen)}>
            <Icon name="panel" />
          </Button>
          <div className="workspace-title" data-tauri-drag-region>
            <span className="truncate" title={workspaceTitle} data-tauri-drag-region>{workspaceTitle}</span>
            {mode.kind === "view" && current && <span className="role-badge">{current.role === "internal" ? "内网端" : "外网端"}</span>}
          </div>
          <Dropdown>
            <Button isIconOnly size="sm" variant="ghost" aria-label={`外观：${appearanceLabel}`}>
              <Icon name={preference === "system" ? "monitor" : preference === "light" ? "sun" : "moon"} />
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu aria-label="选择外观" selectionMode="single" disallowEmptySelection
                selectedKeys={new Set([preference])} onAction={(key) => {
                  if (key === "light" || key === "dark" || key === "system") setPreference(key);
                }}>
                <Dropdown.Item id="light" textValue="浅色"><Icon name="sun" />浅色<Dropdown.ItemIndicator /></Dropdown.Item>
                <Dropdown.Item id="dark" textValue="深色"><Icon name="moon" />深色<Dropdown.ItemIndicator /></Dropdown.Item>
                <Dropdown.Item id="system" textValue="跟随系统"><Icon name="monitor" />跟随系统<Dropdown.ItemIndicator /></Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
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
                    <span className="workspace-eyebrow">{current.role === "internal" ? "内网同步工作区" : "外网开发工作区"}</span>
                    <h1>{current.name}</h1>
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
        <LogPanel lines={log.lines} operations={operations} clear={() => { log.clear(); clearOperations(); }} open={logOpen} setOpen={setLogOpen} />
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
    <Card className="form-page gap-0 p-0">
      <Card.Header className="form-page-header">
        <SectionLabel>应用偏好</SectionLabel>
        <Card.Title className="text-xl font-semibold">设置</Card.Title>
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
        <FormSection title="版本更新" description="从 GitHub Releases 检查新版本，下载完成后重启即可更新。内网离线环境无法检查，可在外网下载安装包后拷贝安装。">
          <UpdatePanel currentVersion={env?.version} />
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

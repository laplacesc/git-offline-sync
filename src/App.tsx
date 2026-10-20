import { useEffect, useRef, useState } from "react";
import { AlertDialog, Button, Card, Dropdown, Form, Link, Modal } from "@heroui/react";
import { api, AppConfig, Environment, newId, Profile, Role } from "./api";
import { ExternalView } from "./ExternalView";
import { InternalView } from "./InternalView";
import { LogPanel, useGitLog } from "./LogPanel";
import { blankProfile, ProfileEditor } from "./ProfileEditor";
import { Icon } from "./icons";
import { Feedback, OperationStatus, RunnerProvider, useRunner } from "./runner";
import { AppGlyph, FormSection, PathInput, TextInput } from "./ui";
import { UpdatePanel } from "./UpdatePanel";
import { WindowControls } from "./WindowControls";
import { startAutoCheck } from "./updater";
import { useAppearance } from "./appearance";
import { useInputModality } from "./motion";
import "./index.css";

type Mode = { kind: "view" } | { kind: "edit"; profile: Profile; isNew: boolean } | { kind: "settings" };

function Shell() {
  const platform = navigator.userAgent.includes("Windows") ? "windows" : navigator.userAgent.includes("Mac") ? "mac" : "other";
  useInputModality();
  const { preference, setPreference } = useAppearance();
  const appearanceLabel = preference === "system" ? "跟随系统" : preference === "light" ? "浅色" : "深色";
  const { busy, notify, run, confirm, operations, clearOperations } = useRunner();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [savingConfig, setSavingConfig] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(() => !window.matchMedia("(max-width: 800px)").matches);
  const [navigationTarget, setNavigationTarget] = useState<HTMLDivElement | null>(null);
  const [branchTarget, setBranchTarget] = useState<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
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
  const startNew = (role: Role) => {
    setMode({ kind: "edit", profile: blankProfile(role, newId()), isNew: true });
  };
  const saveProfile = async (p: Profile) => {
    if (!config) return false;
    const exists = config.profiles.some((x) => x.id === p.id);
    const profiles = exists ? config.profiles.map((x) => (x.id === p.id ? p : x)) : [...config.profiles, p];
    const saved = await persist({ ...config, profiles, lastProfileId: p.id });
    if (saved) {
      setMode({ kind: "view" });
      notify("ok", "同步配置已保存");
    }
    return saved;
  };
  const deleteProfile = async (p: Profile) => {
    if (!config || savingConfig) return;
    const ok = await confirm({
      title: `删除配置“${p.name}”`,
      body: <p className="text-sm text-muted">只删除本工具中的配置，不会删除任何仓库或文件。</p>,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    const profiles = config.profiles.filter((x) => x.id !== p.id);
    if (await persist({ ...config, profiles, lastProfileId: profiles[0]?.id })) {
      setMode({ kind: "view" });
      notify("ok", `已删除配置“${p.name}”`);
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
    <div className="app-shell compact-shell" data-platform={platform} data-projects-open={projectsOpen}>
      <Link href="#main-content" className="skip-link">跳到主要内容</Link>
      <main id="main-content" tabIndex={-1} className="compact-window">
        <header className="compact-toolbar" data-tauri-drag-region={platform === "other" ? true : "deep"}>
          <Button ref={navigationButtonRef} isIconOnly size="sm" variant="ghost" aria-label={projectsOpen ? "收起配置列表" : "展开配置列表"}
            aria-expanded={projectsOpen} aria-controls="project-navigation" onPress={() => setProjectsOpen((open) => !open)}>
            <Icon name="panel" />
          </Button>
          <div className="compact-brand"><span className="brand-mark"><AppGlyph className="size-[22px]" /></span><span>Git 离线同步</span></div>
          {platform === "windows" && <WindowControls />}
        </header>
        <div className="desktop-workspace">
          <nav id="project-navigation" className="project-navigation" aria-label="工作区导航" hidden={!projectsOpen}>
            <div className="profile-list-heading">
              <h2>配置文件</h2>
              <div className="profile-list-actions">
                <Button isIconOnly size="sm" variant="ghost" aria-label="编辑当前配置" isDisabled={locked || !current}
                  onPress={() => { if (current) setMode({ kind: "edit", profile: current, isNew: false }); }}>
                  <span title="编辑当前配置"><Icon name="settings" /></span>
                </Button>
                <Dropdown>
                  <Button isIconOnly size="sm" variant="ghost" aria-label="新建配置" isDisabled={locked || !config}>
                    <span title="新建配置"><Icon name="plus" /></span>
                  </Button>
                  <Dropdown.Popover placement="bottom start">
                    <Dropdown.Menu aria-label="新建同步配置" onAction={(key) => {
                      if (!locked && config && (key === "internal" || key === "external")) startNew(key);
                    }}>
                      <Dropdown.Item id="internal" textValue="新建内网端配置"><Icon name="plus" />新建内网端配置</Dropdown.Item>
                      <Dropdown.Item id="external" textValue="新建外网端配置"><Icon name="plus" />新建外网端配置</Dropdown.Item>
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown>
              </div>
            </div>
            <ul className="profile-navigation-list" aria-label="配置文件">
              {(config?.profiles ?? []).map((profile) => (
                <li key={profile.id}>
                  <Button className="profile-navigation-item" variant="ghost" aria-label={`切换配置：${profile.name}`}
                    aria-current={profile.id === current?.id ? "page" : undefined} isDisabled={locked}
                    onPress={() => void selectProfile(profile.id)}>
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
            <div ref={setNavigationTarget} hidden />
            <div className="workbench-footer">
              <div className="workbench-tools">
                <div ref={setBranchTarget} className="workbench-branch-entry" />
                <Button ref={logButtonRef} isIconOnly className="records-button" size="sm" variant="ghost" aria-label={logOpen ? "收起记录" : "查看记录"}
                  aria-expanded={logOpen} aria-controls={logOpen ? "operation-records" : undefined}
                  onPress={() => { closeLog(!logOpen); closeNavigation(); }}>
                  <span title={logOpen ? "收起操作记录" : "操作记录"}><Icon name="terminal" /></span>
                </Button>
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
                <Button isIconOnly size="sm" variant="ghost" aria-label="打开设置" isDisabled={locked || !config}
                  onPress={() => setMode({ kind: "settings" })}><Icon name="settings" /></Button>
              </div>
            </div>
          </nav>
          <div className="desktop-canvas">
            <OperationStatus />
            <div ref={contentRef} className="compact-scroll">
              <div className="compact-content">
                {loadError ? <div className="space-y-4">
                  <Feedback kind="error" text={`无法读取同步配置\n${loadError}`} />
                  <Button onPress={() => setLoadAttempt((n) => n + 1)}>重新读取配置</Button>
                </div> : !config ? <Feedback kind="progress" text="正在读取配置…" /> : <>
                  {env && "Err" in env.git && <Feedback kind="error" text={`找不到可用的 git\n${env.git.Err}。请安装 Git，或在设置中指定 git 可执行文件路径。`} />}
                  {current ? (current.role === "internal"
                    ? <InternalView key={current.id} profile={current} navigationTarget={navigationTarget} branchTarget={branchTarget} onNavigate={closeNavigation} />
                    : <ExternalView key={current.id} profile={current} navigationTarget={navigationTarget} branchTarget={branchTarget} onNavigate={closeNavigation} />)
                    : <div className="compact-welcome">
                      <h1>添加同步项目</h1>
                      <p>选择当前电脑的角色，配置仓库和传输目录。</p>
                      <div className="flex flex-wrap gap-3">
                        <Button onPress={() => startNew("internal")} isDisabled={locked}>新建内网端配置</Button>
                        <Button onPress={() => startNew("external")} isDisabled={locked}>新建外网端配置</Button>
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
        </div>
      </main>
      <Modal.Backdrop isOpen={mode.kind !== "view"} isDismissable={false} isKeyboardDismissDisabled={savingConfig}
        onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog className="compact-dialog" aria-label={dialogTitle}>
            <div ref={dialogRef}>
              {mode.kind === "edit" && <ProfileEditor key={mode.profile.id} initial={mode.profile} isNew={mode.isNew}
                onSave={saveProfile} onCancel={() => setMode({ kind: "view" })}
                onDelete={mode.isNew ? undefined : () => deleteProfile(mode.profile)} />}
              {mode.kind === "settings" && config && <Settings config={config} env={env}
                onSave={async (next) => {
                  if (!await persist(next)) return false;
                  setEnv(await api.environment().catch(() => null));
                  setMode({ kind: "view" });
                  notify("ok", "设置已保存并重新检测");
                  return true;
                }} onCancel={() => setMode({ kind: "view" })} />}
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
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
  const { notify } = useRunner();
  const [gitPath, setGitPath] = useState(config.gitPath ?? "");
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const dirty = gitPath !== (config.gitPath ?? "");
  async function save() {
    setSaving(true);
    try {
      await onSave({ ...config, gitPath: gitPath.trim() || undefined });
    } catch (e) { notify("error", `保存失败：${String(e)}`); }
    finally { setSaving(false); }
  }
  return (
    <Form className="form-page-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <Card className="form-page gap-0 p-0">
      <AlertDialog.Backdrop isOpen={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialog.Container><AlertDialog.Dialog>
          <AlertDialog.Header><AlertDialog.Heading>放弃未保存的修改？</AlertDialog.Heading></AlertDialog.Header>
          <AlertDialog.Body>Git 路径的修改尚未保存。</AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="tertiary" onPress={() => setDiscardOpen(false)}>继续编辑</Button>
            <Button variant="danger" onPress={onCancel}>放弃修改</Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog></AlertDialog.Container>
      </AlertDialog.Backdrop>
      <Card.Header className="form-page-header">
        <Card.Title render={(props) => <h1 {...props} />} className="text-xl font-semibold">设置</Card.Title>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5 px-8 pb-8">
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
        <Button variant="tertiary" onPress={() => dirty ? setDiscardOpen(true) : onCancel()} isDisabled={saving}>
          取消
        </Button>
        <Button variant="primary" type="submit" isDisabled={saving} aria-busy={saving}>
          保存并重新检测
        </Button>
      </Card.Footer>
    </Card>
    </Form>
  );
}

export default function App() {
  return (
    <RunnerProvider>
      <Shell />
    </RunnerProvider>
  );
}

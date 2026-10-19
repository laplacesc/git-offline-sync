import { useEffect, useRef, useState } from "react";
import { AlertDialog, Button, Card, Dropdown, Form, Link, Modal, Spinner, Toast } from "@heroui/react";
import { api, AppConfig, Environment, newId, Profile, Role } from "./api";
import { BackgroundScene } from "./BackgroundScene";
import { ExternalView } from "./ExternalView";
import { InternalView } from "./InternalView";
import { LogPanel, useGitLog } from "./LogPanel";
import { blankProfile, ProfileEditor } from "./ProfileEditor";
import { Icon } from "./icons";
import { OperationStatus, RunnerProvider, useRunner } from "./runner";
import { AppGlyph, FormSection, Notice, PathInput, SectionLabel, TextInput } from "./ui";
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
  const { busy, notify, confirm, operations, clearOperations } = useRunner();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [savingConfig, setSavingConfig] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const projectButtonRef = useRef<HTMLButtonElement>(null);
  const logButtonRef = useRef<HTMLButtonElement>(null);
  const log = useGitLog();

  useEffect(() => startAutoCheck(), []);
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
      await api.saveConfig(next);
      setConfig(next);
      return true;
    } catch (e) {
      notify("error", `保存配置失败：${String(e)}`);
      return false;
    } finally {
      setSavingConfig(false);
    }
  };

  const current = config?.profiles.find((p) => p.id === config.lastProfileId) ?? config?.profiles[0];
  const locked = !!busy || savingConfig || mode.kind !== "view";
  const startNew = (role: Role) => {
    setMode({ kind: "edit", profile: blankProfile(role, newId()), isNew: true });
  };
  const saveProfile = async (p: Profile) => {
    if (!config) return false;
    const exists = config.profiles.some((x) => x.id === p.id);
    const profiles = exists ? config.profiles.map((x) => (x.id === p.id ? p : x)) : [...config.profiles, p];
    const saved = await persist({ ...config, profiles, lastProfileId: p.id });
    if (saved) setMode({ kind: "view" });
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
    if (await persist({ ...config, profiles, lastProfileId: profiles[0]?.id })) setMode({ kind: "view" });
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
    if (!open) logButtonRef.current?.focus();
  };
  let dialogTitle = "设置";
  if (mode.kind === "edit") dialogTitle = mode.isNew ? "新建同步配置" : "编辑同步配置";
  const latest = [...operations].reverse().find((operation) => operation.endedAt !== undefined);
  let latestResult = "尚无操作记录";
  if (latest) {
    let result = "已完成";
    if (latest.failed) result = "失败";
    else if (latest.needsAttention) result = "需要处理，请查看结果";
    else if (latest.stopRequested) result = "已结束，请检查结果";
    latestResult = `${latest.label} · ${result}`;
  }

  return (
    <div className="app-shell compact-shell" data-platform={platform}>
      <BackgroundScene />
      <Link href="#main-content" className="skip-link">跳到主要内容</Link>
      <main id="main-content" tabIndex={-1} className="compact-window">
        <header className="compact-toolbar" data-tauri-drag-region={platform === "other" ? true : "deep"}>
          <div className="compact-brand"><span className="brand-mark"><AppGlyph className="size-[22px]" /></span><span>Git 离线同步</span></div>
          <div className="compact-toolbar-actions" data-tauri-drag-region={platform === "other" ? true : "deep"}>
            <Dropdown>
              <Button ref={projectButtonRef} className="compact-project" size="sm" variant="ghost" isDisabled={locked || !config}
                aria-label={`选择项目：${current?.name ?? "未配置"}`}>
                <span className="truncate" title={current?.name}>{current?.name ?? "选择项目"}</span><Icon name="chevron" />
              </Button>
              <Dropdown.Popover placement="bottom end" className="project-popover">
                <Dropdown.Menu aria-label="项目" onAction={(key) => {
                  if (locked || !config) return;
                  const action = String(key);
                  if (action.startsWith("profile:")) {
                    const id = action.slice("profile:".length);
                    if (id !== current?.id) void persist({ ...config, lastProfileId: id });
                  } else {
                    projectButtonRef.current?.focus();
                    if (action === "new:internal") startNew("internal");
                    else if (action === "new:external") startNew("external");
                    else if (action === "edit" && current) setMode({ kind: "edit", profile: current, isNew: false });
                  }
                }}>
                  {(config?.profiles ?? []).map((profile) => (
                    <Dropdown.Item key={profile.id} id={`profile:${profile.id}`} textValue={profile.name}>
                      <Icon name="folder" /><span className="project-menu-name" title={profile.name}>{profile.name}</span>
                      <span className="shrink-0 text-muted">{profile.role === "internal" ? "内网" : "外网"}</span>
                      {profile.id === current?.id && <span className="shrink-0 text-muted">当前</span>}
                    </Dropdown.Item>
                  ))}
                  <Dropdown.Item id="new:internal" textValue="新建内网端配置"><Icon name="plus" />新建内网端配置</Dropdown.Item>
                  <Dropdown.Item id="new:external" textValue="新建外网端配置"><Icon name="plus" />新建外网端配置</Dropdown.Item>
                  <Dropdown.Item id="edit" textValue="编辑当前项目" isDisabled={!current}><Icon name="settings" />编辑当前项目</Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
            {current && <span className="role-badge">{current.role === "internal" ? "内网端" : "外网端"}</span>}
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
          {platform === "windows" && <WindowControls />}
        </header>
        <OperationStatus />
        <div ref={contentRef} className="compact-scroll">
          <div className="compact-content">
            {loadError ? <div className="space-y-4">
              <Notice tone="danger" title="无法读取同步配置">{loadError}</Notice>
              <Button onPress={() => setLoadAttempt((n) => n + 1)}>重新读取配置</Button>
            </div> : !config ? <Spinner size="lg" aria-label="正在读取配置" /> : <>
              {env && "Err" in env.git && <Notice tone="danger" title="找不到可用的 git">
                {env.git.Err}。请安装 Git，或在设置中指定 git 可执行文件路径。
              </Notice>}
              {current ? (current.role === "internal"
                ? <InternalView key={current.id} profile={current} />
                : <ExternalView key={current.id} profile={current} />)
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
        <footer className="compact-footer">
          <span role="status">{latestResult}</span>
          <Button ref={logButtonRef} size="sm" variant="ghost" aria-expanded={logOpen} aria-controls={logOpen ? "operation-records" : undefined}
            onPress={() => closeLog(!logOpen)}>{logOpen ? "收起记录" : "查看记录"}</Button>
        </footer>
        {logOpen && <div id="operation-records" onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); closeLog(false); }
        }}>
          <LogPanel lines={log.lines} operations={operations} clear={() => { log.clear(); clearOperations(); }} open setOpen={closeLog} />
        </div>}
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
  const [gitPath, setGitPath] = useState(config.gitPath ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const dirty = gitPath !== (config.gitPath ?? "");
  async function save() {
    setSaving(true);
    setError("");
    try {
      if (await onSave({ ...config, gitPath: gitPath.trim() || undefined }) === false) setError("保存失败，请检查错误提示后重试。");
    } catch (e) { setError(String(e)); }
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
        <SectionLabel>应用偏好</SectionLabel>
        <Card.Title render={(props) => <h1 {...props} />} className="text-xl font-semibold">设置</Card.Title>
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
        <Button variant="tertiary" onPress={() => dirty ? setDiscardOpen(true) : onCancel()} isDisabled={saving}>
          取消
        </Button>
        <Button variant="primary" type="submit" isDisabled={saving}>
          {saving ? "保存并检测中…" : "保存并重新检测"}
        </Button>
      </Card.Footer>
    </Card>
    </Form>
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

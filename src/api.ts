import { invoke } from "@tauri-apps/api/core";

// ---------- 与 Rust 端对应的类型 ----------

export type Role = "internal" | "external";

export interface Profile {
  id: string;
  name: string;
  role: Role;
  /** 用于包文件命名，例如 proj → proj-out-0001-full.bundle */
  repoName: string;
  /** 主线分支（feature/、bugfix/ 的基准），也用于确定仓库身份 */
  baseBranch: string;
  /** 发布分支（hotfix/ 的基准），手动填写；老配置没有这个字段 */
  releaseBranches?: string[];
  /** U 盘 / 传输目录 */
  transferDir: string;
  // 内网端
  remoteUrl?: string;
  mirrorDir?: string;
  workDir?: string;
  // 外网端
  repoDir?: string;
  userName?: string;
  userEmail?: string;
}

export interface AppConfig {
  gitPath?: string;
  profiles: Profile[];
  lastProfileId?: string;
}

export interface Environment {
  os: string;
  git: { Ok: string } | { Err: string };
  configPath: string;
}

export interface CommitInfo {
  sha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface BranchInfo {
  name: string;
  sha: string;
  /** 该分支的基准分支（主线或发布分支） */
  base: string;
  /** 没有记录，按前缀推断出来的基准 */
  baseInferred: boolean;
  ahead: number;
  behind: number;
  current: boolean;
}

export interface RepoStatus {
  path: string;
  exists: boolean;
  isRepo: boolean;
  isBare: boolean;
  isMirror: boolean;
  currentBranch: string | null;
  dirty: boolean;
  inProgress: string | null;
  branches: BranchInfo[];
  remoteUrl: string | null;
}

export type BundleKind = "full" | "incr" | "back" | "patch";

export interface RefEntry {
  name: string;
  sha: string;
  /** 回传包：该分支的基准分支 */
  base?: string;
}

export interface Manifest {
  format: number;
  kind: BundleKind;
  repoName: string;
  repoId: string;
  seq: number;
  createdAt: number;
  payload: string;
  baseBranch: string;
  refs: RefEntry[];
  toolVersion: string;
}

export interface PackageInfo {
  manifest: Manifest | null;
  manifestPath: string | null;
  payloadPath: string;
  payloadExists: boolean;
}

export type ExportOutcome =
  | {
      status: "exported";
      kind: BundleKind;
      seq: number;
      payload: string;
      manifest: string;
      refs: RefEntry[];
      warnings: string[];
    }
  | { status: "nothingToSync"; message: string };

export interface OpOutcome {
  ok: boolean;
  conflict: boolean;
  files: string[];
  message: string;
}

export interface RefChange {
  name: string;
  old: string | null;
  new: string | null;
}

export interface ImportInResult {
  cloned: boolean;
  seq: number | null;
  changes: RefChange[];
}

export interface ImportedBranch {
  source: string;
  local: string;
  sha: string;
  base: string;
  commits: CommitInfo[];
}

export interface ImportBackResult {
  branches: ImportedBranch[];
  warnings: string[];
}

export interface InternalState {
  repoId: string | null;
  outSeq: number;
  lastHeads: string[];
  lastExportAt: number | null;
}

export interface ExternalState {
  repoId: string | null;
  lastInSeq: number;
  backSeq: number;
  lastImportAt: number | null;
}

export type LogKind = "cmd" | "stdout" | "stderr" | "info" | "error";

export interface LogEvent {
  kind: LogKind;
  text: string;
  ts: number;
}

export const LOG_EVENT = "git-log";

// ---------- 命令 ----------

export const api = {
  loadConfig: () => invoke<AppConfig>("load_config"),
  saveConfig: (config: AppConfig) => invoke<void>("save_config", { config }),
  environment: () => invoke<Environment>("environment"),

  repoStatus: (path: string, baseBranch: string, releaseBranches: string[]) =>
    invoke<RepoStatus>("repo_status", { path, baseBranch, releaseBranches }),
  internalState: (mirrorDir: string) =>
    invoke<InternalState>("sync_state", { path: mirrorDir, external: false }),
  externalState: (repoDir: string) =>
    invoke<ExternalState>("sync_state", { path: repoDir, external: true }),
  listPackages: (dir: string) => invoke<PackageInfo[]>("list_packages", { dir }),
  listCommits: (repo: string, from: string, to: string) =>
    invoke<CommitInfo[]>("list_commits", { repo, from, to }),
  abortOp: (repo: string) => invoke<OpOutcome>("abort_op", { repo }),
  continueOp: (repo: string) => invoke<OpOutcome>("continue_op", { repo }),
  rebaseOnto: (repo: string, branch: string, baseBranch: string, fetchUpstream: boolean) =>
    invoke<OpOutcome>("rebase_onto", { repo, branch, baseBranch, fetchUpstream }),

  // 内网端
  initMirror: (url: string, mirrorDir: string) => invoke<void>("init_mirror", { url, mirrorDir }),
  exportOut: (a: {
    mirrorDir: string;
    transferDir: string;
    repoName: string;
    baseBranch: string;
    fetchUpstream: boolean;
    forceFull: boolean;
  }) => invoke<ExportOutcome>("export_out", a),
  importBack: (workDir: string, bundle: string, baseBranch: string, releaseBranches: string[]) =>
    invoke<ImportBackResult>("import_back", { workDir, bundle, baseBranch, releaseBranches }),
  importPatches: (a: {
    workDir: string;
    patchDir: string;
    branch: string;
    baseBranch: string;
    fetchUpstream: boolean;
  }) => invoke<OpOutcome>("import_patches", a),
  pushBranch: (workDir: string, branch: string, forceWithLease: boolean) =>
    invoke<OpOutcome>("push_branch", { workDir, branch, forceWithLease }),

  // 外网端
  importIn: (bundle: string, repoDir: string, allowGap: boolean) =>
    invoke<ImportInResult>("import_in", { bundle, repoDir, allowGap }),
  configureRepo: (repo: string, name: string, email: string) =>
    invoke<void>("configure_repo", { repo, name, email }),
  createBranch: (repo: string, name: string, baseBranch: string) =>
    invoke<void>("create_branch", { repo, name, baseBranch }),
  exportBack: (a: {
    repo: string;
    branches: string[];
    transferDir: string;
    repoName: string;
    baseBranch: string;
    releaseBranches: string[];
  }) => invoke<ExportOutcome>("export_back", a),
  exportPatches: (a: {
    repo: string;
    branch: string;
    transferDir: string;
    repoName: string;
    baseBranch: string;
    releaseBranches: string[];
  }) => invoke<ExportOutcome>("export_patches", a),
};

// ---------- 工具 ----------

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : "—";
}

export function formatTime(secs: number | null | undefined): string {
  if (!secs) return "—";
  const d = new Date(secs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function joinPath(dir: string, name: string, os: string): string {
  const sep = os === "windows" ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export const KIND_LABEL: Record<BundleKind, string> = {
  full: "全量",
  incr: "增量",
  back: "回传",
  patch: "补丁",
};

// ---------- 主线 / 发布分支 ----------

export function releasesOf(p: Profile): string[] {
  return p.releaseBranches ?? [];
}

/** 可作为基准的分支：主线在前，然后是发布分支。 */
export function baseCandidates(p: Profile): string[] {
  return [p.baseBranch, ...releasesOf(p).filter((r) => r !== p.baseBranch)];
}

/** 按分支名前缀给出默认基准：hotfix/ → 第一个发布分支，其他 → 主线。 */
export function defaultBaseFor(name: string, p: Profile): string {
  const releases = releasesOf(p);
  return name.startsWith("hotfix/") && releases.length > 0 ? releases[0] : p.baseBranch;
}

/** 分支前缀与基准不匹配时的提示（只提示，不阻止）。 */
export function prefixWarning(name: string, base: string, p: Profile): string | null {
  const onRelease = releasesOf(p).includes(base);
  if (name.startsWith("hotfix/") && !onRelease) {
    return `hotfix/ 分支通常基于发布分支，当前基准是 ${base}`;
  }
  if ((name.startsWith("feature/") || name.startsWith("bugfix/")) && onRelease) {
    return `${name.split("/")[0]}/ 分支通常基于主线 ${p.baseBranch}，当前基准是发布分支 ${base}`;
  }
  return null;
}

/** 把用户输入的“release/1.2, release/1.3”拆成数组。 */
export function parseBranchList(text: string): string[] {
  return [...new Set(text.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean))];
}

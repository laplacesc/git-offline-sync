import { useSyncExternalStore } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * 应用更新：对照 GitHub Releases 上的 latest.json（由 CI 签名生成）。
 *
 * 流程与 PI-Desktop 一致：
 *  - 启动后稍等片刻自动检查，之后每 6 小时检查一次；自动检查失败保持安静
 *    （内网离线、GitHub 限流都很常见），只有手动检查才显示错误。
 *  - 发现新版本后由用户点击下载，显示进度；下载完成后点击重启完成安装。
 *  - 开发模式不自动检查。
 */
export const RELEASES_URL = "https://github.com/laplacesc/git-offline-sync/releases/latest";

const AUTO_CHECK_INITIAL_DELAY_MS = 15_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 自动检查等待上限：不要让 GitHub 的长时间挂起把状态卡在「检查中」 */
const AUTO_CHECK_TIMEOUT_MS = 8_000;
const MANUAL_CHECK_TIMEOUT_MS = 15_000;

export type UpdateStatus = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "error";

export interface UpdateState {
  status: UpdateStatus;
  /** 最近一次检查是否由用户手动触发，决定是否展示错误 */
  manual: boolean;
  availableVersion?: string;
  releaseNotes?: string;
  /** 下载进度 0-100；服务器没给出总大小时为 undefined */
  progressPercent?: number;
  error?: string;
}

let state: UpdateState = { status: "idle", manual: false };
let pending: Update | null = null;
const listeners = new Set<() => void>();

function setState(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getUpdateState(): UpdateState {
  return state;
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    getUpdateState,
  );
}

/** 有可操作的更新（可下载、下载中或待安装） */
export function hasUpdate(s: UpdateState): boolean {
  return s.status === "available" || s.status === "downloading" || s.status === "downloaded";
}

/**
 * 把更新插件的英文错误转成用户能看懂的中文说明；无法识别时保留原文。
 * 原始错误同时打印到控制台，方便排查。
 */
export function describeUpdateError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  console.warn("[updater]", raw);
  // 插件在更新地址返回非 2xx（如最新 Release 里没有 latest.json 时的 404）或 JSON 无效时报这个错
  if (/Could not fetch a valid release JSON/i.test(raw)) {
    return "最新发布版本中没有应用内更新信息（latest.json），暂时无法自动更新，可以打开发布页手动下载。";
  }
  if (/error sending request|timed out|timeout|dns|connect/i.test(raw)) {
    return "无法连接到 GitHub，请检查网络。内网离线环境无法检查更新。";
  }
  if (/signature/i.test(raw)) {
    return "更新包签名校验失败，已停止更新，请从发布页手动下载安装。";
  }
  return raw;
}

function replacePending(next: Update | null) {
  if (pending && pending !== next) void pending.close().catch(() => undefined);
  pending = next;
}

/** 检查更新，返回检查结束后的状态。手动检查失败时抛出错误。 */
export async function checkForUpdates({ manual = false } = {}): Promise<UpdateState> {
  if (state.status === "checking" || state.status === "downloading" || state.status === "downloaded") return state;
  setState({ status: "checking", manual, error: undefined });
  try {
    const update = await check({ timeout: manual ? MANUAL_CHECK_TIMEOUT_MS : AUTO_CHECK_TIMEOUT_MS });
    replacePending(update);
    if (update) {
      setState({ status: "available", availableVersion: update.version, releaseNotes: update.body?.trim() || undefined, progressPercent: undefined });
    } else {
      setState({ status: "up-to-date", availableVersion: undefined, releaseNotes: undefined, progressPercent: undefined });
    }
  } catch (e) {
    const error = describeUpdateError(e);
    if (manual) {
      setState({ status: "error", error });
      throw new Error(error);
    }
    // 自动检查失败保持安静；之前已经发现的新版本仍然保留
    setState(pending ? { status: "available", error: undefined } : { status: "idle", error: undefined });
  }
  return state;
}

/** 下载已发现的新版本 */
export async function downloadUpdate(): Promise<void> {
  if (!pending || state.status !== "available") return;
  const update = pending;
  let total = 0;
  let received = 0;
  setState({ status: "downloading", progressPercent: 0, error: undefined, manual: true });
  try {
    await update.download((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
        setState({ progressPercent: total ? 0 : undefined });
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        if (total) setState({ progressPercent: Math.min(99, Math.round((received / total) * 100)) });
      }
    });
    setState({ status: "downloaded", progressPercent: 100 });
  } catch (e) {
    // 回到「可下载」，让用户重试
    setState({ status: "available", progressPercent: undefined, error: `下载失败：${describeUpdateError(e)}` });
    throw e;
  }
}

/** 安装已下载的更新并重启。Windows 上安装程序会自行退出应用。 */
export async function installUpdate(): Promise<void> {
  if (!pending || state.status !== "downloaded") return;
  try {
    await pending.install();
    await relaunch();
  } catch (e) {
    setState({ error: `安装失败：${describeUpdateError(e)}` });
    throw e;
  }
}

let timers: ReturnType<typeof setTimeout>[] = [];

/** 启动后台定时检查；返回停止函数。开发模式下不启动。 */
export function startAutoCheck(): () => void {
  if (import.meta.env.DEV || timers.length) return () => {};
  const run = () => void checkForUpdates().catch(() => undefined);
  timers = [setTimeout(run, AUTO_CHECK_INITIAL_DELAY_MS), setInterval(run, AUTO_CHECK_INTERVAL_MS)];
  return () => {
    timers.forEach((t) => clearTimeout(t));
    timers = [];
  };
}

/** 仅供测试：重置模块状态 */
export function __resetUpdater() {
  replacePending(null);
  state = { status: "idle", manual: false };
  listeners.forEach((l) => l());
}

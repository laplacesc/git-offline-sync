import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api, type CommitInfo, type DevSyncStatus, type PackageInfo, type Profile, type PushPlan, type RepoStatus, type ReturnPackageInfo } from "../src/api";
import { ExternalView } from "../src/ExternalView";
import { InternalView } from "../src/InternalView";
import { useRepoStatus } from "../src/repoBits";
import { OperationStatus, RunnerProvider } from "../src/runner";

const focus = vi.hoisted(() => ({ listener: undefined as undefined | ((event: { payload: boolean }) => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: async (listener: typeof focus.listener) => { focus.listener = listener; return () => {}; } }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const profile: Profile = {
  id: "test", name: "test", role: "external", repoName: "test", baseBranch: "main",
  transferDir: "/usb", mirrorDir: "/mirror", workDir: "/work", devRepos: ["/dev-one", "/dev-two"],
};
function status(path: string): RepoStatus {
  return {
    path, exists: true, isRepo: true, isBare: path === "/mirror", isMirror: path === "/mirror",
    currentBranch: "main", worktrees: [], dirtyTrees: [], inProgress: null, inProgressTrees: [], remoteUrl: null,
    refs: [],
    branches: ["feature/one", "feature/two"].map((name) => ({
      name, sha: "abcdef123", base: "main", baseInferred: false, ahead: 1, behind: 0, current: false, worktree: null,
    })),
  };
}
function commit(subject: string): CommitInfo {
  return { sha: subject, subject, author: "author", email: "author@example.com", date: "2026-01-01" };
}
function pkg(payload: string, kind: "full" | "back" = "full"): ReturnPackageInfo {
  return { payloadPath: payload, payloadExists: true, manifestPath: payload + ".json", received: false,
    manifest: { format: 1, kind, repoName: "test", repoId: "matching", seq: 10, createdAt: 1,
      payload, baseBranch: "main", refs: [{ name: "refs/heads/feature/returned", sha: "returned-sha", base: "main" }], toolVersion: "2.0.9" } };
}
function plan(branch: string, commits = [commit("frozen-commit")]): PushPlan {
  return { planId: "plan-" + branch, sourceOid: "source-sha", remoteOid: "remote-sha", baseOid: "base-sha",
    targetRef: "refs/heads/" + branch, remoteUrl: "ssh://git/project", commits, nonFastForward: false };
}
function ipc(command: string, args?: Record<string, unknown>): unknown {
  switch (command) {
    case "repo_status": return status(String(args?.path));
    case "sync_state": return { repoId: "matching", outSeq: 1, lastHeads: [], lastExportAt: null, lastInSeq: 1, backSeq: 0, lastImportAt: null };
    case "list_packages":
    case "list_return_packages": return [];
    case "dev_sync_status": return (args?.devDirs as string[]).map((path) => ({ path, status: "upToDate", error: null }));
    case "sync_updates": return { imported: null, repositories: (args?.devDirs as string[]).map((path) => ({ path, status: "fetched" })) };
    case "prepare_push": return plan(String(args?.branch));
    case "execute_push": return { ok: true, conflict: false, files: [], message: "pushed", worktree: null };
    // Rust unit serializes to JSON null, not JavaScript undefined.
    case "init_mirror":
    case "create_branch":
    case "configure_repo":
    case "save_config": return null;
    default: throw new Error(`Unexpected IPC: ${command}`);
  }
}
function renderView(role: "external" | "internal", value = profile) {
  return render(<RunnerProvider>{role === "external" ? <ExternalView profile={value} /> : <InternalView profile={{ ...value, role: "internal" }} />}<OperationStatus /></RunnerProvider>);
}
function devRow(path: string) {
  const management = screen.getByRole("region", { name: "同步开发仓库", exact: true });
  return within(management).getByText(path, { exact: true }).closest(".sync-branch-row") as HTMLElement;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(invoke).mockImplementation(async (command, args) => ipc(command, args as Record<string, unknown>));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("仓库查询", () => {
  it("同路径同参数的并发查询只发送一次 IPC，完成和失败后不缓存", async () => {
    const pending = deferred<RepoStatus>();
    vi.mocked(invoke).mockReturnValueOnce(pending.promise);
    const first = api.repoStatus("/same", "main", []);
    const second = api.repoStatus("/same", "main", []);
    expect(first).toBe(second);
    expect(invoke).toHaveBeenCalledTimes(1);
    pending.resolve(status("/same"));
    await first;
    await api.repoStatus("/same", "main", []);
    expect(invoke).toHaveBeenCalledTimes(2);
    const failed = deferred<RepoStatus>();
    vi.mocked(invoke).mockReturnValueOnce(failed.promise);
    const retry = api.repoStatus("/same", "main", []);
    expect(api.repoStatus("/same", "main", [])).toBe(retry);
    failed.reject(new Error("unavailable"));
    await expect(retry).rejects.toThrow("unavailable");
    await expect(api.repoStatus("/same", "main", [])).resolves.toEqual(status("/same"));
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it.each([false, true])("mutation 结束后不复用之前或执行期间的读取（失败=%s）", async (fail) => {
    const before = deferred<RepoStatus>();
    const during = deferred<RepoStatus>();
    const after = deferred<RepoStatus>();
    const mutation = deferred<Awaited<ReturnType<typeof api.syncUpdates>>>();
    const reads = [before.promise, during.promise, after.promise];
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "repo_status") return reads.shift()!;
      if (command === "sync_updates") return mutation.promise;
      throw new Error(command);
    });
    const first = api.repoStatus("/same", "main", []);
    const sync = api.syncUpdates({ bundle: null, mirrorDir: "/mirror", devDirs: ["/same"], name: "", email: "" });
    const second = api.repoStatus("/same", "main", []);
    expect(second).not.toBe(first);
    if (fail) {
      mutation.reject(new Error("sync failed"));
      await expect(sync).rejects.toThrow("sync failed");
    } else {
      const result = { imported: null, repositories: [] };
      mutation.resolve(result);
      await expect(sync).resolves.toEqual(result);
    }
    const fresh = api.repoStatus("/same", "main", []);
    expect(fresh).not.toBe(second);
    before.resolve(status("/same"));
    during.resolve(status("/same"));
    await Promise.all([first, second]);
    expect(api.repoStatus("/same", "main", [])).toBe(fresh);
    after.resolve(status("/same"));
    await fresh;
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "repo_status")).toHaveLength(3);
  });

  it("旧状态请求不能覆盖新结果或提前结束 loading，路径切换清除旧错误", async () => {
    const old = deferred<RepoStatus>();
    const latest = deferred<RepoStatus>();
    vi.spyOn(api, "repoStatus").mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const { result, rerender } = renderHook(({ path }) => useRepoStatus(path, "main", []), { initialProps: { path: "/one" } });
    act(() => { void result.current.reload(); });
    await act(async () => old.resolve(status("/one")));
    expect(result.current.loading).toBe(true);
    expect(result.current.status).toBeNull();
    await act(async () => latest.reject(new Error("latest failure")));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toContain("latest failure");
    const switched = deferred<RepoStatus>();
    vi.mocked(api.repoStatus).mockReturnValueOnce(switched.promise);
    rerender({ path: "/two" });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => switched.resolve(status("/two")));
    expect(result.current.status?.path).toBe("/two");
  });

  it("较慢的同步状态查询不能覆盖最新开发库列表", async () => {
    const old = deferred<DevSyncStatus[]>();
    vi.spyOn(api, "devSyncStatus").mockReturnValueOnce(old.promise).mockResolvedValue([
      { path: "/dev-one", status: "upToDate", error: null },
      { path: "/dev-two", status: "notCloned", error: null },
    ]);
    renderView("external");

    vi.useFakeTimers();
    act(() => focus.listener?.({ payload: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(301); });
    vi.useRealTimers();
    await waitFor(() => expect(within(devRow("/dev-two")).getByRole("button", { name: "从镜像克隆" })).toBeTruthy());
    await act(async () => old.resolve([{ path: "/dev-two", status: "upToDate", error: null }]));
    expect(within(devRow("/dev-two")).getByText("尚未克隆")).toBeTruthy();
    expect(within(devRow("/dev-two")).getByRole("button", { name: "从镜像克隆" })).toBeTruthy();
  });

  it("首轮只对镜像和当前开发库查完整状态，批量查询所有开发库同步状态", async () => {
    renderView("external");
    await screen.findByText("没有新的更新。");
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "repo_status").map(([, args]) => (args as { path: string }).path).sort()).toEqual(["/dev-one", "/mirror"]);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "dev_sync_status")).toEqual([["dev_sync_status", { mirrorDir: "/mirror", devDirs: ["/dev-one", "/dev-two"] }]]);
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "probe_repo")).toBe(false);
  });
});

describe.each(["external", "internal"] as const)("%s 独立刷新", (role) => {
  it.each([false, true])("刷新分支不扫描目录或阻塞包浏览（同时获得焦点=%s）", async (withFocus) => {
    const packages = Array.from({ length: 25 }, (_, index) => {
      const value = pkg(`package-${index + 1}.bundle`, role === "internal" ? "back" : "full");
      value.manifest!.seq = index + 1;
      return value;
    });
    const scan = vi.spyOn(api, role === "external" ? "listPackages" : "listReturnPackages").mockResolvedValue(packages);
    renderView(role);
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "刷新同步状态" }).disabled).toBe(false));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "刷新传输目录" }).disabled).toBe(false));
    const label = role === "internal" ? "回传包" : "更新包";
    fireEvent.click(screen.getByRole("button", { name: `展开其余 20 个${label}` }));
    const pending = deferred<RepoStatus>();
    const repoPath = role === "internal" ? "/work" : "/dev-one";
    const stateValue = { repoId: "matching", outSeq: 1, lastHeads: [], lastExportAt: null, lastInSeq: 1, backSeq: 0, lastImportAt: null };
    const pendingState = deferred<typeof stateValue>();
    vi.spyOn(api, role === "internal" ? "internalState" : "mirrorState").mockReturnValue(pendingState.promise);
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "repo_status" && (args as { path: string }).path === repoPath) return pending.promise;
      return ipc(command, args as Record<string, unknown>);
    });
    if (withFocus) {
      vi.useFakeTimers();
      act(() => focus.listener?.({ payload: true }));
    }
    fireEvent.click(screen.getByRole("button", { name: "刷新分支" }));
    expect(invoke).toHaveBeenCalledExactlyOnceWith("repo_status", { path: repoPath, baseBranch: "main", releaseBranches: [] });
    if (withFocus) await act(async () => { await vi.advanceTimersByTimeAsync(301); });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "刷新传输目录" }).disabled).toBe(false);
    expect(screen.queryByText("正在读取传输目录…")).toBeNull();
    expect(screen.queryByText("正在检查同步状态…")).toBeNull();
    expect(screen.getByRole("region", { name: "分支操作", exact: true }).getAttribute("aria-busy")).toBe("true");
    const search = screen.getByRole<HTMLInputElement>("textbox", { name: `搜索${label}` });
    expect(search.disabled).toBe(false);
    const next = screen.getByRole<HTMLButtonElement>("button", { name: "下一页" });
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(screen.getByText("21–25 / 25")).toBeTruthy();
    fireEvent.change(search, { target: { value: "package-1.bundle" } });
    expect(screen.getByRole("listitem", { name: "package-1.bundle" })).toBeTruthy();
    if (role === "internal") {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "导入回传", exact: true }).disabled).toBe(true);
    } else {
      expect(screen.getByText("本次更新 #2 · 全量")).toBeTruthy();
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "导入下一包" }).disabled).toBe(withFocus);
    }
    await act(async () => {
      pending.resolve(status(repoPath));
      pendingState.resolve(stateValue);
    });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(search.value).toBe("package-1.bundle");
  });

  it("较晚完成的旧刷新不覆盖最新包列表和状态", async () => {
    const old = deferred<ReturnPackageInfo[]>();
    const latest = deferred<ReturnPackageInfo[]>();
    vi.spyOn(api, role === "external" ? "listPackages" : "listReturnPackages").mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const stateValue = { repoId: "matching", outSeq: 9, lastHeads: [], lastExportAt: null, lastInSeq: 9, backSeq: 0, lastImportAt: null };
    const oldState = deferred<typeof stateValue>();
    const stateApi = role === "external" ? "mirrorState" : "internalState";
    vi.spyOn(api, stateApi).mockReturnValueOnce(oldState.promise).mockResolvedValueOnce(stateValue);
    const { rerender } = renderView(role);
    if (role === "internal") fireEvent.click(screen.getByRole("tab", { name: "同步与回传" }));

    rerender(<RunnerProvider>{role === "external"
      ? <ExternalView profile={profile} refreshVersion={1} />
      : <InternalView profile={{ ...profile, role }} refreshVersion={1} />}<OperationStatus /></RunnerProvider>);
    await act(async () => latest.resolve([pkg("new.bundle", role === "internal" ? "back" : "full")]));
    const latestText = role === "external" ? "本次更新 #10 · 全量" : /new\.bundle/;
    expect(await screen.findAllByText(latestText)).not.toHaveLength(0);
    const stale = pkg("old.bundle", role === "internal" ? "back" : "full");
    stale.manifest!.seq = 11;
    await act(async () => { old.resolve([stale]); oldState.resolve({ ...stateValue, lastInSeq: 1, outSeq: 1 }); });
    expect(screen.getAllByText(latestText)).not.toHaveLength(0);
    expect(screen.queryByText("本次更新 #11 · 全量")).toBeNull();
    expect(screen.queryByText(/old\.bundle/)).toBeNull();
    if (role === "external") expect(screen.getByText("本次更新 #10 · 全量")).toBeTruthy();
    else {
      fireEvent.click(screen.getByRole("tab", { name: "同步与回传" }));
      expect(screen.getByText(/最近已导出 #9 ·/)).toBeTruthy();
    }
  });

  it("旧传输目录的迟到错误不会污染新配置，即使 profile id 未变", async () => {
    const old = deferred<ReturnPackageInfo[]>();
    vi.spyOn(api, "mirrorState").mockResolvedValue({ repoId: "matching", lastInSeq: 9, backSeq: 0, lastImportAt: null });
    vi.spyOn(api, role === "external" ? "listPackages" : "listReturnPackages").mockReturnValueOnce(old.promise).mockResolvedValue([pkg("new-dir.bundle", role === "internal" ? "back" : "full")]);
    const { rerender } = renderView(role);
    if (role === "internal") fireEvent.click(screen.getByRole("tab", { name: "同步与回传" }));

    const updated = { ...profile, transferDir: "/new-usb" };
    rerender(<RunnerProvider>{role === "external" ? <ExternalView profile={updated} /> : <InternalView profile={{ ...updated, role: "internal" }} />}</RunnerProvider>);
    const latestText = role === "external" ? "本次更新 #10 · 全量" : /new-dir\.bundle/;
    expect(await screen.findAllByText(latestText)).not.toHaveLength(0);
    await act(async () => old.reject(new Error("old USB removed")));
    expect(screen.queryByText("old USB removed")).toBeNull();
    expect(screen.getAllByText(latestText)).not.toHaveLength(0);
  });

  it("首次扫描远程传输目录未完成时，本地分支可选择、新建和刷新", async () => {
    const pending = deferred<ReturnPackageInfo[]>();
    const packages = vi.spyOn(api, role === "external" ? "listPackages" : "listReturnPackages").mockReturnValue(pending.promise);
    const create = vi.spyOn(api, "createBranch").mockResolvedValue(undefined);
    renderView(role);
    const row = await screen.findByRole("row", { name: "feature/one" });
    fireEvent.click(row);
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "刷新传输目录" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Rebase feature/one" }).disabled).toBe(false);
    if (role === "internal") {
      await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "检查并推送 feature/one" }).disabled).toBe(false));
    } else {
      await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "同步开发仓库" }).disabled).toBe(false));
    }
    fireEvent.change(screen.getByRole("textbox", { name: "新分支" }), { target: { value: "feature/new" } });
    fireEvent.click(screen.getByRole("button", { name: "新建并切换" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const refresh = screen.getByRole<HTMLButtonElement>("button", { name: "刷新分支" });
    await waitFor(() => expect(refresh.disabled).toBe(false));
    const reads = vi.mocked(invoke).mock.calls.filter(([command]) => command === "repo_status").length;
    fireEvent.click(refresh);
    await waitFor(() => expect(refresh.disabled).toBe(false));
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "repo_status").length).toBeGreaterThan(reads);
    expect(packages).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve([]));
  });

  it("手动扫描传输目录不刷新仓库、不锁定本地操作，目录失败也不影响分支", async () => {
    const packages = vi.spyOn(api, role === "external" ? "listPackages" : "listReturnPackages").mockResolvedValue([]);
    renderView(role);
    const refresh = await screen.findByRole<HTMLButtonElement>("button", { name: "刷新传输目录" });
    await waitFor(() => expect(refresh.disabled).toBe(false));
    fireEvent.click(screen.getByRole("row", { name: "feature/one" }));
    const pending = deferred<ReturnPackageInfo[]>();
    packages.mockReturnValueOnce(pending.promise);
    vi.mocked(invoke).mockClear();
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(packages).toHaveBeenCalledTimes(2);
    expect(refresh.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "刷新分支" }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Rebase feature/one" }).disabled).toBe(false);
    expect(screen.getByRole("row", { name: "feature/one" }).getAttribute("aria-selected")).toBe("true");
    expect(vi.mocked(invoke).mock.calls.some(([command]) => ["repo_status", "sync_state", "dev_sync_status"].includes(command))).toBe(false);
    await act(async () => pending.reject(new Error("remote directory unavailable")));
    expect(await screen.findByText(/remote directory unavailable/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Rebase feature/one" }).disabled).toBe(false);
    fireEvent.click(refresh);
    await waitFor(() => expect(screen.queryByText(/remote directory unavailable/)).toBeNull());
  });

  it("导入完成后立即刷新本地状态，不等待传输目录重新扫描", async () => {
    const pending = deferred<ReturnPackageInfo[]>();
    const packageValue = pkg("import.bundle", role === "internal" ? "back" : "full");
    vi.spyOn(api, role === "external" ? "listPackages" : "listReturnPackages")
      .mockResolvedValueOnce([packageValue]).mockReturnValue(pending.promise);
    let imported = false;
    vi.spyOn(api, "mirrorState").mockImplementation(async () => ({
      repoId: "matching", lastInSeq: imported ? 10 : 9, backSeq: 0, lastImportAt: null,
    }));
    vi.spyOn(api, "importReturn").mockImplementation(async () => {
      imported = true;
      return {
        branches: [{ source: "feature/returned", local: "feature/returned", sha: "returned-sha", base: "main", commits: [] }],
        warnings: [], outcomes: [],
      };
    });
    vi.spyOn(api, "syncUpdates").mockImplementation(async () => {
      imported = true;
      return { imported: { created: false, seq: 10, changes: [] }, repositories: [] };
    });
    vi.spyOn(api, "repoStatus").mockImplementation(async (path) => {
      const value = status(path);
      if (imported && path === "/work") value.branches[0].name = "feature/returned";
      return value;
    });
    renderView(role);
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: role === "internal" ? "导入回传" : "导入下一包" });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(imported).toBe(true));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "刷新分支" }).disabled).toBe(false));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "刷新传输目录" }).disabled).toBe(true);
    if (role === "internal") {
      expect(await screen.findByText("已导入本地分支")).toBeTruthy();
      await waitFor(() => expect(screen.getByRole("row", { name: "feature/returned" }).getAttribute("aria-selected")).toBe("true"));
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "检查并推送 feature/returned" }).disabled).toBe(false);
    } else {
      await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "同步开发仓库" }).disabled).toBe(false));
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Rebase feature/one" }).disabled).toBe(false);
    }
    await act(async () => pending.resolve([]));
    if (role === "external") expect(screen.getByText("没有新的更新。")).toBeTruthy();
  });
});

it("内网焦点刷新必须等待同步记录，期间不能使用上一轮记录导出或推送", async () => {
  renderView("internal");
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "导出更新" }).disabled).toBe(false));
  const pending = deferred<Awaited<ReturnType<typeof api.internalState>>>();
  vi.spyOn(api, "internalState").mockReturnValueOnce(pending.promise);
  vi.useFakeTimers();
  act(() => focus.listener?.({ payload: true }));
  await act(async () => { await vi.advanceTimersByTimeAsync(301); });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "导出更新" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "检查并推送 feature/one" }).disabled).toBe(true);
  await act(async () => pending.resolve({ repoId: "matching", outSeq: 2, lastHeads: [], lastExportAt: null }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "导出更新" }).disabled).toBe(false);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "检查并推送 feature/one" }).disabled).toBe(false);
});

it.each(["external", "internal"] as const)("%s 重新检测 Git 后重新读取状态并保留表单", async (role) => {
  const value = { ...profile, role };
  const workspace = (version: number) => <RunnerProvider>{role === "external"
    ? <ExternalView profile={value} refreshVersion={version} />
    : <InternalView profile={value} refreshVersion={version} />}</RunnerProvider>;
  const { rerender } = render(workspace(0));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "刷新同步状态" }).disabled).toBe(false));
  fireEvent.change(screen.getByRole("textbox", { name: "新分支" }), { target: { value: "feature/draft" } });
  vi.mocked(invoke).mockClear();
  rerender(workspace(1));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "新建并切换" }).disabled).toBe(false));
  const calls = vi.mocked(invoke).mock.calls.map(([command]) => command);
  expect(calls.filter((command) => command === "repo_status")).toHaveLength(2);
  expect(calls.filter((command) => command === "sync_state")).toHaveLength(1);
  expect(calls.filter((command) => command === (role === "external" ? "list_packages" : "list_return_packages"))).toHaveLength(1);
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "新分支" }).value).toBe("feature/draft");
});

it.each([
  ["内网记录", () => api.internalState("/mirror")],
  ["外网记录", () => api.mirrorState("/mirror")],
  ["更新包列表", () => api.listPackages("/usb")],
  ["回传包列表", () => api.listReturnPackages("/work", "/usb")],
] as const)("%s 共享未完成读取，完成后再次读取", async (_, read) => {
  const pending = deferred<unknown>();
  vi.mocked(invoke).mockReturnValueOnce(pending.promise);
  const first = read();
  expect(read()).toBe(first);
  expect(invoke).toHaveBeenCalledTimes(1);
  pending.resolve(null);
  await first;
  await read();
  expect(invoke).toHaveBeenCalledTimes(2);
});

describe("提交列表与推送", () => {
  function selectBranch(name: string) {
    fireEvent.click(screen.getByRole("row", { name }));
  }
  function pushButton(name: string) {
    return within(screen.getByRole("row", { name })).getByRole("button", { name: `检查并推送 ${name}` });
  }
  it("行内推送只检查指定分支，确认内容来自后端冻结计划", async () => {
    const prepared = deferred<PushPlan>();
    vi.spyOn(api, "preparePush").mockReturnValue(prepared.promise);
    renderView("internal");
    await screen.findByRole("row", { name: "feature/one" });
    selectBranch("feature/one");
    fireEvent.click(within(screen.getByRole("row", { name: "feature/two" })).getByRole("button", { name: "检查并推送 feature/two" }));
    expect(api.preparePush).toHaveBeenCalledWith("/work", "feature/two", false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "list_commits")).toBe(false);
    await act(async () => prepared.resolve(plan("feature/two", [commit("frozen-second-commit")])));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("frozen-second-commit")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认推送" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("execute_push", { planId: "plan-feature/two" }));
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "push_branch")).toBe(false);
  });

  it("多选不影响行内推送目标，取消确认保留选择且不推送", async () => {
    const execute = vi.spyOn(api, "executePush");
    vi.spyOn(api, "preparePush");
    renderView("internal");
    await screen.findByRole("row", { name: "feature/one" });
    selectBranch("feature/one"); selectBranch("feature/two");
    fireEvent.click(within(screen.getByRole("row", { name: "feature/two" })).getByRole("button", { name: "检查并推送 feature/two" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("frozen-commit")).toBeTruthy();
    expect(api.preparePush).toHaveBeenCalledWith("/work", "feature/two", false);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("row", { name: "feature/one" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("row", { name: "feature/two" }).getAttribute("aria-selected")).toBe("true");
    expect(execute).not.toHaveBeenCalled();
  });

  it("确认框打开后配置变化，确认旧内容不能推送", async () => {
    const execute = vi.spyOn(api, "executePush");
    const { rerender } = renderView("internal");
    await screen.findByRole("row", { name: "feature/one" });
    fireEvent.click(pushButton("feature/one"));
    const dialog = await screen.findByRole("alertdialog");
    rerender(<RunnerProvider><InternalView profile={{ ...profile, role: "internal", workDir: "/other-work" }} /></RunnerProvider>);
    fireEvent.click(within(dialog).getByRole("button", { name: "确认推送" }));
    await act(async () => {});
    expect(execute).not.toHaveBeenCalled();
  });

  it("准备计划失败显示错误，不能误报空提交或执行推送", async () => {
    vi.spyOn(api, "preparePush").mockRejectedValue(new Error("cannot prepare frozen plan"));
    const execute = vi.spyOn(api, "executePush");
    render(<RunnerProvider><InternalView profile={{ ...profile, role: "internal" }} /><OperationStatus /></RunnerProvider>);
    await screen.findByRole("row", { name: "feature/one" });
    fireEvent.click(pushButton("feature/one"));
    expect(await screen.findByText(/cannot prepare frozen plan/)).toBeTruthy();
    expect(screen.queryByText("没有相对基准的新提交")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });});

describe("开发库同步状态", () => {
  async function pendingRepos(paths = profile.devRepos!) {
    let devs: DevSyncStatus[] = paths.map((path) => ({ path, status: "needsFetch", error: null }));
    vi.spyOn(api, "devSyncStatus").mockImplementation(async () => devs);
    render(<RunnerProvider><ExternalView profile={{ ...profile, devRepos: paths }} /><OperationStatus /></RunnerProvider>);

    await waitFor(() => expect(screen.getAllByText(/待同步/)).toHaveLength(paths.length));
    return (done: string[]) => { devs = devs.map((d) => done.includes(d.path) ? { ...d, status: "upToDate" } : d); };
  }

  it("单库成功仅清除该库；失败保留标记，重试成功再清除", async () => {
    const markDone = await pendingRepos();
    const sync = vi.spyOn(api, "syncUpdates").mockImplementation(async ({ devDirs }) => {
      markDone(devDirs);
      return { imported: null, repositories: devDirs.map((path) => ({ path, status: "fetched" })) };
    });
    fireEvent.click(within(devRow("/dev-one")).getByRole("button", { name: "同步仓库" }));
    await waitFor(() => expect(screen.getAllByText(/待同步/)).toHaveLength(1));
    expect(sync).toHaveBeenLastCalledWith({ bundle: null, mirrorDir: "/mirror", devDirs: ["/dev-one"], name: "", email: "" });
    expect(within(devRow("/dev-two")).getByText("待同步")).toBeTruthy();
    sync.mockRejectedValueOnce(new Error("fetch failed"));
    fireEvent.click(within(devRow("/dev-two")).getByRole("button", { name: "同步仓库" }));
    expect(await screen.findByText(/fetch failed/)).toBeTruthy();
    await waitFor(() => expect((within(devRow("/dev-two")).getByRole("button", { name: "同步仓库" }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(devRow("/dev-two")).getByText("待同步")).toBeTruthy();
    fireEvent.click(within(devRow("/dev-two")).getByRole("button", { name: "同步仓库" }));
    await waitFor(() => expect(screen.queryByText(/待同步/)).toBeNull());
    expect(screen.getByText("没有新的更新。")).toBeTruthy();
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it("批量同步由单个 IPC 执行，刷新后清除全部标记", async () => {
    const markDone = await pendingRepos();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "sync_updates") markDone((args as { devDirs: string[] }).devDirs);
      return ipc(command, args as Record<string, unknown>);
    });
    fireEvent.click(screen.getByRole("button", { name: "同步开发仓库" }));
    await waitFor(() => expect(screen.queryByText(/待同步/)).toBeNull());
    expect(screen.getByText("没有新的更新。")).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "sync_updates")).toEqual([
      ["sync_updates", { bundle: null, mirrorDir: "/mirror", devDirs: ["/dev-one", "/dev-two"], name: "", email: "" }],
    ]);
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "sync_dev_repo")).toBe(false);
  });

  it("批量同步部分失败后重新查询，保留失败和未尝试仓库并刷新已成功仓库", async () => {
    const paths = ["/dev-one", "/dev-two", "/dev-three"];
    const markDone = await pendingRepos(paths);
    const before = vi.mocked(invoke).mock.calls.filter(([command]) => command === "repo_status").length;
    const sync = vi.spyOn(api, "syncUpdates").mockImplementation(async () => {
      markDone(["/dev-one"]);
      throw new Error("second fetch failed");
    });
    fireEvent.click(screen.getByRole("button", { name: "同步开发仓库" }));
    await waitFor(() => expect(screen.getAllByText(/待同步/)).toHaveLength(2));
    expect(await screen.findByText(/second fetch failed/)).toBeTruthy();
    expect(within(devRow("/dev-one")).getByText(/已同步/)).toBeTruthy();
    expect(within(devRow("/dev-two")).getByText("待同步")).toBeTruthy();
    expect(within(devRow("/dev-three")).getByText("待同步")).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "repo_status").length).toBeGreaterThan(before);
    expect(sync).toHaveBeenCalledExactlyOnceWith({ bundle: null, mirrorDir: "/mirror", devDirs: paths, name: "", email: "" });
  });
});

it("导入前阻止缺号、身份不符和缺失文件，只有可用的本项目全量包允许确认跳号", async () => {
  const makePackage = (seq: number, repoId = "matching", payloadExists = true, kind: "incr" | "full" = "incr"): PackageInfo => ({
    payloadPath: "/usb/" + seq + ".bundle", payloadExists, manifestPath: "/usb/" + seq + ".json",
    manifest: { format: 1, kind, repoName: "test", repoId, seq, createdAt: 1, payload: seq + ".bundle", baseBranch: "main", refs: [], toolVersion: "2.0.9" },
  });
  vi.spyOn(api, "mirrorState").mockResolvedValue({ repoId: "matching", lastInSeq: 2, backSeq: 0, lastImportAt: null });
  vi.spyOn(api, "repoStatus").mockImplementation(async (path) => ({ ...status(path), refs: [] }));
  vi.spyOn(api, "listPackages").mockResolvedValue([makePackage(3), makePackage(5), makePackage(4, "other", true, "full"), makePackage(6, "matching", false), makePackage(7, "matching", true, "full")]);
  renderView("external");

  await screen.findByText("本次更新 #3 · 增量");
  expect(screen.queryByRole("button", { name: /选择更新包/ })).toBeNull();
  vi.mocked(api.mirrorState).mockResolvedValue({ repoId: "matching", lastInSeq: 3, backSeq: 0, lastImportAt: null });
  fireEvent.click(screen.getByRole("button", { name: "刷新同步状态" }));
  await screen.findByText("本次更新 #7 · 全量");
  fireEvent.click(screen.getByRole("button", { name: "导入下一包" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/跳过 #4–#6/)).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "sync_updates")).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "导入到 #7" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("sync_updates", {
    bundle: "/usb/7.bundle", mirrorDir: "/mirror", devDirs: [], name: "", email: "",
    confirmation: {
      manifest: makePackage(7, "matching", true, "full").manifest,
      lastInSeq: 3, mirrorRefs: {}, allowFullGap: true,
    },
  }));
});

it.each(["system", "light", "dark"])("旧 %s 主题偏好被忽略，保存配置时移除该字段", async (theme) => {
  vi.mocked(invoke).mockResolvedValueOnce({ theme, gitPath: "/custom/git", profiles: [profile], lastProfileId: profile.id });
  const config = await api.loadConfig();
  expect(config).toEqual({ gitPath: "/custom/git", profiles: [profile], lastProfileId: profile.id });
  expect(config).not.toHaveProperty("theme");
  await api.saveConfig(config);
  expect(invoke).toHaveBeenLastCalledWith("save_config", { config });
});

describe("分支行操作", () => {
  it.each(["external", "internal"] as const)("%s 只在关联分支行标记未提交修改，忽略无关联和表外工作树", async (role) => {
    const worktrees = [
      { path: "/worktrees/one", branch: "feature/one", bare: false, main: false },
      { path: "/worktrees/outside", branch: "feature/outside", bare: false, main: false },
      { path: "/worktrees/detached", branch: null, bare: false, main: false },
    ];
    vi.spyOn(api, "repoStatus").mockImplementation(async (path) => ({
      ...status(path), worktrees, dirtyTrees: worktrees,
    }));
    renderView(role);
    const modified = await screen.findByRole("row", { name: "feature/one" });
    expect(within(modified).getByText("未提交修改")).toBeTruthy();
    expect(within(screen.getByRole("row", { name: "feature/two" })).queryByText("未提交修改")).toBeNull();
    expect(screen.getAllByText("未提交修改")).toHaveLength(1);
    expect(screen.queryByText(/有未提交的修改/)).toBeNull();
    expect(screen.queryByText("/worktrees/outside")).toBeNull();
    expect(screen.queryByText("/worktrees/detached")).toBeNull();
  });

  it.each(["external", "internal"] as const)("%s 删除本地分支支持取消，确认后刷新并清理选择", async (role) => {
    const repoPath = role === "external" ? "/dev-one" : "/work";
    let deleted = false;
    const remove = vi.spyOn(api, "deleteLocalBranch").mockImplementation(async () => {
      deleted = true;
      return { status: "deleted", message: "已删除本地分支 feature/one" };
    });
    vi.spyOn(api, "repoStatus").mockImplementation(async (path) => {
      const result = status(path);
      if (deleted && path === repoPath) result.branches = result.branches.filter((b) => b.name !== "feature/one");
      return result;
    });
    renderView(role);
    const row = await screen.findByRole("row", { name: "feature/one" });
    fireEvent.click(row);
    fireEvent.click(within(row).getByRole("button", { name: "删除本地分支 feature/one" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(repoPath)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(remove).not.toHaveBeenCalled();
    expect(row.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(within(row).getByRole("button", { name: "删除本地分支 feature/one" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除本地分支" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(repoPath, "feature/one"));
    await waitFor(() => expect(screen.queryByRole("row", { name: "feature/one" })).toBeNull());
    expect(within(screen.getByRole("region", { name: "分支操作", exact: true })).getByText(/已选 0 个/)).toBeTruthy();
    expect(screen.getByRole("row", { name: "feature/two" }).getAttribute("aria-selected")).not.toBe("true");
  });

  it("内网行内整理使用按钮所属分支，不误用其他选中的分支", async () => {
    const rebase = vi.spyOn(api, "rebaseOnto").mockResolvedValue({ ok: true, conflict: false, files: [], message: "已完成", worktree: null });
    renderView("internal");
    fireEvent.click(await screen.findByRole("row", { name: "feature/one" }));
    fireEvent.click(screen.getByRole("row", { name: "feature/two" }));
    fireEvent.click(screen.getByRole("button", { name: "Rebase feature/two" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Rebase 分支" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rebase 到 origin/main" }));
    await waitFor(() => expect(rebase).toHaveBeenCalledWith("/work", "feature/two", "main", true));
    expect(rebase).toHaveBeenCalledTimes(1);
  });
});

it("删除失败保留分支和原选择，行内按钮不会切换选择", async () => {
  vi.spyOn(api, "deleteLocalBranch").mockRejectedValue(new Error("分支尚未合并"));
  render(<RunnerProvider><ExternalView profile={profile} /><OperationStatus /></RunnerProvider>);
  fireEvent.click(await screen.findByRole("row", { name: "feature/one" }));
  fireEvent.click(screen.getByRole("button", { name: "删除本地分支 feature/two" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "删除本地分支" }));
  expect((await screen.findByRole("alert")).textContent).toContain("分支尚未合并");
  expect(screen.getByRole("row", { name: "feature/one" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("row", { name: "feature/two" }).getAttribute("aria-selected")).not.toBe("true");
});

it.each(["external", "internal"] as const)("%s 禁止删除当前分支和 worktree 占用分支", async (role) => {
  vi.spyOn(api, "repoStatus").mockImplementation(async (path) => ({
    ...status(path),
    branches: status(path).branches.map((b, i) => ({ ...b, current: i === 0, worktree: i === 1 ? "/linked" : null })),
  }));
  const remove = vi.spyOn(api, "deleteLocalBranch");
  renderView(role);
  for (const name of ["feature/one", "feature/two"]) {
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: `删除本地分支 ${name}` });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(remove).not.toHaveBeenCalled();
});

it.each(["external", "internal"] as const)("%s 未合并分支只有二次确认后才强制删除，取消则保留分支", async (role) => {
  const repoPath = role === "external" ? "/dev-one" : "/work";
  let deleted = false;
  const sha = "abcdef123456";
  const remove = vi.spyOn(api, "deleteLocalBranch").mockImplementation(async (_repo, _branch, forceAt) => {
    if (!forceAt) return { status: "needsForce", sha };
    deleted = true;
    return { status: "deleted", message: "已删除本地分支 feature/one" };
  });
  vi.spyOn(api, "repoStatus").mockImplementation(async (path) => {
    const result = status(path);
    if (deleted && path === repoPath) result.branches = result.branches.filter((b) => b.name !== "feature/one");
    return result;
  });
  renderView(role);
  const row = await screen.findByRole("row", { name: "feature/one" });
  fireEvent.click(row);
  for (const approveForce of [false, true]) {
    fireEvent.click(within(row).getByRole("button", { name: "删除本地分支 feature/one" }));
    let dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除本地分支" }));
    dialog = await screen.findByRole("alertdialog", { name: "强制删除未合并分支 feature/one？" });
    expect(within(dialog).getByText(/删除后可能丢失/)).toBeTruthy();
    expect(within(dialog).getByText(repoPath)).toBeTruthy();
    expect(deleted).toBe(false);
    expect(row.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: approveForce ? "仍然强制删除" : "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    if (!approveForce) {
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenLastCalledWith(repoPath, "feature/one");
      expect(deleted).toBe(false);
    }
  }
  expect(remove).toHaveBeenCalledTimes(3);
  expect(remove).toHaveBeenLastCalledWith(repoPath, "feature/one", sha);
  await waitFor(() => expect(screen.queryByRole("row", { name: "feature/one" })).toBeNull());
  expect(within(screen.getByRole("region", { name: "分支操作", exact: true })).getByText(/已选 0 个/)).toBeTruthy();
});

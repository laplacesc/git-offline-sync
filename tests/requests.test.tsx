import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api, type CommitInfo, type DevSyncStatus, type PackageInfo, type Profile, type PushPlan, type RepoStatus, type ReturnPackageInfo } from "../src/api";
import { ExternalView } from "../src/ExternalView";
import { InternalView } from "../src/InternalView";
import { useRepoStatus } from "../src/repoBits";
import { OperationStatus, RunnerProvider } from "../src/runner";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }),
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
function openBranches(role: "external" | "internal") {
  fireEvent.click(screen.getByRole("tab", { name: role === "external" ? "回传提交" : /导入回传/ }));
  fireEvent.click(screen.getByRole("button", { name: role === "external" ? "分支管理" : "其他回传与分支管理", exact: true }));
}
function ipc(command: string, args?: Record<string, unknown>): unknown {
  switch (command) {
    case "repo_status": return status(String(args?.path));
    case "probe_repo": return true;
    case "sync_state": return { repoId: "matching", outSeq: 1, lastHeads: [], lastExportAt: null, lastInSeq: 1, backSeq: 0, lastImportAt: null };
    case "list_packages":
    case "list_return_packages": return [];
    case "dev_sync_status": return (args?.devDirs as string[]).map((path) => ({ path, status: "upToDate", error: null }));
    case "sync_updates": return { imported: null, repositories: (args?.devDirs as string[]).map((path) => ({ path, status: "fetched" })) };
    case "prepare_push": return plan(String(args?.branch));
    case "execute_push": return { ok: true, conflict: false, files: [], message: "pushed", worktree: null };
    case "list_commits": return [];
    // Rust unit serializes to JSON null, not JavaScript undefined.
    case "init_mirror":
    case "create_branch":
    case "configure_repo":
    case "save_config": return null;
    default: throw new Error(`Unexpected IPC: ${command}`);
  }
}
function renderView(role: "external" | "internal", value = profile) {
  return render(<RunnerProvider>{role === "external" ? <ExternalView profile={value} /> : <InternalView profile={value} />}</RunnerProvider>);
}
function devRow(path: string) {
  const management = screen.getByRole("button", { name: "开发仓库管理", exact: true }).closest(".disclosure")!;
  return within(management).getByText(path, { exact: true }).closest(".sync-branch-row") as HTMLElement;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(invoke).mockImplementation(async (command, args) => ipc(command, args as Record<string, unknown>));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); vi.unstubAllGlobals(); });

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
    const failed = deferred<boolean>();
    vi.mocked(invoke).mockReturnValueOnce(failed.promise);
    const probe = api.probeRepo("/same");
    expect(api.probeRepo("/same")).toBe(probe);
    failed.reject(new Error("unavailable"));
    await expect(probe).rejects.toThrow("unavailable");
    await expect(api.probeRepo("/same")).resolves.toBe(true);
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
    fireEvent.click(screen.getByRole("button", { name: "开发仓库管理", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
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

describe.each(["external", "internal"] as const)("%s 组合刷新", (role) => {
  it("较晚完成的旧刷新不覆盖最新包列表和状态", async () => {
    const old = deferred<ReturnPackageInfo[]>();
    const latest = deferred<ReturnPackageInfo[]>();
    vi.spyOn(api, role === "external" ? "listPackages" : "listReturnPackages").mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const stateValue = { repoId: "matching", outSeq: 9, lastHeads: [], lastExportAt: null, lastInSeq: 9, backSeq: 0, lastImportAt: null };
    const oldState = deferred<typeof stateValue>();
    const stateApi = role === "external" ? "mirrorState" : "internalState";
    vi.spyOn(api, stateApi).mockReturnValueOnce(oldState.promise).mockResolvedValueOnce(stateValue);
    renderView(role);
    if (role === "internal") fireEvent.click(screen.getByRole("tab", { name: /导入回传/ }));
    else fireEvent.click(screen.getByRole("button", { name: "包详情与其他更新包", exact: true }));
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await act(async () => latest.resolve([pkg("new.bundle", role === "internal" ? "back" : "full")]));
    expect(await screen.findByText("new.bundle")).toBeTruthy();
    await act(async () => { old.resolve([pkg("old.bundle", role === "internal" ? "back" : "full")]); oldState.resolve({ ...stateValue, lastInSeq: 1, outSeq: 1 }); });
    expect(screen.getByText("new.bundle")).toBeTruthy();
    expect(screen.queryByText("old.bundle")).toBeNull();
    if (role === "external") expect(screen.getByText("本次更新 #10 · 全量")).toBeTruthy();
    else {
      fireEvent.click(screen.getByRole("tab", { name: "导出更新" }));
      expect(screen.getByText(/最近已导出 #9 ·/)).toBeTruthy();
    }
  });

  it("旧传输目录的迟到错误不会污染新配置，即使 profile id 未变", async () => {
    const old = deferred<ReturnPackageInfo[]>();
    vi.spyOn(api, "mirrorState").mockResolvedValue({ repoId: "matching", lastInSeq: 9, backSeq: 0, lastImportAt: null });
    vi.spyOn(api, role === "external" ? "listPackages" : "listReturnPackages").mockReturnValueOnce(old.promise).mockResolvedValue([pkg("new-dir.bundle", role === "internal" ? "back" : "full")]);
    const { rerender } = renderView(role);
    if (role === "internal") fireEvent.click(screen.getByRole("tab", { name: /导入回传/ }));
    else fireEvent.click(screen.getByRole("button", { name: "包详情与其他更新包", exact: true }));
    const updated = { ...profile, transferDir: "/new-usb" };
    rerender(<RunnerProvider>{role === "external" ? <ExternalView profile={updated} /> : <InternalView profile={updated} />}</RunnerProvider>);
    expect(await screen.findByText("new-dir.bundle")).toBeTruthy();
    await act(async () => old.reject(new Error("old USB removed")));
    expect(screen.queryByText("old USB removed")).toBeNull();
    expect(screen.getByText("new-dir.bundle")).toBeTruthy();
  });
});

describe("提交列表与推送", () => {
  function selectBranch(name: string) {
    fireEvent.click(screen.getByRole("radio", { name: "选择 " + name }));
  }
  function pushButton(name: string) {
    return within(screen.getByRole("radio", { name: "选择 " + name }).closest(".sync-branch-row") as HTMLElement)
      .getByRole("button", { name: "检查并推送" });
  }
  it("切换分支清除旧列表，迟到请求不能污染后端冻结计划的确认内容", async () => {
    const one = deferred<CommitInfo[]>();
    const two = deferred<CommitInfo[]>();
    const prepared = deferred<PushPlan>();
    vi.spyOn(api, "listCommits").mockImplementation((_repo, _from, to) => to.endsWith("one") ? one.promise : two.promise);
    vi.spyOn(api, "preparePush").mockReturnValue(prepared.promise);
    renderView("internal");
    fireEvent.click(screen.getByRole("tab", { name: /导入回传/ }));
    await screen.findByRole("radio", { name: "选择 feature/one" });
    selectBranch("feature/one");
    selectBranch("feature/two");
    await act(async () => two.resolve([commit("second-branch-preview")]));
    expect(await screen.findByText("second-branch-preview")).toBeTruthy();
    await act(async () => one.resolve([commit("stale-first-commit")]));
    expect(screen.queryByText("stale-first-commit")).toBeNull();
    fireEvent.click(pushButton("feature/two"));
    expect(api.preparePush).toHaveBeenCalledWith("/work", "feature/two", false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "execute_push")).toBe(false);
    await act(async () => prepared.resolve(plan("feature/two", [commit("frozen-second-commit")])));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("frozen-second-commit")).toBeTruthy();
    expect(within(dialog).queryByText("second-branch-preview")).toBeNull();
    expect(within(dialog).queryByText("stale-first-commit")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认推送" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("execute_push", { planId: "plan-feature/two" }));
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "push_branch")).toBe(false);
  });

  it("已有提交在下一分支加载时立即隐藏，提交预览未完成也只能通过后端计划推送", async () => {
    const next = deferred<CommitInfo[]>();
    const prepared = deferred<PushPlan>();
    vi.spyOn(api, "listCommits").mockResolvedValueOnce([commit("previous-commit")]).mockReturnValue(next.promise);
    vi.spyOn(api, "preparePush").mockReturnValue(prepared.promise);
    const execute = vi.spyOn(api, "executePush");
    renderView("internal");
    fireEvent.click(screen.getByRole("tab", { name: /导入回传/ }));
    await screen.findByRole("radio", { name: "选择 feature/one" });
    selectBranch("feature/one");
    expect(await screen.findByText("previous-commit")).toBeTruthy();
    selectBranch("feature/two");
    expect(screen.queryByText("previous-commit")).toBeNull();
    expect(screen.getByText("正在读取提交…")).toBeTruthy();
    fireEvent.click(pushButton("feature/two"));
    expect(execute).not.toHaveBeenCalled();
    await act(async () => next.resolve([commit("next-preview")]));
    expect(screen.getByText("next-preview")).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
    await act(async () => prepared.resolve(plan("feature/two")));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("frozen-commit")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(execute).not.toHaveBeenCalled();
  });

  it("确认框打开后配置变化，确认旧内容不能推送", async () => {
    const execute = vi.spyOn(api, "executePush");
    const { rerender } = renderView("internal");
    fireEvent.click(screen.getByRole("tab", { name: /导入回传/ }));
    await screen.findByRole("radio", { name: "选择 feature/one" });
    fireEvent.click(pushButton("feature/one"));
    const dialog = await screen.findByRole("alertdialog");
    rerender(<RunnerProvider><InternalView profile={{ ...profile, workDir: "/other-work" }} /></RunnerProvider>);
    fireEvent.click(within(dialog).getByRole("button", { name: "确认推送" }));
    await act(async () => {});
    expect(execute).not.toHaveBeenCalled();
  });

  it("预览失败显示错误，准备计划失败不能误报空提交或执行推送", async () => {
    vi.spyOn(api, "listCommits").mockRejectedValue(new Error("missing base"));
    vi.spyOn(api, "preparePush").mockRejectedValue(new Error("cannot prepare frozen plan"));
    const execute = vi.spyOn(api, "executePush");
    render(<RunnerProvider><InternalView profile={profile} /><OperationStatus /></RunnerProvider>);
    fireEvent.click(screen.getByRole("tab", { name: /导入回传/ }));
    await screen.findByRole("radio", { name: "选择 feature/one" });
    selectBranch("feature/one");
    expect(await screen.findByText(/missing base/)).toBeTruthy();
    expect(screen.queryByText("没有相对基准的新提交")).toBeNull();
    fireEvent.click(pushButton("feature/one"));
    expect(await screen.findByText(/cannot prepare frozen plan/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("开发库同步状态", () => {
  async function pendingRepos(paths = profile.devRepos!) {
    let devs: DevSyncStatus[] = paths.map((path) => ({ path, status: "needsFetch", error: null }));
    vi.spyOn(api, "devSyncStatus").mockImplementation(async () => devs);
    render(<RunnerProvider><ExternalView profile={{ ...profile, devRepos: paths }} /><OperationStatus /></RunnerProvider>);
    fireEvent.click(screen.getByRole("button", { name: "开发仓库管理", exact: true }));
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
    fireEvent.click(screen.getByRole("button", { name: "完成同步" }));
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
    fireEvent.click(screen.getByRole("button", { name: "完成同步" }));
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
  fireEvent.click(screen.getByRole("button", { name: "包详情与其他更新包", exact: true }));
  await screen.findByText("本次更新 #3 · 增量");
  fireEvent.click(screen.getByRole("button", { name: /选择更新包/ }));
  await screen.findByRole("listbox");
  const option = (seq: number) => screen.getByRole("option", { name: new RegExp("^#" + seq + " ·") }) as HTMLElement;
  expect(option(3).getAttribute("aria-disabled")).not.toBe("true");
  expect(option(5).getAttribute("aria-disabled")).toBe("true");
  expect(screen.queryByRole("option", { name: /^#4 ·/ })).toBeNull();
  expect(option(6).getAttribute("aria-disabled")).toBe("true");
  expect(option(7).getAttribute("aria-disabled")).not.toBe("true");
  fireEvent.click(option(7));
  fireEvent.click(screen.getByRole("button", { name: "同步更新" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/跳过 #3–#6/)).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "sync_updates")).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "同步到 #7" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("sync_updates", { bundle: "/usb/7.bundle", mirrorDir: "/mirror", devDirs: ["/dev-one", "/dev-two"], name: "", email: "" }));
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
    openBranches(role);
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
    expect(screen.getByText(/已选 0 个/)).toBeTruthy();
    expect(screen.getByRole("row", { name: "feature/two" }).getAttribute("aria-selected")).not.toBe("true");
  });

  it("内网行内 Rebase 对点击的分支执行，不误用已选分支", async () => {
    const rebase = vi.spyOn(api, "rebaseOnto").mockResolvedValue({ ok: true, conflict: false, files: [], message: "已完成", worktree: null });
    renderView("internal");
    openBranches("internal");
    fireEvent.click(await screen.findByRole("row", { name: "feature/one" }));
    fireEvent.click(screen.getByRole("button", { name: "Rebase feature/two" }));
    await waitFor(() => expect(rebase).toHaveBeenCalledWith("/work", "feature/two", "main", true));
    expect(rebase).toHaveBeenCalledTimes(1);
  });
});

it("删除失败保留分支和原选择，行内按钮不会切换选择", async () => {
  vi.spyOn(api, "deleteLocalBranch").mockRejectedValue(new Error("分支尚未合并"));
  render(<RunnerProvider><ExternalView profile={profile} /><OperationStatus /></RunnerProvider>);
  openBranches("external");
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
  openBranches(role);
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
  openBranches(role);
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
  expect(screen.getByText(/已选 0 个/)).toBeTruthy();
});

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api, type CommitInfo, type PackageInfo, type Profile, type RepoStatus } from "../src/api";
import { ExternalView } from "../src/ExternalView";
import { InternalView } from "../src/InternalView";
import { useRepoStatus } from "../src/repoBits";
import { RunnerProvider } from "../src/runner";

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
function pkg(payload: string): PackageInfo {
  return { payloadPath: payload, payloadExists: true, manifestPath: null, manifest: null };
}
function ipc(command: string, args?: Record<string, unknown>): unknown {
  switch (command) {
    case "repo_status": return status(String(args?.path));
    case "probe_repo": return true;
    case "sync_state": return { repoId: null, outSeq: 1, lastHeads: [], lastExportAt: null, lastInSeq: 1, backSeq: 0, lastImportAt: null };
    case "list_packages": return [];
    case "list_commits": return [];
    case "import_in": return { created: false, seq: 2, changes: [] };
    case "push_branch": return { ok: true, conflict: false, files: [], message: "pushed", worktree: null };
    // Rust unit serializes to JSON null, not JavaScript undefined.
    case "create_dev_repo":
    case "sync_dev_repo":
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
  return screen.getByText(path, { exact: true }).parentElement!.parentElement!;
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
    const mutation = deferred<null>();
    const reads = [before.promise, during.promise, after.promise];
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "repo_status") return reads.shift()!;
      if (command === "sync_dev_repo") return mutation.promise;
      throw new Error(command);
    });
    const first = api.repoStatus("/same", "main", []);
    const sync = api.syncDevRepo("/same", "/mirror");
    const second = api.repoStatus("/same", "main", []);
    expect(second).not.toBe(first);
    if (fail) {
      mutation.reject(new Error("sync failed"));
      await expect(sync).rejects.toThrow("sync failed");
    } else {
      mutation.resolve(null);
      await expect(sync).resolves.toBeNull();
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

  it("较慢的存在性探测不能覆盖最新开发库列表", async () => {
    const old = deferred<boolean>();
    vi.spyOn(api, "probeRepo").mockReturnValueOnce(old.promise).mockResolvedValueOnce(false);
    renderView("external");
    fireEvent.click(screen.getAllByRole("button", { name: "刷新", exact: true })[0]);
    await waitFor(() => expect(within(devRow("/dev-two")).getByRole("button", { name: "从镜像克隆" })).toBeTruthy());
    await act(async () => old.resolve(true));
    expect(within(devRow("/dev-two")).getByRole("button", { name: "从镜像克隆" })).toBeTruthy();
    expect(within(devRow("/dev-two")).queryByRole("button", { name: "切换", exact: true })).toBeNull();
  });

  it("首轮只对镜像和当前开发库查完整状态，其余仓库使用 probe", async () => {
    renderView("external");
    await screen.findByRole("button", { name: "切换", exact: true });
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "repo_status").map(([, args]) => (args as { path: string }).path).sort()).toEqual(["/dev-one", "/mirror"]);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "probe_repo")).toEqual([["probe_repo", { path: "/dev-two" }]]);
  });
});

describe.each(["external", "internal"] as const)("%s 组合刷新", (role) => {
  it("较晚完成的旧刷新不覆盖最新包列表和状态", async () => {
    const old = deferred<PackageInfo[]>();
    const latest = deferred<PackageInfo[]>();
    vi.spyOn(api, "listPackages").mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const stateValue = { repoId: null, outSeq: 9, lastHeads: [], lastExportAt: null, lastInSeq: 9, backSeq: 0, lastImportAt: null };
    const oldState = deferred<typeof stateValue>();
    const stateApi = role === "external" ? "mirrorState" : "internalState";
    vi.spyOn(api, stateApi).mockReturnValueOnce(oldState.promise).mockResolvedValueOnce(stateValue);
    renderView(role);
    fireEvent.click(screen.getAllByRole("button", { name: "刷新", exact: true })[0]);
    await act(async () => latest.resolve([pkg("new.bundle")]));
    expect(await screen.findByText("new.bundle")).toBeTruthy();
    await act(async () => { old.resolve([pkg("old.bundle")]); oldState.resolve({ ...stateValue, lastInSeq: 1, outSeq: 1 }); });
    expect(screen.getByText("new.bundle")).toBeTruthy();
    expect(screen.queryByText("old.bundle")).toBeNull();
    if (role === "external") expect(screen.getByText(/已导入到 #9/)).toBeTruthy();
    else expect(screen.getByText(/#9 ·/)).toBeTruthy();
  });

  it("旧传输目录的迟到错误不会污染新配置，即使 profile id 未变", async () => {
    const old = deferred<PackageInfo[]>();
    vi.spyOn(api, "listPackages").mockReturnValueOnce(old.promise).mockResolvedValue([pkg("new-dir.bundle")]);
    const { rerender } = renderView(role);
    const updated = { ...profile, transferDir: "/new-usb" };
    rerender(<RunnerProvider>{role === "external" ? <ExternalView profile={updated} /> : <InternalView profile={updated} />}</RunnerProvider>);
    expect(await screen.findByText("new-dir.bundle")).toBeTruthy();
    await act(async () => old.reject(new Error("old USB removed")));
    expect(screen.queryByText("old USB removed")).toBeNull();
    expect(screen.getByText("new-dir.bundle")).toBeTruthy();
  });
});

describe("提交列表与推送", () => {
  it("切换分支立即禁用推送并清除旧列表，旧请求不能污染确认内容", async () => {
    const one = deferred<CommitInfo[]>();
    const two = deferred<CommitInfo[]>();
    vi.spyOn(api, "listCommits").mockImplementation((_repo, _from, to) => to.endsWith("one") ? one.promise : two.promise);
    renderView("internal");
    fireEvent.click(await screen.findByRole("row", { name: "feature/one", exact: true }));
    expect((screen.getByRole("button", { name: "推送…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("row", { name: "feature/two", exact: true }));
    await act(async () => two.resolve([commit("second-branch-commit")]));
    expect(await screen.findByText("second-branch-commit")).toBeTruthy();
    await act(async () => one.resolve([commit("stale-first-commit")]));
    expect(screen.queryByText("stale-first-commit")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "推送…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("second-branch-commit")).toBeTruthy();
    expect(within(dialog).queryByText("stale-first-commit")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "推送", exact: true }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("push_branch", { workDir: "/work", branch: "feature/two", forceWithLease: false }));
  });

  it("已有提交在下一分支加载时立即隐藏，并且加载完成前不能推送", async () => {
    const next = deferred<CommitInfo[]>();
    vi.spyOn(api, "listCommits").mockResolvedValueOnce([commit("previous-commit")]).mockReturnValueOnce(next.promise);
    renderView("internal");
    fireEvent.click(await screen.findByRole("row", { name: "feature/one", exact: true }));
    expect(await screen.findByText("previous-commit")).toBeTruthy();
    fireEvent.click(screen.getByRole("row", { name: "feature/two", exact: true }));
    expect(screen.queryByText("previous-commit")).toBeNull();
    expect(screen.getByText("正在读取提交列表…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "推送…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => next.resolve([commit("next-commit")]));
    expect(screen.getByText("next-commit")).toBeTruthy();
    expect((screen.getByRole("button", { name: "推送…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("确认框打开后配置变化，确认旧内容不能推送", async () => {
    vi.spyOn(api, "listCommits").mockResolvedValue([commit("approved-commit")]);
    const { rerender } = renderView("internal");
    fireEvent.click(await screen.findByRole("row", { name: "feature/one", exact: true }));
    await screen.findByText("approved-commit");
    fireEvent.click(screen.getByRole("button", { name: "推送…" }));
    const dialog = await screen.findByRole("alertdialog");
    rerender(<RunnerProvider><InternalView profile={{ ...profile, workDir: "/other-work" }} /></RunnerProvider>);
    fireEvent.click(within(dialog).getByRole("button", { name: "推送", exact: true }));
    await act(async () => {});
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "push_branch")).toBe(false);
  });

  it("提交加载失败不可误报为空列表或允许推送", async () => {
    vi.spyOn(api, "listCommits").mockRejectedValue(new Error("missing base"));
    renderView("internal");
    fireEvent.click(await screen.findByRole("row", { name: "feature/one", exact: true }));
    expect(await screen.findByText(/missing base/)).toBeTruthy();
    expect(screen.queryByText("没有相对 origin/main 的新提交")).toBeNull();
    expect((screen.getByRole("button", { name: "推送…" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("开发库 stale 状态", () => {
  async function importMirror(value = profile) {
    vi.spyOn(api, "listPackages").mockResolvedValue([pkg("in.bundle")]);
    renderView("external", value);
    fireEvent.click(await screen.findByRole("button", { name: "导入", exact: true }));
    await waitFor(() => expect(screen.getAllByText("待同步")).toHaveLength(value.devRepos!.length));
  }

  it("null 成功仅清除所同步的库；失败保留标记，重试成功再清除", async () => {
    await importMirror();
    fireEvent.click(within(devRow("/dev-one")).getByRole("button", { name: "同步", exact: true }));
    await waitFor(() => expect(screen.getAllByText("待同步")).toHaveLength(1));
    expect(within(devRow("/dev-two")).getByText("待同步")).toBeTruthy();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "sync_dev_repo") throw new Error("fetch failed");
      return ipc(command, args as Record<string, unknown>);
    });
    fireEvent.click(within(devRow("/dev-two")).getByRole("button", { name: "同步", exact: true }));
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "sync_dev_repo")).toHaveLength(2));
    await act(async () => {});
    expect(within(devRow("/dev-two")).getByText("待同步")).toBeTruthy();
    vi.mocked(invoke).mockImplementation(async (command, args) => ipc(command, args as Record<string, unknown>));
    fireEvent.click(within(devRow("/dev-two")).getByRole("button", { name: "同步", exact: true }));
    await waitFor(() => expect(screen.queryByText("待同步")).toBeNull());
    expect(screen.queryByText("镜像已更新，开发仓库还没跟上")).toBeNull();
  });

  it("批量同步每个 IPC 返回 null 时持续执行并清除全部标记", async () => {
    await importMirror();
    fireEvent.click(screen.getByRole("button", { name: "全部同步", exact: true }));
    await waitFor(() => expect(screen.queryByText("待同步")).toBeNull());
    expect(screen.queryByText("镜像已更新，开发仓库还没跟上")).toBeNull();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "sync_dev_repo").map(([, args]) => (args as { devDir: string }).devDir)).toEqual(["/dev-one", "/dev-two"]);
  });

  it("批量同步部分失败保留失败和未尝试仓库，并刷新已成功的仓库", async () => {
    await importMirror({ ...profile, devRepos: ["/dev-one", "/dev-two", "/dev-three"] });
    const before = vi.mocked(invoke).mock.calls.filter(([command]) => command === "repo_status").length;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "sync_dev_repo" && (args as { devDir: string }).devDir === "/dev-two") throw new Error("second fetch failed");
      return ipc(command, args as Record<string, unknown>);
    });
    fireEvent.click(screen.getByRole("button", { name: "全部同步", exact: true }));
    await waitFor(() => expect(screen.getAllByText("待同步")).toHaveLength(2));
    expect(within(devRow("/dev-one")).queryByText("待同步")).toBeNull();
    expect(within(devRow("/dev-two")).getByText("待同步")).toBeTruthy();
    expect(within(devRow("/dev-three")).getByText("待同步")).toBeTruthy();
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "repo_status").length).toBeGreaterThan(before));
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "sync_dev_repo").map(([, args]) => (args as { devDir: string }).devDir)).toEqual(["/dev-one", "/dev-two"]);
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type PackageInfo, type Profile, type RefEntry, type RepoStatus } from "../src/api";
import { ExternalView } from "../src/ExternalView";
import { OperationStatus, RunnerProvider } from "../src/runner";

const focus = vi.hoisted(() => ({ listener: undefined as undefined | ((event: { payload: boolean }) => void) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: async (listener: typeof focus.listener) => { focus.listener = listener; return () => {}; } }),
}));
// The view consumes the agreed contract; backend/IPC coverage belongs to its owner.
vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, syncUpdates: vi.fn(), devSyncStatus: vi.fn() } };
});
const profile: Profile = {
  id: "project", name: "project", role: "external", repoName: "project", baseBranch: "main",
  transferDir: "/usb", mirrorDir: "/mirror", devRepos: ["/dev-one", "/dev-two"],
  userName: "Developer", userEmail: "dev@example.com",
};
function status(path: string): RepoStatus & { refs: RefEntry[] } {
  return {
    refs: [
      { name: "refs/heads/main", sha: "old-main" },
      { name: "refs/heads/feature/one", sha: "old-feature" },
      { name: "refs/tags/obsolete", sha: "old-tag" },
    ],
    path, exists: true, isRepo: true, isBare: path === "/mirror", isMirror: path === "/mirror",
    currentBranch: "main", worktrees: [], dirtyTrees: [], inProgress: null, inProgressTrees: [], remoteUrl: null,
    branches: ["main", "feature/one", "feature/two"].map((name) => ({
      name, sha: "abcdef123", base: "main", baseInferred: false, ahead: 1, behind: 0, current: name === "main", worktree: null,
    })),
  };
}
function pkg(seq: number, kind: "full" | "incr" = "incr", repoId = "matching", payloadExists = true): PackageInfo {
  return {
    payloadPath: `/usb/${repoId}-${seq}.bundle`, manifestPath: `/usb/${repoId}-${seq}.json`, payloadExists,
    manifest: {
      format: 1, kind, repoName: "project", repoId, seq, createdAt: 1, payload: `${repoId}-${seq}.bundle`,
      baseBranch: "main", refs: [{ name: "refs/heads/main", sha: "new-main" }], toolVersion: "2.0.9",
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function view(value = profile) {
  return <RunnerProvider><ExternalView profile={value} /><OperationStatus /></RunnerProvider>;
}
async function loaded(value = profile) {
  const result = render(view(value));
  await waitFor(() => expect(screen.queryByText("正在检查更新…")).toBeNull());
  return result;
}
function returnTab() { fireEvent.click(screen.getByRole("tab", { name: "回传提交" })); }
function selectBranch(name: string) { fireEvent.click(screen.getByRole("checkbox", { name, exact: true })); }
function expand(text: string) { fireEvent.click(screen.getByRole("button", { name: text, exact: true })); }

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(api, "repoStatus").mockImplementation(async (path) => status(path));
  vi.spyOn(api, "mirrorState").mockResolvedValue({ repoId: "matching", lastInSeq: 2, backSeq: 0, lastImportAt: null });
  vi.spyOn(api, "listPackages").mockResolvedValue([pkg(3)]);
  vi.mocked(api.devSyncStatus).mockResolvedValue([
    { path: "/dev-one", status: "upToDate", error: null }, { path: "/dev-two", status: "upToDate", error: null },
  ]);
  vi.mocked(api.syncUpdates).mockResolvedValue({ imported: { created: false, seq: 3, changes: [] }, repositories: [] });
  vi.spyOn(api, "exportBack").mockResolvedValue({ status: "nothingToSync", message: "没有新提交" });
  vi.spyOn(api, "exportPatches").mockResolvedValue({ status: "nothingToSync", message: "没有新补丁" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("精简外网同步", () => {
  it("原生页签隐藏非活动面板，来回切换保留分支选择与管理表单", async () => {
    await loaded();
    expect(screen.queryByRole("checkbox", { name: "feature/one", exact: true })).toBeNull();
    returnTab();
    selectBranch("feature/one");
    expand("分支管理");
    fireEvent.change(screen.getByRole("textbox", { name: "新分支" }), { target: { value: "feature/draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "同步更新", exact: true }));
    expect(screen.queryByRole("textbox", { name: "新分支" })).toBeNull();
    returnTab();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "新分支" }).value).toBe("feature/draft");
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "feature/one", exact: true }).checked).toBe(true);
  });

  it("Patch 使用原生单选方向键切换，导出只接收当前分支", async () => {
    await loaded();
    returnTab();
    selectBranch("feature/one");
    expand("格式：Bundle");
    fireEvent.click(screen.getByRole("radio", { name: "Patch（单分支）" }));
    const first = screen.getByRole("radio", { name: "feature/one", exact: true });
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = screen.getByRole<HTMLInputElement>("radio", { name: "feature/two", exact: true });
    expect(document.activeElement).toBe(second);
    expect(second.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "导出回传" }));
    await waitFor(() => expect(api.exportPatches).toHaveBeenCalledWith(expect.objectContaining({ branch: "feature/two" })));
  });

  it("默认选择本项目下一包，一条后端命令处理导入及所有开发库", async () => {
    vi.mocked(api.listPackages).mockResolvedValue([pkg(5, "full"), pkg(3, "incr", "other"), pkg(2, "full"), pkg(3)]);
    const importIn = vi.spyOn(api, "importIn");
    const syncDev = vi.spyOn(api, "syncDevRepo");
    const clone = vi.spyOn(api, "createDevRepo");
    await loaded();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["同步更新", "回传提交"]);
    expect(screen.getByText("本次更新 #3 · 增量")).toBeTruthy();
    expand("包详情与其他更新包");
    expect(screen.queryByRole("option", { name: /#2/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /other/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "同步更新", exact: true }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith({
      bundle: "/usb/matching-3.bundle", mirrorDir: "/mirror", devDirs: ["/dev-one", "/dev-two"], name: "Developer", email: "dev@example.com",
    }));
    expect(importIn).not.toHaveBeenCalled(); expect(syncDev).not.toHaveBeenCalled(); expect(clone).not.toHaveBeenCalled();
  });

  it("首轮读取真实引用差异，镜像已导入时用 null 完成同步", async () => {
    vi.mocked(api.listPackages).mockResolvedValue([pkg(2)]);
    vi.mocked(api.devSyncStatus).mockResolvedValue([
      { path: "/dev-one", status: "needsFetch", error: null }, { path: "/dev-two", status: "notCloned", error: null },
    ]);
    await loaded();
    expect(api.devSyncStatus).toHaveBeenCalledWith("/mirror", ["/dev-one", "/dev-two"]);
    fireEvent.click(screen.getByRole("button", { name: "完成同步" }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith(expect.objectContaining({ bundle: null, devDirs: profile.devRepos })));
  });

  it("组合操作部分失败后刷新游标和引用差异，重试不会重复导入", async () => {
    vi.mocked(api.syncUpdates).mockImplementationOnce(async () => {
      vi.mocked(api.mirrorState).mockResolvedValue({ repoId: "matching", lastInSeq: 3, backSeq: 0, lastImportAt: 1 });
      vi.mocked(api.devSyncStatus).mockResolvedValue([
        { path: "/dev-one", status: "upToDate", error: null }, { path: "/dev-two", status: "needsFetch", error: null },
      ]);
      throw new Error("second fetch failed");
    });
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "同步更新", exact: true }));
    expect(await screen.findByText(/同步更新失败：Error: second fetch failed/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "完成同步" }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenLastCalledWith(expect.objectContaining({ bundle: null })));
    expect(api.syncUpdates).toHaveBeenCalledTimes(2);
  });

  it("同步记录损坏单独展示并禁用同步和导出", async () => {
    vi.mocked(api.mirrorState).mockRejectedValue(new Error("corrupt cursor"));
    await loaded();
    expect(screen.getByText("无法读取同步记录，请检查后刷新。")).toBeTruthy();
    expect(screen.getByText("Error: corrupt cursor")).toBeTruthy();
    expect(screen.queryByText("请选择本项目的全量包开始同步。")).toBeNull();
    const sync = screen.getByRole<HTMLButtonElement>("button", { name: "同步更新", exact: true });
    expect(sync.disabled).toBe(true); fireEvent.click(sync);
    returnTab(); selectBranch("feature/one");
    const exportButton = screen.getByRole<HTMLButtonElement>("button", { name: "导出回传" });
    expect(exportButton.disabled).toBe(true); fireEvent.click(exportButton);
    expect(api.syncUpdates).not.toHaveBeenCalled(); expect(api.exportBack).not.toHaveBeenCalled();
  });

  it("首次配置只推荐本项目全量包并由组合操作创建开发库", async () => {
    vi.mocked(api.mirrorState).mockResolvedValue({ repoId: null, lastInSeq: 0, backSeq: 0, lastImportAt: null });
    vi.mocked(api.repoStatus).mockImplementation(async (path) => ({ ...status(path), exists: false, isRepo: false, isBare: false, branches: [] }));
    vi.mocked(api.listPackages).mockResolvedValue([pkg(1), { ...pkg(2, "full"), manifest: { ...pkg(2, "full").manifest!, repoName: "other" } }, pkg(4, "full")]);
    await loaded();
    expect(screen.getByText("本次更新 #4 · 全量")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "同步更新", exact: true }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith(expect.objectContaining({ bundle: "/usb/matching-4.bundle" })));
  });

  it("缺包不能跳过增量；选择较新全量后确认目标及受影响引用", async () => {
    vi.mocked(api.listPackages).mockResolvedValue([pkg(4), pkg(5, "full"), pkg(6, "full", "matching", false)]);
    await loaded();
    expect(screen.getByText("缺少更新 #3，请补齐或选择较新的全量包。")).toBeTruthy();
    expand("包详情与其他更新包");
    fireEvent.click(screen.getByRole("button", { name: /选择更新包/ }));
    expect((await screen.findByRole("option", { name: /#4/ })).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("option", { name: /#6/ }).getAttribute("aria-disabled")).toBe("true");
    if (!screen.queryByRole("listbox")) fireEvent.click(screen.getByRole("button", { name: /选择更新包/ }));
    fireEvent.click(await screen.findByRole("option", { name: /#5/ }));
    fireEvent.click(screen.getByRole("button", { name: "同步更新", exact: true }));
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("/mirror 从 #2 同步到 #5");
    expect(dialog.textContent).toContain("refs/heads/main");
    expect(dialog.textContent).toContain("refs/heads/feature/one：old-feat → 删除");
    expect(dialog.textContent).toContain("refs/tags/obsolete：old-tag → 删除");
    expect(api.syncUpdates).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "同步更新", exact: true }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "同步到 #5" }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith(expect.objectContaining({ bundle: "/usb/matching-5.bundle" })));
  });

  it("全量跳号必须先获得完整分支与标签影响，不能用分支列表代替", async () => {
    vi.mocked(api.listPackages).mockResolvedValue([pkg(5, "full")]);
    vi.mocked(api.repoStatus).mockImplementation(async (path) => {
      const { refs: _refs, ...withoutRefs } = status(path);
      return withoutRefs;
    });
    await loaded(); expand("包详情与其他更新包");
    if (!screen.queryByRole("listbox")) fireEvent.click(screen.getByRole("button", { name: /选择更新包/ }));
    fireEvent.click(await screen.findByRole("option", { name: /#5/ }));
    expect(screen.getByText("无法读取完整引用影响，请刷新后再使用全量包跳号。")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "同步更新", exact: true }).disabled).toBe(true);
    expect(api.syncUpdates).not.toHaveBeenCalled();
  });

  it("全量确认期间配置改变，不能执行旧目标", async () => {
    vi.mocked(api.listPackages).mockResolvedValue([pkg(5, "full")]);
    const { rerender } = await loaded();
    expand("包详情与其他更新包");
    if (!screen.queryByRole("listbox")) fireEvent.click(screen.getByRole("button", { name: /选择更新包/ }));
    fireEvent.click(await screen.findByRole("option", { name: /#5/ }));
    fireEvent.click(screen.getByRole("button", { name: "同步更新", exact: true }));
    const dialog = await screen.findByRole("alertdialog");
    rerender(view({ ...profile, mirrorDir: "/other-mirror" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "同步到 #5" }));
    await act(async () => {});
    expect(api.syncUpdates).not.toHaveBeenCalled();
  });

  it("开发仓库管理中的单库同步不顺带导入当前待同步包", async () => {
    await loaded(); expand("开发仓库管理");
    const row = screen.getByText("/dev-two", { exact: true }).closest(".sync-branch-row")!;
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "同步仓库" }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith(expect.objectContaining({ bundle: null, devDirs: ["/dev-two"] })));
  });

  it("Bundle 默认多选直接导出；Patch 切换后仅保留一个分支", async () => {
    await loaded(); returnTab(); selectBranch("feature/one"); selectBranch("feature/two");
    fireEvent.click(screen.getByRole("button", { name: "导出回传" }));
    await waitFor(() => expect(api.exportBack).toHaveBeenCalledWith(expect.objectContaining({ branches: ["feature/one", "feature/two"] })));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "导出回传" }).disabled).toBe(false));
    expand("格式：Bundle"); fireEvent.click(screen.getByRole("radio", { name: "Patch（单分支）" }));
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "feature/one", exact: true }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "feature/two", exact: true }).checked).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "feature/two", exact: true }));
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "feature/one", exact: true }).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "导出回传" }));
    await waitFor(() => expect(api.exportPatches).toHaveBeenCalledWith(expect.objectContaining({ branch: "feature/two", repo: "/dev-one" })));
  });

  it("分支管理保留 worktree 创建、身份设置和独立 Rebase", async () => {
    const create = vi.spyOn(api, "createBranch").mockResolvedValue(null);
    const identity = vi.spyOn(api, "configureRepo").mockResolvedValue(null);
    const rebase = vi.spyOn(api, "rebaseOnto").mockResolvedValue({ ok: true, conflict: false, files: [], message: "已变基", worktree: null });
    await loaded(); returnTab(); expand("分支管理");
    fireEvent.change(screen.getByRole("textbox", { name: "新分支" }), { target: { value: "feature/new" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "创建为独立 worktree" }));
    fireEvent.change(screen.getByRole("textbox", { name: "worktree 目录" }), { target: { value: "/worktrees/new" } });
    fireEvent.click(screen.getByRole("button", { name: "新建 worktree" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("/dev-one", "feature/new", "main", "/worktrees/new"));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "写入提交身份" }).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "写入提交身份" }));
    await waitFor(() => expect(identity).toHaveBeenCalledWith("/dev-one", "Developer", "dev@example.com"));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Rebase feature/two", exact: true }).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Rebase feature/two", exact: true }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Rebase 到 origin/main" }));
    await waitFor(() => expect(rebase).toHaveBeenCalledWith("/dev-one", "feature/two", "main", false));
    expect(api.exportBack).not.toHaveBeenCalled();
  });

  it("刷新移除分支后清理选择并禁止空导出", async () => {
    await loaded(); returnTab(); selectBranch("feature/one");
    vi.mocked(api.repoStatus).mockImplementation(async (path) => ({ ...status(path), branches: [] }));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "feature/one", exact: true })).toBeNull());
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "导出回传" }).disabled).toBe(true);
  });

  it("迟到的旧状态和同步差异不会覆盖新的配置", async () => {
    const old = deferred<Awaited<ReturnType<typeof api.devSyncStatus>>>();
    vi.mocked(api.devSyncStatus).mockReturnValueOnce(old.promise);
    const { rerender } = render(view());
    vi.mocked(api.listPackages).mockResolvedValue([pkg(4)]);
    vi.mocked(api.mirrorState).mockResolvedValue({ repoId: "matching", lastInSeq: 3, backSeq: 0, lastImportAt: null });
    rerender(view({ ...profile, transferDir: "/new-usb" }));
    expect(await screen.findByText("本次更新 #4 · 增量")).toBeTruthy();
    await act(async () => old.resolve([{ path: "/dev-one", status: "unknown", error: "stale error" }]));
    expect(screen.getByText("本次更新 #4 · 增量")).toBeTruthy();
    expect(screen.queryByText("stale error")).toBeNull();
  });

  it("返回窗口时重新查询真实同步差异", async () => {
    await loaded(); vi.useFakeTimers();
    act(() => focus.listener?.({ payload: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(301); });
    expect(api.devSyncStatus).toHaveBeenCalledTimes(2);
  });

  it("页签支持方向键与 Home / End 并移动焦点", async () => {
    await loaded();
    const sync = screen.getByRole("tab", { name: "同步更新" });
    const back = screen.getByRole("tab", { name: "回传提交" });
    act(() => sync.focus());
    fireEvent.keyDown(sync, { key: "ArrowRight" }); expect(document.activeElement).toBe(back);
    fireEvent.keyDown(back, { key: "Home" }); expect(document.activeElement).toBe(sync);
    fireEvent.keyDown(sync, { key: "End" }); expect(document.activeElement).toBe(back);
    fireEvent.keyDown(back, { key: "ArrowLeft" }); expect(document.activeElement).toBe(sync);
  });
});

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
    isRepo: true, isBare: path === "/mirror",
    dirtyTrees: [], inProgress: null, inProgressTrees: [],
    branches: ["main", "feature/one", "feature/two"].map((name) => ({
      name, sha: "abcdef123", base: "main", baseInferred: false, ahead: 1, behind: 0, current: name === "main", worktree: null,
    })),
  };
}
function pkg(seq: number, kind: "full" | "incr" = "incr", repoId = "matching", payloadExists = true): PackageInfo {
  return {
    payloadPath: `/usb/${repoId}-${seq}.bundle`, payloadExists,
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
  await waitFor(() => expect(screen.queryByText("正在读取仓库状态…")).toBeNull());
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "刷新", exact: true }).disabled).toBe(false));
  return result;
}
function managedCheckbox(name: string) { return within(screen.getByRole("row", { name, exact: true })).getByRole<HTMLInputElement>("checkbox"); }
function selectBranch(name: string) { fireEvent.click(managedCheckbox(name)); }
function expand(text: string) { fireEvent.click(screen.getByRole("button", { name: text, exact: true })); }

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(api, "repoStatus").mockImplementation(async (path) => status(path));
  vi.spyOn(api, "mirrorState").mockResolvedValue({ repoId: "matching", lastInSeq: 2, backSeq: 0, lastImportAt: null });
  vi.spyOn(api, "listPackages").mockResolvedValue([pkg(3)]);
  vi.mocked(api.devSyncStatus).mockResolvedValue([
    { path: "/dev-one", status: "upToDate", error: null }, { path: "/dev-two", status: "upToDate", error: null },
  ]);
  vi.mocked(api.syncUpdates).mockResolvedValue(null);
  vi.spyOn(api, "exportBack").mockResolvedValue({ status: "nothingToSync", message: "没有新提交" });
  vi.spyOn(api, "exportPatches").mockResolvedValue({ status: "nothingToSync", message: "没有新补丁" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("精简外网同步", () => {
  it("外网分支管理不提供推送入口", async () => {
    const prepare = vi.spyOn(api, "preparePush");
    await loaded();
    const operations = screen.getByRole("region", { name: "分支操作" });
    expect(within(operations).queryByRole("button", { name: "检查并推送 feature/one" })).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("只有一个开发仓库时保留一个同步入口", async () => {
    await loaded({ ...profile, devRepos: ["/dev-one"] });
    expect(screen.getByRole("button", { name: "同步开发仓库", exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "同步仓库", exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "同步开发仓库", exact: true }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith(expect.objectContaining({ devDirs: ["/dev-one"] })));
  });
  it("同步、回传与行内分支操作同时可见，缺包和仓库提示不重复", async () => {
    vi.mocked(api.repoStatus).mockImplementation(async (path) => ({
      ...status(path), isRepo: path === "/mirror", branches: [],
    }));
    vi.mocked(api.listPackages).mockResolvedValue([pkg(4)]);
    await loaded();
    expect(screen.getByRole("region", { name: "导入更新" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "回传提交" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "分支操作" })).toBeTruthy();
    expect(screen.getAllByText("缺少更新 #3，请在传输目录补齐更新包或放入较新的全量包。")).toHaveLength(1);
    expect(screen.getAllByText("请先导入更新，再同步开发仓库。")).toHaveLength(1);
  });

  it("同步仓库完成后由仓库状态反馈，不再显示重复成功浮层", async () => {
    vi.mocked(api.devSyncStatus).mockResolvedValueOnce([
      { path: "/dev-one", status: "needsFetch", error: null }, { path: "/dev-two", status: "upToDate", error: null },
    ]);
    await loaded();
    expect(screen.getByText("待同步 · 当前仓库")).toBeTruthy();
    const sync = deferred<Awaited<ReturnType<typeof api.syncUpdates>>>();
    const refresh = deferred<Awaited<ReturnType<typeof api.mirrorState>>>();
    vi.mocked(api.syncUpdates).mockReturnValueOnce(sync.promise);
    vi.mocked(api.mirrorState).mockReturnValueOnce(refresh.promise);

    fireEvent.click(screen.getAllByRole("button", { name: "同步仓库", exact: true })[0]);
    expect(screen.getByText("正在同步开发仓库，请稍候…").closest(".operation-popups")).toBeTruthy();
    expect(document.querySelector(".sync-workspace")?.textContent).not.toMatch(/正在检查更新|正在读取开发分支/);
    await act(async () => sync.resolve(null));
    expect(screen.queryByText("已完成开发仓库同步")).toBeNull();
    expect(screen.queryByText("正在检查更新…")).toBeNull();
    expect(screen.queryByText("正在读取开发分支…")).toBeNull();
    await act(async () => refresh.resolve({ repoId: "matching", lastInSeq: 2, backSeq: 0, lastImportAt: null }));
    expect(screen.getByText("本次更新 #3 · 增量")).toBeTruthy();
    expect(screen.getByText("已同步 · 当前仓库")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "操作提示" })).toBeNull();
  });

  it("行内身份设置与回传共用分支表，刷新保留回传选择和新建表单", async () => {
    const identity = vi.spyOn(api, "configureRepo").mockResolvedValue(null);
    await loaded();
    selectBranch("feature/one");
    const operations = screen.getByRole("region", { name: "分支操作" });
    const draft = within(operations).getByRole<HTMLInputElement>("textbox", { name: "新分支" });
    fireEvent.change(draft, { target: { value: "feature/draft" } });
    fireEvent.click(within(operations).getByRole("button", { name: "写入提交身份" }));
    await waitFor(() => expect(identity).toHaveBeenCalledWith("/dev-one", "Developer", "dev@example.com"));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "导出回传" }).disabled).toBe(false));
    expect(draft.value).toBe("feature/draft");
    expect(managedCheckbox("feature/one").getAttribute("aria-checked")).toBe("true");
    expect(managedCheckbox("feature/two").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "导出回传" }));
    await waitFor(() => expect(api.exportBack).toHaveBeenCalledWith(expect.objectContaining({ branches: ["feature/one"] })));
  });

  it("Patch 使用表格单选，键盘切换后只导出当前分支", async () => {
    await loaded();
        selectBranch("feature/one");

    fireEvent.click(screen.getByRole("radio", { name: "Patch（单分支）" }));
    const first = screen.getByRole("row", { name: "feature/one" });
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = screen.getByRole("row", { name: "feature/two" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: " " });
    expect(managedCheckbox("feature/two").getAttribute("aria-checked")).toBe("true");
    expect(managedCheckbox("feature/one").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "导出回传" }));
    await waitFor(() => expect(api.exportPatches).toHaveBeenCalledWith(expect.objectContaining({ branch: "feature/two" })));
  });

  it("默认选择本项目下一包，只向镜像导入并保持区块对应顺序", async () => {
    vi.mocked(api.listPackages).mockResolvedValue([pkg(5, "full"), pkg(3, "incr", "other"), pkg(2, "full"), pkg(3)]);
    await loaded();
    expect(screen.getByRole("heading", { name: "同步与回传", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "同步与回传" })).toBeNull();
    expect(screen.getByRole("region", { name: "导入更新" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "回传提交" })).toBeTruthy();
    expect(screen.getByText("本次更新 #3 · 增量")).toBeTruthy();

    expect([...document.querySelectorAll(".sync-panel > .sync-workflow-section")].map((section) => section.getAttribute("aria-label")))
      .toEqual(["同步开发仓库", "导入更新", "回传提交"]);
    expect(screen.queryByRole("option", { name: /#2/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /other/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "导入下一包", exact: true }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith({
      bundle: "/usb/matching-3.bundle", mirrorDir: "/mirror", devDirs: [], name: "", email: "",
      confirmation: {
        manifest: pkg(3).manifest, lastInSeq: 2, allowFullGap: false,
        mirrorRefs: Object.fromEntries(status("/mirror").refs.map((ref) => [ref.name, ref.sha])),
      },
    }));
  });

  it("未配置开发仓库时仍可只导入镜像", async () => {
    await loaded({ ...profile, devRepos: [] });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "同步开发仓库", exact: true }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "导入下一包", exact: true }).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "导入下一包", exact: true }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledExactlyOnceWith({
      bundle: "/usb/matching-3.bundle", mirrorDir: "/mirror", devDirs: [], name: "", email: "",
      confirmation: {
        manifest: pkg(3).manifest, lastInSeq: 2, allowFullGap: false,
        mirrorRefs: Object.fromEntries(status("/mirror").refs.map((ref) => [ref.name, ref.sha])),
      },
    }));
  });

  it("更新包列表默认最新五个，展开后保留历史并只允许导入可用包", async () => {
    vi.mocked(api.listPackages).mockResolvedValue([
      ...Array.from({ length: 8 }, (_, index) => pkg(index + 1)), pkg(99, "full", "other"),
    ]);
    await loaded();
    const list = screen.getByRole("list", { name: "更新包列表" });
    expect(within(list).getAllByRole("listitem").map((row) => row.getAttribute("aria-label"))).toEqual([
      "matching-8.bundle", "matching-7.bundle", "matching-6.bundle", "matching-5.bundle", "matching-4.bundle",
    ]);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "导入更新 #4", exact: true }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "展开其余 3 个更新包" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(within(screen.getByRole("listitem", { name: "matching-2.bundle" })).getByText("已导入")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "导入更新 #2", exact: true }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "导入更新 #3", exact: true }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith(expect.objectContaining({ bundle: "/usb/matching-3.bundle" })));
  });

  it("列表内选择全量跳号仍需确认引用影响，取消不会同步", async () => {
    vi.mocked(api.listPackages).mockResolvedValue([pkg(3), pkg(7, "full")]);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "导入更新 #7", exact: true }));
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("/mirror 从 #2 导入到 #7");
    expect(dialog.textContent).toContain("refs/tags/obsolete");
    expect(api.syncUpdates).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.syncUpdates).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "导入更新 #7", exact: true }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "导入到 #7" }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith(expect.objectContaining({
      bundle: "/usb/matching-7.bundle",
      confirmation: {
        manifest: pkg(7, "full").manifest, lastInSeq: 2, allowFullGap: true,
        mirrorRefs: Object.fromEntries(status("/mirror").refs.map((ref) => [ref.name, ref.sha])),
      },
    })));
  });

  it("首轮读取真实引用差异，镜像已导入时用 null 同步开发仓库", async () => {
    vi.mocked(api.listPackages).mockResolvedValue([pkg(2)]);
    vi.mocked(api.devSyncStatus).mockResolvedValue([
      { path: "/dev-one", status: "needsFetch", error: null }, { path: "/dev-two", status: "notCloned", error: null },
    ]);
    await loaded();
    expect(api.devSyncStatus).toHaveBeenCalledWith("/mirror", ["/dev-one", "/dev-two"]);
    fireEvent.click(screen.getByRole("button", { name: "同步开发仓库" }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith(expect.objectContaining({ bundle: null, devDirs: profile.devRepos })));
  });

  it("开发仓库同步部分失败后刷新引用差异，重试不会导入更新包", async () => {
    vi.mocked(api.mirrorState).mockResolvedValue({ repoId: "matching", lastInSeq: 3, backSeq: 0, lastImportAt: 1 });
    vi.mocked(api.syncUpdates).mockImplementationOnce(async () => {
      vi.mocked(api.mirrorState).mockResolvedValue({ repoId: "matching", lastInSeq: 3, backSeq: 0, lastImportAt: 1 });
      vi.mocked(api.devSyncStatus).mockResolvedValue([
        { path: "/dev-one", status: "upToDate", error: null }, { path: "/dev-two", status: "needsFetch", error: null },
      ]);
      throw new Error("second fetch failed");
    });
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "同步开发仓库", exact: true }));
    expect(await screen.findByText(/同步开发仓库失败：Error: second fetch failed/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "同步开发仓库" }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenLastCalledWith(expect.objectContaining({ bundle: null })));
    expect(api.syncUpdates).toHaveBeenCalledTimes(2);
  });

  it("同步记录损坏单独展示并禁用同步和导出", async () => {
    vi.mocked(api.mirrorState).mockRejectedValue(new Error("corrupt cursor"));
    await loaded();
    const error = await screen.findByText(/无法读取同步记录，请检查后刷新。/);
    expect(error.textContent).toContain("Error: corrupt cursor");
    expect(error.closest(".operation-popups")).toBeNull();
    expect(error.closest(".sync-workspace")).toBeTruthy();
    expect(screen.queryByText("请将本项目的全量包放入传输目录后同步。")).toBeNull();
    const sync = screen.getByRole<HTMLButtonElement>("button", { name: "导入下一包", exact: true });
    expect(sync.disabled).toBe(true); fireEvent.click(sync);
    selectBranch("feature/one");
    const exportButton = screen.getByRole<HTMLButtonElement>("button", { name: "导出回传" });
    expect(exportButton.disabled).toBe(true); fireEvent.click(exportButton);
    expect(api.syncUpdates).not.toHaveBeenCalled(); expect(api.exportBack).not.toHaveBeenCalled();
  });

  it("首次配置只推荐本项目全量包，导入后再单独准备开发库", async () => {
    vi.mocked(api.mirrorState).mockResolvedValue({ repoId: null, lastInSeq: 0, backSeq: 0, lastImportAt: null });
    vi.mocked(api.repoStatus).mockImplementation(async (path) => ({ ...status(path), exists: false, isRepo: false, isBare: false, branches: [] }));
    vi.mocked(api.listPackages).mockResolvedValue([pkg(1), { ...pkg(2, "full"), manifest: { ...pkg(2, "full").manifest!, repoName: "other" } }, pkg(4, "full")]);
    await loaded();
    expect(screen.getByText("本次更新 #4 · 全量")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "导入下一包", exact: true }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith(expect.objectContaining({
      bundle: "/usb/matching-4.bundle",
      confirmation: { manifest: pkg(4, "full").manifest, lastInSeq: 0, mirrorRefs: {}, allowFullGap: false },
    })));
  });

  it("缺包时自动匹配可用全量包，确认目标及受影响引用后同步", async () => {
    vi.mocked(api.listPackages).mockResolvedValue([pkg(4), pkg(5, "full"), pkg(6, "full", "matching", false)]);
    await loaded();
    expect(screen.getByText("本次更新 #5 · 全量")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /选择更新包/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "更新包" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "导入下一包", exact: true }));
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("/mirror 从 #2 导入到 #5");
    expect(dialog.textContent).toContain("refs/heads/main");
    expect(dialog.textContent).toContain("refs/heads/feature/one：old-feat → 删除");
    expect(dialog.textContent).toContain("refs/tags/obsolete：old-tag → 删除");
    expect(api.syncUpdates).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "导入下一包", exact: true }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "导入到 #5" }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith(expect.objectContaining({ bundle: "/usb/matching-5.bundle" })));
  });

  it.each(["full", "incr"] as const)("%s 导入必须先获得完整分支与标签快照，不能用分支列表代替", async (kind) => {
    vi.mocked(api.listPackages).mockResolvedValue([pkg(kind === "full" ? 5 : 3, kind)]);
    vi.mocked(api.repoStatus).mockImplementation(async (path) => {
      const { refs: _refs, ...withoutRefs } = status(path);
      return withoutRefs;
    });
    await loaded();
    expect(screen.getByText("无法读取完整引用影响，请刷新后再导入更新。")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "导入下一包", exact: true }).disabled).toBe(true);
    expect(api.syncUpdates).not.toHaveBeenCalled();
  });

  it("全量确认期间配置改变，不能执行旧目标", async () => {
    vi.mocked(api.listPackages).mockResolvedValue([pkg(5, "full")]);
    const { rerender } = await loaded();

    fireEvent.click(screen.getByRole("button", { name: "导入下一包", exact: true }));
    const dialog = await screen.findByRole("alertdialog");
    rerender(view({ ...profile, mirrorDir: "/other-mirror" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "导入到 #5" }));
    await act(async () => {});
    expect(api.syncUpdates).not.toHaveBeenCalled();
  });

  it("全量确认期间焦点刷新发现新包，旧确认失效且可以重新确认", async () => {
    vi.mocked(api.listPackages).mockResolvedValue([pkg(5, "full")]);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "导入下一包", exact: true }));
    const dialog = await screen.findByRole("alertdialog");
    vi.mocked(api.listPackages).mockResolvedValue([pkg(7, "full")]);
    vi.useFakeTimers();
    act(() => focus.listener?.({ payload: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(301); });
    vi.useRealTimers();
    expect(api.listPackages).toHaveBeenCalledTimes(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "导入到 #5" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.syncUpdates).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "导入下一包", exact: true }));
    const fresh = await screen.findByRole("alertdialog");
    fireEvent.click(within(fresh).getByRole("button", { name: "导入到 #7" }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith(expect.objectContaining({ bundle: "/usb/matching-7.bundle" })));
  });

  it("开发仓库管理中的单库同步不顺带导入当前待同步包", async () => {
    await loaded();
    const row = screen.getByText("/dev-two", { exact: true }).closest(".sync-branch-row")!;
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "同步仓库" }));
    await waitFor(() => expect(api.syncUpdates).toHaveBeenCalledWith(expect.objectContaining({ bundle: null, devDirs: ["/dev-two"] })));
  });

  it("导出结果与警告弹出提示，文件详情留在原页面", async () => {
    vi.mocked(api.exportBack).mockResolvedValue({
      status: "exported", kind: "back", seq: 4, payload: "/usb/back-4.bundle",
      manifest: "/usb/back-4.json", refs: [], warnings: ["部分分支没有新增提交"],
    });
    await loaded();
    selectBranch("feature/one");
    fireEvent.click(screen.getByRole("button", { name: "导出回传" }));
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("已生成回传 #4");
    expect(banner.textContent).toContain("部分分支没有新增提交");
    expect(banner.closest(".operation-popups")?.parentElement).toBe(document.body);
    fireEvent.click(screen.getByRole("button", { name: "查看回传 #4 文件" }));
    expect(screen.getByText("/usb/back-4.bundle").closest(".sync-panel")).toBeTruthy();
  });

  it("Bundle 默认多选直接导出；Patch 切换后仅保留一个分支", async () => {
    await loaded(); selectBranch("feature/one"); selectBranch("feature/two");
    fireEvent.click(screen.getByRole("button", { name: "导出回传" }));
    await waitFor(() => expect(api.exportBack).toHaveBeenCalledWith(expect.objectContaining({ branches: ["feature/one", "feature/two"] })));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "导出回传" }).disabled).toBe(false));
    fireEvent.click(screen.getByRole("radio", { name: "Patch（单分支）" }));
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /^选择 feature\/one/, exact: true }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /^选择 feature\/two/, exact: true }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("checkbox", { name: /^选择 feature\/two/, exact: true }));
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /^选择 feature\/one/, exact: true }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "导出回传" }));
    await waitFor(() => expect(api.exportPatches).toHaveBeenCalledWith(expect.objectContaining({ branch: "feature/two", repo: "/dev-one" })));
  });

  it("Patch 模式的行内表单选，切回 Bundle 后同一张表允许全选", async () => {
    await loaded();
    selectBranch("feature/one");
    fireEvent.click(screen.getByRole("radio", { name: "Patch（单分支）" }));
    const operations = screen.getByRole("region", { name: "分支操作" });
    expect(within(operations).queryByRole("checkbox", { name: "全选" })).toBeNull();
    expect(managedCheckbox("feature/one").getAttribute("aria-checked")).toBe("true");
    selectBranch("feature/two");
    expect(managedCheckbox("feature/one").getAttribute("aria-checked")).toBe("false");
    expect(managedCheckbox("feature/two").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "导出回传" }));
    await waitFor(() => expect(api.exportPatches).toHaveBeenCalledWith(expect.objectContaining({ branch: "feature/two" })));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "导出回传" }).disabled).toBe(false));
    fireEvent.click(screen.getByRole("radio", { name: "Bundle", exact: true }));
    expect(managedCheckbox("feature/one").getAttribute("aria-checked")).toBe("false");
    expect(managedCheckbox("feature/two").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(operations).getByRole("checkbox", { name: "全选" }));
    expect(managedCheckbox("feature/one").getAttribute("aria-checked")).toBe("true");
    expect(managedCheckbox("feature/two").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "导出回传" }));
    await waitFor(() => expect(api.exportBack).toHaveBeenCalledWith(expect.objectContaining({ branches: ["feature/one", "feature/two"] })));
  });

  it("关联分支显示修改标记，进行中操作仍可恢复并展示冲突", async () => {
    vi.mocked(api.repoStatus).mockImplementation(async (path) => ({
      ...status(path),
      dirtyTrees: [{ path: "/worktrees/one", branch: "feature/one", bare: false, main: false }],
      inProgressTrees: [{ path: "/worktrees/one", branch: "feature/one", op: "rebase", main: false }],
    }));
    const resume = vi.spyOn(api, "continueOp").mockResolvedValue({
      ok: false, conflict: true, files: ["conflict.ts"], message: "仍需解决冲突", worktree: "/worktrees/one",
    });
    await loaded();
    expect(within(screen.getByRole("row", { name: "feature/one" })).getByText("未提交修改")).toBeTruthy();
    expect(screen.queryByText(/有未提交的修改/)).toBeNull();
    expect(screen.getAllByText(/有未完成的 rebase/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "继续", exact: true }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("/worktrees/one"));
    expect(await screen.findByText("conflict.ts")).toBeTruthy();
  });

  it("分支管理可以确认删除本地分支并刷新列表", async () => {
    const remove = vi.spyOn(api, "deleteLocalBranch").mockImplementation(async () => {
      vi.mocked(api.repoStatus).mockImplementation(async (path) => ({
        ...status(path), branches: status(path).branches.filter((branch) => branch.name !== "feature/two"),
      }));
      return { status: "deleted", message: "已删除分支" };
    });
    await loaded(); fireEvent.click(managedCheckbox("feature/two"));
    fireEvent.click(screen.getByRole("button", { name: "删除本地分支 feature/two" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除本地分支", exact: true }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("/dev-one", "feature/two"));
    await waitFor(() => expect(screen.queryByRole("row", { name: "feature/two" })).toBeNull());
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "全选" }).getAttribute("aria-checked")).toBe("false");
  });

  it("分支管理保留 worktree 创建、身份设置和独立 Rebase", async () => {
    const create = vi.spyOn(api, "createBranch").mockResolvedValue(null);
    const identity = vi.spyOn(api, "configureRepo").mockResolvedValue(null);
    const rebase = vi.spyOn(api, "rebaseOnto").mockResolvedValue({ ok: true, conflict: false, files: [], message: "已变基", worktree: null });
    await loaded();
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
    await loaded(); selectBranch("feature/one");
    vi.mocked(api.repoStatus).mockImplementation(async (path) => ({ ...status(path), branches: [] }));
    fireEvent.click(screen.getByRole("button", { name: "刷新", exact: true }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: /^选择 feature\/one/, exact: true })).toBeNull());
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

  it("切换开发仓库只读取当前仓库，保留更新包搜索和展开状态", async () => {
    vi.mocked(api.listPackages).mockResolvedValue(Array.from({ length: 12 }, (_, index) => pkg(index + 1)));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "展开其余 7 个更新包" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索更新包" }), { target: { value: "matching-" } });
    const reads = vi.mocked(api.repoStatus).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    await waitFor(() => expect(api.repoStatus).toHaveBeenLastCalledWith("/dev-two", "main", []));
    expect(api.repoStatus).toHaveBeenCalledTimes(reads + 1);
    expect(api.listPackages).toHaveBeenCalledTimes(1);
    expect(api.mirrorState).toHaveBeenCalledTimes(1);
    expect(api.devSyncStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "搜索更新包" }).value).toBe("matching-");
    expect(screen.getByRole("button", { name: "收起", exact: true }).getAttribute("aria-expanded")).toBe("true");
    expect(within(screen.getByRole("list", { name: "更新包列表" })).getAllByRole("listitem")).toHaveLength(12);
  });

  it("再次失焦或卸载时取消尚未触发的刷新，重复焦点只刷新一次", async () => {
    const { unmount } = await loaded();
    vi.useFakeTimers();
    act(() => focus.listener?.({ payload: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    act(() => focus.listener?.({ payload: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(301); });
    expect(api.devSyncStatus).toHaveBeenCalledTimes(1);
    act(() => { focus.listener?.({ payload: true }); focus.listener?.({ payload: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(301); });
    expect(api.devSyncStatus).toHaveBeenCalledTimes(2);
    act(() => focus.listener?.({ payload: true }));
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(301); });
    expect(api.devSyncStatus).toHaveBeenCalledTimes(2);
  });

  it("返回窗口时重新查询真实同步差异", async () => {
    await loaded(); vi.useFakeTimers();
    act(() => focus.listener?.({ payload: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(301); });
    expect(api.devSyncStatus).toHaveBeenCalledTimes(2);
  });

  it("回传提交内仅有一张行内分支表，直接控制回传选择且没有独立入口", async () => {
    await loaded();
    expect(screen.queryByRole("tablist")).toBeNull();
    const returns = screen.getByRole("region", { name: "回传提交" });
    const operations = within(returns).getByRole("region", { name: "分支操作" });
    const grid = within(operations).getByRole("grid", { name: "本地分支" });
    expect(within(returns).getAllByRole("grid")).toEqual([grid]);
    expect(screen.queryByRole("button", { name: "分支管理", exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭分支管理" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "分支管理", exact: true })).toBeNull();
    expect(screen.queryByRole("tab", { name: "分支管理" })).toBeNull();
    fireEvent.click(within(grid).getByRole("checkbox", { name: "选择 feature/one" }));
    expect(managedCheckbox("feature/one").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(returns).getByRole("button", { name: "导出回传" }));
    await waitFor(() => expect(api.exportBack).toHaveBeenCalledWith(expect.objectContaining({ branches: ["feature/one"] })));
  });

});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api, type Profile, type PushPlan, type RepoStatus, type ReturnPackageInfo } from "../src/api";
import { InternalView } from "../src/InternalView";
import { OperationStatus, RunnerProvider } from "../src/runner";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }),
}));

const profile: Profile = {
  id: "internal", name: "内网", role: "internal", repoName: "project", baseBranch: "main",
  releaseBranches: ["release/1.0"], transferDir: "/usb", mirrorDir: "/mirror", workDir: "/work",
  remoteUrl: "ssh://git/project",
};
const success = { ok: true, conflict: false, files: [], message: "完成", worktree: null };
function status(path: string): RepoStatus {
  return {
    path, exists: true, isRepo: true, isBare: path === "/mirror", isMirror: path === "/mirror",
    currentBranch: "main", worktrees: [], dirtyTrees: [], inProgress: null, inProgressTrees: [], remoteUrl: null,
    branches: [{ name: "feature/one", sha: "preview-oid", base: "main", baseInferred: false,
      ahead: 1, behind: 0, current: false, worktree: null }],
  };
}
function returnPackage(received = false): ReturnPackageInfo {
  return {
    payloadPath: "/usb/back.bundle", manifestPath: "/usb/back.json", payloadExists: true,
    received, receiptKey: "receipt-one",
    manifest: { format: 1, kind: "back", repoName: "project", repoId: "project-id", seq: 3, createdAt: 1,
      payload: "back.bundle", baseBranch: "main", toolVersion: "2.0.9",
      refs: [{ name: "refs/heads/feature/returned", sha: "returned-oid", base: "main" }] },
  };
}
function frozenPlan(): PushPlan {
  return {
    planId: "frozen-plan-id", sourceOid: "frozen-source-oid", remoteOid: "frozen-remote-oid", baseOid: "frozen-base-oid",
    targetRef: "refs/heads/feature/remote-target", remoteUrl: "ssh://git/frozen-project", nonFastForward: false,
    commits: [{ sha: "frozen-source-oid", subject: "后端冻结提交", author: "Alice", email: "alice@example.com", date: "2026-01-01" }],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function view(value = profile) {
  return <RunnerProvider><InternalView profile={value} /><OperationStatus /></RunnerProvider>;
}
function openReturns() {
  fireEvent.click(screen.getByRole("tab", { name: /导入回传/ }));
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    switch (command) {
      case "repo_status": return status((args as { path: string }).path);
      case "sync_state": return { repoId: "project-id", outSeq: 4, lastHeads: [], lastExportAt: null };
      case "list_return_packages": return [];
      case "list_commits": return [{ ...frozenPlan().commits[0], sha: "preview-oid", subject: "前端预览提交" }];
      case "prepare_push": return frozenPlan();
      case "execute_push": return success;
      case "export_out": return { status: "nothingToSync", message: "没有新更新" };
      default: throw new Error(`Unexpected IPC: ${command}`);
    }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); vi.unstubAllGlobals(); });

describe("内网双页签工作流", () => {
  it("工作仓库提示只在回传页显示，离开页签后清理", async () => {
    vi.spyOn(api, "repoStatus").mockImplementation(async (path) => ({
      ...status(path), isRepo: path === "/mirror", branches: [],
    }));
    render(view());
    await waitFor(() => expect(screen.queryByText("正在读取仓库与回传包…")).toBeNull());
    const message = "请先在项目设置中填写已克隆的内网工作仓库。";
    expect(screen.queryByText(message)).toBeNull();
    openReturns();
    expect(await screen.findByText(message)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "导出更新" }));
    expect(screen.queryByText(message)).toBeNull();
  });

  it("没有独立工作树的审查分支可直接换基准，在当前仓库整理", async () => {
    const local = "review/receipt-one/feature/returned";
    vi.spyOn(api, "repoStatus").mockImplementation(async (path) => ({
      ...status(path), branches: [{ ...status(path).branches[0], name: local, worktree: null }],
      reviewSources: { [local]: "feature/returned" },
    }));
    const imported = vi.spyOn(api, "importReturn");
    const rebased = vi.spyOn(api, "rebaseOnto").mockResolvedValue(success);
    render(view());
    openReturns();
    fireEvent.click(await screen.findByRole("radio", { name: "选择 feature/returned" }));
    fireEvent.click(screen.getByRole("button", { name: "提交与分支选项" }));
    const baseSelect = screen.getByRole<HTMLButtonElement>("button", { name: /基准分支/ });
    expect(baseSelect.disabled).toBe(false);
    expect(screen.queryByText(/恢复审查工作树/)).toBeNull();
    fireEvent.click(baseSelect);
    fireEvent.click(await screen.findByRole("option", { name: /release\/1.0/ }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "检查并推送" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "整理提交", exact: true }));
    await waitFor(() => expect(rebased).toHaveBeenCalledExactlyOnceWith("/work", local, "release/1.0", true));
    expect(imported).not.toHaveBeenCalled();
  });
  it("损坏补丁仅禁用自身导入，正常回传包仍可选择", async () => {
    const healthy = returnPackage();
    const broken: ReturnPackageInfo = {
      ...returnPackage(), payloadPath: "/usb/incomplete", received: false, receiptKey: null,
      error: "目录里没有 .patch 文件",
      manifest: { ...returnPackage().manifest!, kind: "patch", seq: 4 },
    };
    vi.spyOn(api, "listReturnPackages").mockResolvedValue([healthy, broken]);
    render(view());
    openReturns();
    expect(await screen.findByText("包内容异常")).toBeTruthy();
    expect(screen.getByText(/包内容无法读取，请检查后重新复制/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "导入回传", exact: true }).disabled).toBe(true);
    expect(screen.queryByText(/无法读取传输目录/)).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /back.bundle/ }));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "导入回传", exact: true }).disabled).toBe(false));
  });

  it("通过 listReturnPackages 查询接收记录，导出更新沿用当前项目契约", async () => {
    render(view());
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["导出更新", "导入回传"]);
    const exportButton = await screen.findByRole<HTMLButtonElement>("button", { name: "导出更新" });
    await waitFor(() => expect(exportButton.disabled).toBe(false));
    expect(invoke).toHaveBeenCalledWith("list_return_packages", { workDir: "/work", dir: "/usb" });
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "list_packages")).toBe(false);
    fireEvent.click(exportButton);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("export_out", {
      mirrorDir: "/mirror", transferDir: "/usb", repoName: "project", baseBranch: "main", fetchUpstream: true, forceFull: false,
    }));
    expect(await screen.findByText("没有新更新")).toBeTruthy();
  });

  it("同步记录加载中或失败均阻止导出，刷新恢复后才能导出", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.internalState>>>();
    const state = vi.spyOn(api, "internalState").mockReturnValueOnce(pending.promise);
    const exported = vi.spyOn(api, "exportOut");
    render(view());
    const exportButton = await screen.findByRole<HTMLButtonElement>("button", { name: "导出更新" });
    expect(exportButton.disabled).toBe(true);
    fireEvent.click(exportButton);
    expect(exported).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ repoId: "project-id", outSeq: 4, lastHeads: [], lastExportAt: null }));
    await waitFor(() => expect(exportButton.disabled).toBe(false));
    state.mockRejectedValueOnce(new Error("state disk unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    const error = await screen.findByText(/无法读取同步记录，请检查后重试/);
    expect(error.textContent).toContain("Error: state disk unavailable");
    expect(error.closest(".operation-popups")).toBeTruthy();
    expect(exportButton.disabled).toBe(true);
    fireEvent.click(exportButton);
    expect(exported).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(exportButton.disabled).toBe(false));
    expect(screen.queryByText(/Error: state disk unavailable/)).toBeNull();
    fireEvent.click(exportButton);
    await waitFor(() => expect(exported).toHaveBeenCalledTimes(1));
  });

  it("传输目录读取失败显示错误而非误报没有待处理回传", async () => {
    vi.spyOn(api, "listReturnPackages").mockRejectedValue(new Error("USB unavailable"));
    vi.spyOn(api, "repoStatus").mockImplementation(async (path) => ({ ...status(path), branches: [] }));
    render(view());
    openReturns();
    const error = await screen.findByText(/无法读取传输目录，请检查连接后刷新/);
    expect(error.textContent).toContain("Error: USB unavailable");
    expect(error.closest(".operation-popups")).toBeTruthy();
    expect(screen.queryByText("没有待处理的回传。")).toBeNull();
  });

  it("importReturn 一键导入并整理，在当前仓库使用专用审阅分支继续检查", async () => {
    let received = false;
    const local = "review/receipt-one/feature/returned";
    vi.spyOn(api, "listReturnPackages").mockImplementation(async () => [returnPackage(received)]);
    vi.spyOn(api, "repoStatus").mockImplementation(async (path) => {
      const value = status(path);
      if (received && path === "/work") {
        value.branches = [{ ...value.branches[0], name: local, worktree: null }];
        value.reviewSources = { [local]: "feature/returned" };
      }
      return value;
    });
    const imported = vi.spyOn(api, "importReturn");
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "import_return") return original(command, args);
      received = true;
      return { branches: [{ source: "feature/returned", local, sha: "returned-oid", base: "main", commits: [] }],
        warnings: [], outcomes: [success] };
    });
    render(view());
    openReturns();
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "导入回传" });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(imported).toHaveBeenCalledExactlyOnceWith("/work", "/usb/back.bundle", "main", ["release/1.0"]));
    expect(invoke).toHaveBeenCalledWith("import_return", { workDir: "/work", bundle: "/usb/back.bundle", baseBranch: "main", releaseBranches: ["release/1.0"] });
    expect(await screen.findByText("整理已完成，可以检查并推送。")).toBeTruthy();
    const selected = await screen.findByRole<HTMLInputElement>("radio", { name: "选择 feature/returned" });
    expect(selected.checked).toBe(true);
    expect(within(selected.closest(".sync-branch-row") as HTMLElement).getByRole("button", { name: "检查并推送" })).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.some(([command]) => ["import_back", "rebase_onto", "execute_push"].includes(command))).toBe(false);
    fireEvent.click(within(selected.closest(".sync-branch-row") as HTMLElement).getByRole("button", { name: "检查并推送" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("prepare_push", { workDir: "/work", branch: local, forceWithLease: false });
  });

  it("补丁只传分支和基准，在已配置的工作仓库导入", async () => {
    const pkg = returnPackage();
    pkg.payloadPath = "/usb/patches";
    pkg.manifest = { ...pkg.manifest!, kind: "patch", payload: "patches" };
    vi.spyOn(api, "listReturnPackages").mockResolvedValue([pkg]);
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => command === "import_patches" ? success : original(command, args));
    render(view());
    openReturns();
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "导入回传" });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "补丁选项" }));
    expect(screen.queryByRole("textbox", { name: "独立工作树目录" })).toBeNull();
    expect(screen.getByText("补丁会在当前工作仓库切换到所填分支并应用，请保持工作区干净。")).toBeTruthy();
    const branch = screen.getByRole("textbox", { name: "应用到的新分支" });
    fireEvent.change(branch, { target: { value: "   " } });
    fireEvent.click(button);
    expect(await screen.findByText("请在补丁选项中填写分支")).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "import_patches")).toBe(false);
    fireEvent.change(branch, { target: { value: " hotfix/patch " } });
    fireEvent.click(screen.getByRole("button", { name: /基准分支/ }));
    fireEvent.click(await screen.findByRole("option", { name: /release\/1.0/ }));
    fireEvent.click(button);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "import_patches")).toEqual([
      ["import_patches", { workDir: "/work", patchDir: "/usb/patches", branch: "hotfix/patch", baseBranch: "release/1.0", fetchUpstream: true }],
    ]));
  });

  it("已接收包默认不占列表，可切换查看并继续整理", async () => {
    vi.spyOn(api, "listReturnPackages").mockResolvedValue([returnPackage(true)]);
    render(view());
    openReturns();
    const management = screen.getByRole("button", { name: "其他回传与分支管理", exact: true });
    expect(management.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("tab", { name: "导入回传" }).textContent).toBe("导入回传");
    expect(await screen.findByText("没有待接收的包。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "继续整理" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看已接收的包" }));
    expect(await screen.findByRole("listbox", { name: "回传包列表" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "继续整理" })).toBeTruthy();
    expect(management.getAttribute("aria-expanded")).toBe("false");
  });

  it("已核实推送的当前提交不会再次列为待推送事项", async () => {
    vi.spyOn(api, "listReturnPackages").mockResolvedValue([]);
    vi.spyOn(api, "repoStatus").mockImplementation(async (path) => {
      const value = status(path);
      return { ...value, pushedBranches: value.branches.map((branch) => branch.name) };
    });
    render(view());
    openReturns();
    expect(await screen.findByText("没有待处理的回传。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "检查并推送" })).toBeNull();
  });

  it.each(["missing", "foreign"])("选中的 %s 包不能导入，换到有效包才允许操作", async (problem) => {
    const valid = { ...returnPackage(), payloadPath: "/usb/valid.bundle" };
    const blocked = { ...returnPackage(), payloadPath: "/usb/blocked.bundle", payloadExists: problem !== "missing",
      manifest: { ...returnPackage().manifest!, seq: 4, repoId: problem === "foreign" ? "other-project" : "project-id" } };
    vi.spyOn(api, "listReturnPackages").mockResolvedValue([valid, blocked]);
    const imported = vi.spyOn(api, "importReturn").mockResolvedValue({ branches: [], outcomes: [], warnings: [] });
    render(view());
    openReturns();
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "导入回传" });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(problem === "missing" ? "包文件缺失，请重新复制。" : "包属于其他项目。")).toBeTruthy();
    fireEvent.click(button);
    expect(imported).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: /valid.bundle/ }));
    const validButton = screen.getByRole<HTMLButtonElement>("button", { name: "导入回传" });
    await waitFor(() => expect(validButton.disabled).toBe(false));
    fireEvent.click(validButton);
    await waitFor(() => expect(imported).toHaveBeenCalledExactlyOnceWith("/work", "/usb/valid.bundle", "main", ["release/1.0"]));
  });

  it("空仓库没有可推送分支，缺失工作仓库时不能接收回传", async () => {
    vi.spyOn(api, "repoStatus").mockImplementation(async (path) => ({ ...status(path), branches: [] }));
    const packages = vi.spyOn(api, "listReturnPackages").mockResolvedValue([]);
    const repo = vi.mocked(api.repoStatus);
    render(view());
    openReturns();
    expect(await screen.findByText("没有待处理的回传。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "检查并推送" })).toBeNull();
    packages.mockResolvedValue([returnPackage()]);
    repo.mockImplementation(async (path) => ({ ...status(path), branches: [], isRepo: path === "/mirror", exists: path === "/mirror" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "导入回传" });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "import_return")).toBe(false);
    expect(screen.getByText("请先在项目设置中填写已克隆的内网工作仓库。")).toBeTruthy();
  });
});

describe("后端冻结推送计划", () => {
  it("没有独立工作树也请求后端准备推送，未就绪时不进入确认", async () => {
    const local = "review/receipt-one/feature/returned";
    vi.spyOn(api, "repoStatus").mockImplementation(async (path) => ({
      ...status(path), branches: [{ ...status(path).branches[0], name: local, worktree: null }],
    }));
    const prepared = vi.spyOn(api, "preparePush").mockRejectedValue(new Error("审查分支尚未就绪"));
    const execute = vi.spyOn(api, "executePush");
    render(view());
    openReturns();
    fireEvent.click(await screen.findByRole("button", { name: "检查并推送" }));
    await waitFor(() => expect(prepared).toHaveBeenCalledExactlyOnceWith("/work", local, false));
    expect(await screen.findByText(/审查分支尚未就绪/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("确认框展示计划中的目标、提交和 OID，确认后仅 executePush(planId)", async () => {
    render(view());
    openReturns();
    fireEvent.click(await screen.findByRole("button", { name: "检查并推送" }));
    const dialog = await screen.findByRole("alertdialog", { name: "推送 feature/remote-target" });
    expect(invoke).toHaveBeenCalledWith("prepare_push", { workDir: "/work", branch: "feature/one", forceWithLease: false });
    expect(within(dialog).getByText("ssh://git/frozen-project · feature/remote-target")).toBeTruthy();
    expect(within(dialog).getByText("后端冻结提交")).toBeTruthy();
    expect(within(dialog).queryByText("前端预览提交")).toBeNull();
    for (const oid of ["frozen-source-oid", "frozen-remote-oid", "frozen-base-oid"]) expect(within(dialog).getByText(oid)).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "execute_push")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "确认推送" }));
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "execute_push")).toEqual([
      ["execute_push", { planId: "frozen-plan-id" }],
    ]));
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "push_branch")).toBe(false);
  });

  it("取消确认不会执行推送", async () => {
    const execute = vi.spyOn(api, "executePush");
    render(view());
    openReturns();
    fireEvent.click(await screen.findByRole("button", { name: "检查并推送" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("后端冻结提交")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { id: "other-profile" }, { workDir: "/other-work" }, { transferDir: "/other-usb" },
  ])("配置变化 %j 后迟到的旧计划不能打开确认或推送", async (change) => {
    const pending = deferred<PushPlan>();
    const prepared = vi.spyOn(api, "preparePush").mockReturnValueOnce(pending.promise);
    const execute = vi.spyOn(api, "executePush");
    const { rerender } = render(view());
    openReturns();
    fireEvent.click(await screen.findByRole("button", { name: "检查并推送" }));
    await waitFor(() => expect(prepared).toHaveBeenCalledTimes(1));
    rerender(view({ ...profile, ...change }));
    await act(async () => pending.resolve(frozenPlan()));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    // 新配置仍可重新准备计划并显示确认，旧请求不会永久锁住操作。
    fireEvent.click(await screen.findByRole("button", { name: "检查并推送" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(prepared).toHaveBeenLastCalledWith(change.workDir ?? "/work", "feature/one", false);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(execute).not.toHaveBeenCalled();
  });
});

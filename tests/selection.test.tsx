import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type BranchInfo, type Profile, type RepoStatus } from "../src/api";
import { BranchTable } from "../src/repoBits";
import { ExternalView } from "../src/ExternalView";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }),
}));
vi.mock("../src/runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/runner")>(),
  Feedback: () => null,
  OperationStatus: () => null,
  useRunner: () => ({ busy: null, notify: vi.fn(), run: async (_: string, fn: () => unknown) => fn() }),
}));

beforeEach(() => {
  vi.spyOn(api, "devSyncStatus").mockImplementation(async (_mirror, paths) => paths.map((path) => ({ path, status: "upToDate", error: null })));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function branch(name: string): BranchInfo {
  return { name, sha: "abcdef123", base: "main", baseInferred: false, ahead: 1, behind: 0, current: false, worktree: null };
}
const branches = [branch("feature/one"), branch("feature/two")];

describe("分支选择", () => {
  it("行内 Rebase 独立于回传选择，支持取消并选择发布分支执行", async () => {
    const profile: Profile = {
      id: "test", name: "test", role: "external", repoName: "test", baseBranch: "main",
      releaseBranches: ["release/1.0"], transferDir: "/transfer", mirrorDir: "/mirror", devRepos: ["/dev"],
    };
    const available = [branches[0], { ...branches[1], base: "release/1.0" }];
    vi.spyOn(api, "repoStatus").mockImplementation(async (path) => ({
      path, exists: true, isRepo: true, isBare: path === "/mirror", isMirror: path === "/mirror",
      currentBranch: "main", worktrees: [], dirtyTrees: [], inProgress: null,
      inProgressTrees: [], branches: available, remoteUrl: null,
    } satisfies RepoStatus));
    vi.spyOn(api, "mirrorState").mockResolvedValue({ repoId: "matching", lastInSeq: 1, backSeq: 0, lastImportAt: null });
    vi.spyOn(api, "listPackages").mockResolvedValue([]);
    const rebase = vi.spyOn(api, "rebaseOnto").mockResolvedValue({
      ok: true, conflict: false, files: [], message: "变基完成", worktree: null,
    });
    render(<ExternalView profile={profile} />);
    const first = await screen.findByRole("row", { name: "feature/one" });
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "Rebase feature/two" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "Rebase 到 origin/release/1.0" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(rebase).not.toHaveBeenCalled();
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect((within(screen.getByRole("row", { name: "feature/two" })).getByRole("checkbox") as HTMLInputElement).getAttribute("aria-checked")).toBe("false");

    fireEvent.click(first);
    fireEvent.click(screen.getByRole("row", { name: "feature/two" }));
    fireEvent.click(screen.getByRole("button", { name: "Rebase feature/one" }));
    dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("feature/one")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Rebase 到 origin/main" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Rebase 到", expanded: false }));
    fireEvent.click(await screen.findByRole("option", { name: /release\/1.0/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Rebase 到 origin/release/1.0" }));
    await waitFor(() => expect(rebase).toHaveBeenCalledWith("/dev", "feature/one", "release/1.0", false));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect((within(screen.getByRole("row", { name: "feature/two" })).getByRole("checkbox") as HTMLInputElement).getAttribute("aria-checked")).toBe("true");
    expect((within(screen.getByRole("row", { name: "feature/one" })).getByRole("checkbox") as HTMLInputElement).getAttribute("aria-checked")).toBe("false");
  });

  it("表头支持全选和取消全选", async () => {
    function Table() {
      const [selected, setSelected] = useState<string[]>([]);
      return <BranchTable branches={branches} selected={selected} onSelect={setSelected} multi />;
    }
    render(<Table />);
    const all = await screen.findByRole("checkbox", { name: "全选" });
    fireEvent.click(all);
    expect((within(screen.getByRole("row", { name: "feature/one" })).getByRole("checkbox") as HTMLInputElement).getAttribute("aria-checked")).toBe("true");
    expect((within(screen.getByRole("row", { name: "feature/two" })).getByRole("checkbox") as HTMLInputElement).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(all);
    expect((within(screen.getByRole("row", { name: "feature/one" })).getByRole("checkbox") as HTMLInputElement).getAttribute("aria-checked")).toBe("false");
    expect((within(screen.getByRole("row", { name: "feature/two" })).getByRole("checkbox") as HTMLInputElement).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(within(screen.getByRole("row", { name: "feature/one" })).getByRole("checkbox"));
    expect((all as HTMLInputElement).getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(all);
    expect((all as HTMLInputElement).getAttribute("aria-checked")).toBe("true");
    expect((all as HTMLInputElement).getAttribute("aria-checked")).not.toBe("mixed");
  });

  it("Shift 点击按过滤后的可见分支扩展和收缩范围，保留搜索外选择", () => {
    const available = [branch("feature/one"), branch("other/hidden"), branch("feature/two"), branch("feature/three")];
    function Table() {
      const [selected, setSelected] = useState<string[]>(["other/hidden"]);
      return <><BranchTable branches={available} selected={selected} onSelect={setSelected} multi />
        <output data-testid="selection">{JSON.stringify(selected)}</output></>;
    }
    render(<Table />);
    const selection = () => JSON.parse(screen.getByTestId("selection").textContent!) as string[];
    fireEvent.change(screen.getByRole("textbox", { name: "查找分支" }), { target: { value: "feature/" } });
    fireEvent.click(screen.getByRole("row", { name: "feature/one" }));
    fireEvent.click(screen.getByRole("row", { name: "feature/three" }), { shiftKey: true });
    expect(selection()).toEqual(["other/hidden", "feature/one", "feature/two", "feature/three"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 feature/two" }), { shiftKey: true });
    expect(selection()).toEqual(["other/hidden", "feature/one", "feature/two"]);
    // 普通点击仍切换单项；行内操作即使按住 Shift 也不扩展范围。
    fireEvent.click(screen.getByRole("row", { name: "feature/two" }));
    fireEvent.click(screen.getByRole("button", { name: "复制分支名 feature/three" }), { shiftKey: true });
    expect(selection()).toEqual(["other/hidden", "feature/one"]);
  });

  it("Shift 方向键和 Home/End 围绕锚点选择，单选和 disabled 不扩展", () => {
    const available = [branch("feature/one"), branch("feature/two"), branch("feature/three")];
    function Table({ multi = true, disabled = false }: { multi?: boolean; disabled?: boolean }) {
      const [selected, setSelected] = useState<string[]>([]);
      return <BranchTable branches={available} selected={selected} onSelect={setSelected} multi={multi} isSelectionDisabled={disabled} />;
    }
    const { rerender } = render(<Table />);
    const row = (name: string) => screen.getByRole("row", { name: `feature/${name}` });
    const selectedNames = () => available.filter((b) => screen.getByRole("row", { name: b.name }).getAttribute("aria-selected") === "true").map((b) => b.name);
    fireEvent.click(row("two"));
    row("two").focus();
    fireEvent.keyDown(row("two"), { key: "ArrowDown", shiftKey: true });
    expect(document.activeElement).toBe(row("three"));
    expect(selectedNames()).toEqual(["feature/two", "feature/three"]);
    fireEvent.keyDown(row("three"), { key: "Home", shiftKey: true });
    expect(document.activeElement).toBe(row("one"));
    expect(selectedNames()).toEqual(["feature/one", "feature/two"]);
    fireEvent.keyDown(row("one"), { key: "End", shiftKey: true });
    expect(document.activeElement).toBe(row("three"));
    expect(selectedNames()).toEqual(["feature/two", "feature/three"]);
    fireEvent.keyDown(row("three"), { key: "ArrowUp", shiftKey: true });
    expect(document.activeElement).toBe(row("two"));
    expect(selectedNames()).toEqual(["feature/two"]);

    rerender(<Table disabled />);
    fireEvent.keyDown(row("two"), { key: "Home", shiftKey: true });
    fireEvent.click(row("one"), { shiftKey: true });
    expect(selectedNames()).toEqual(["feature/two"]);
    rerender(<Table multi={false} />);
    fireEvent.keyDown(row("two"), { key: "End", shiftKey: true });
    expect(selectedNames()).toEqual(["feature/two"]);
    fireEvent.click(row("one"), { shiftKey: true });
    expect(selectedNames()).toEqual(["feature/one"]);
  });

  it("禁止选择时全选无效，单选模式不显示全选框", async () => {
    function Table({ multi }: { multi: boolean }) {
      const [selected, setSelected] = useState<string[]>([]);
      return <BranchTable branches={branches} selected={selected} onSelect={setSelected} multi={multi}
        isSelectionDisabled />;
    }
    const { rerender } = render(<Table multi />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "全选" }));
    expect(screen.getByRole("row", { name: "feature/one" }).getAttribute("aria-selected")).not.toBe("true");
    expect(screen.getByRole("row", { name: "feature/two" }).getAttribute("aria-selected")).not.toBe("true");
    rerender(<Table multi={false} />);
    expect(screen.queryByRole("checkbox", { name: "全选" })).toBeNull();
  });

  it("刷新删除已选分支后，回传只保留仍存在的分支，删空后禁止导出", async () => {
    const profile: Profile = {
      id: "test", name: "test", role: "external", repoName: "test", baseBranch: "main",
      transferDir: "/transfer", mirrorDir: "/mirror", devRepos: ["/dev", "/dev-two"],
    };
    let available = branches;
    vi.spyOn(api, "repoStatus").mockImplementation(async (path) => ({
      path, exists: true, isRepo: true, isBare: path === "/mirror", isMirror: path === "/mirror",
      currentBranch: "main", worktrees: [], dirtyTrees: [], inProgress: null,
      inProgressTrees: [], branches: available, remoteUrl: null,
    } satisfies RepoStatus));
    vi.spyOn(api, "mirrorState").mockResolvedValue({ repoId: "matching", lastInSeq: 1, backSeq: 0, lastImportAt: null });
    vi.spyOn(api, "listPackages").mockResolvedValue([]);
    const exported = vi.spyOn(api, "exportBack").mockResolvedValue({ status: "nothingToSync", message: "没有新提交" });
    render(<ExternalView profile={profile} />);
    fireEvent.click(screen.getByRole("tab", { name: "同步与回传" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /^选择 feature\/one/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^选择 feature\/two/ }));
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /^选择 feature\/two/ }).getAttribute("aria-checked")).toBe("true");

    available = [branches[1]];
    fireEvent.click(screen.getByRole("button", { name: "刷新分支" }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: /^选择 feature\/one/ })).toBeNull());
    expect((screen.getByRole("checkbox", { name: /^选择 feature\/two/ }) as HTMLInputElement).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "导出回传" }));
    await waitFor(() => expect(exported).toHaveBeenCalledWith(expect.objectContaining({ branches: ["feature/two"] })));

    available = [];
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "刷新分支" }).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "刷新分支" }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: /^选择 feature\/two/ })).toBeNull());
    expect(screen.queryByRole("checkbox", { name: /^选择 feature\/two/ })).toBeNull();
    expect(screen.getByText("还没有可回传的开发分支。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "导出回传" }) as HTMLButtonElement).disabled).toBe(true);

    // 仓库切换后即使存在同名分支，也不沿用前一个仓库的选择。
    available = branches;
    fireEvent.click(screen.getByRole("button", { name: "刷新分支" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /^选择 feature\/one/ }));
    expect((screen.getByRole("checkbox", { name: /^选择 feature\/one/ }) as HTMLInputElement).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "同步与回传" }));

    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    await waitFor(() => expect(api.repoStatus).toHaveBeenCalledWith("/dev-two", "main", []));
    fireEvent.click(screen.getByRole("tab", { name: "同步与回传" }));
    expect((await screen.findByRole("checkbox", { name: /^选择 feature\/one/ }) as HTMLInputElement).getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("button", { name: "导出回传" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

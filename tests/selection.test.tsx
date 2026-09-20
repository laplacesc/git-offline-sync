import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type BranchInfo, type Profile, type RepoStatus } from "../src/api";
import { BranchTable } from "../src/repoBits";
import { ExternalView } from "../src/ExternalView";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }),
}));
vi.mock("../src/runner", () => ({
  useRunner: () => ({ busy: null, notify: vi.fn(), run: async (_: string, fn: () => unknown) => fn() }),
}));

beforeEach(() => {
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
    vi.spyOn(api, "mirrorState").mockResolvedValue({ lastInSeq: 0 } as Awaited<ReturnType<typeof api.mirrorState>>);
    vi.spyOn(api, "listPackages").mockResolvedValue([]);
    const rebase = vi.spyOn(api, "rebaseOnto").mockResolvedValue({
      ok: true, conflict: false, files: [], message: "变基完成", worktree: null,
    });
    render(<ExternalView profile={profile} />);
    fireEvent.click(await screen.findByRole("button", { name: "Rebase feature/two", exact: true }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "Rebase 到 origin/release/1.0" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(rebase).not.toHaveBeenCalled();
    expect(screen.queryByText(/^已选：/)).toBeNull();

    fireEvent.click(screen.getByRole("row", { name: "feature/two", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Rebase feature/one", exact: true }));
    dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("feature/one")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Rebase 到 origin/main" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /main/, expanded: false }));
    fireEvent.click(await screen.findByRole("option", { name: /release\/1.0/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Rebase 到 origin/release/1.0" }));
    await waitFor(() => expect(rebase).toHaveBeenCalledWith("/dev", "feature/one", "release/1.0", false));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText("已选：feature/two")).toBeTruthy();
  });

  it("表头支持全选和取消全选", async () => {
    function Table() {
      const [selected, setSelected] = useState<string[]>([]);
      return <BranchTable branches={branches} selected={selected} onSelect={setSelected} multi />;
    }
    render(<Table />);
    const all = await screen.findByRole("checkbox", { name: "全选" });
    fireEvent.click(all);
    expect((within(screen.getByRole("row", { name: "feature/one" })).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect((within(screen.getByRole("row", { name: "feature/two" })).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(all);
    expect((within(screen.getByRole("row", { name: "feature/one" })).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect((within(screen.getByRole("row", { name: "feature/two" })).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(screen.getByRole("row", { name: "feature/one" })).getByRole("checkbox"));
    expect((all as HTMLInputElement).indeterminate).toBe(true);
    fireEvent.click(all);
    expect((all as HTMLInputElement).checked).toBe(true);
    expect((all as HTMLInputElement).indeterminate).toBe(false);
  });

  it("全选跳过禁用分支，单选模式不显示全选框", async () => {
    function Table({ multi }: { multi: boolean }) {
      const [selected, setSelected] = useState<string[]>([]);
      return <BranchTable branches={branches} selected={selected} onSelect={setSelected} multi={multi}
        isSelectable={(b) => b.name !== "feature/two"} />;
    }
    const { rerender } = render(<Table multi />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "全选" }));
    expect(screen.getByRole("row", { name: "feature/one" }).getAttribute("aria-selected")).toBe("true");
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
    vi.spyOn(api, "mirrorState").mockResolvedValue({ lastInSeq: 0 } as Awaited<ReturnType<typeof api.mirrorState>>);
    vi.spyOn(api, "listPackages").mockResolvedValue([]);
    const exported = vi.spyOn(api, "exportBack").mockResolvedValue({ status: "nothingToSync", message: "没有新提交" });
    render(<ExternalView profile={profile} />);
    fireEvent.click(await screen.findByRole("row", { name: /feature\/one/ }));
    fireEvent.click(screen.getByRole("row", { name: /feature\/two/ }));
    expect(screen.getByText("已选：feature/one、feature/two")).toBeTruthy();

    available = [branches[1]];
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await waitFor(() => expect(screen.queryByRole("row", { name: /feature\/one/ })).toBeNull());
    expect(screen.queryByText("已选：feature/two")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "导出到 U 盘 →" }));
    await waitFor(() => expect(exported).toHaveBeenCalledWith(expect.objectContaining({ branches: ["feature/two"] })));

    available = [];
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await waitFor(() => expect(screen.queryByRole("row", { name: /feature\/two/ })).toBeNull());
    expect(screen.queryByText("已选：feature/two")).toBeNull();
    expect((screen.getByRole("button", { name: "导出到 U 盘 →" }) as HTMLButtonElement).disabled).toBe(true);

    // 仓库切换后即使存在同名分支，也不沿用前一个仓库的选择。
    available = branches;
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    fireEvent.click(await screen.findByRole("row", { name: "feature/one" }));
    expect(screen.getByText("已选：feature/one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "切换", exact: true }));
    await waitFor(() => expect(screen.queryByText("已选：feature/one")).toBeNull());
    expect((screen.getByRole("button", { name: "导出到 U 盘 →" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

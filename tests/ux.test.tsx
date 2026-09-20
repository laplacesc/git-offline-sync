import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProfileEditor, blankProfile } from "../src/ProfileEditor";
import { BranchTable } from "../src/repoBits";
import { RefreshButton } from "../src/ui";
import { OperationStatus, RunnerProvider, useRunner } from "../src/runner";
import { LogPanel } from "../src/LogPanel";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("配置表单提交后显示字段错误，错误链接定位到输入框", async () => {
  const save = vi.fn();
  render(<ProfileEditor initial={blankProfile("external", "test")} isNew onSave={save} onCancel={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
  const summary = await screen.findByRole("alert");
  await waitFor(() => expect(document.activeElement).toBe(summary));
  fireEvent.click(screen.getByRole("link", { name: "名称", exact: true }));
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "名称", exact: true }));
  expect(screen.getByRole("textbox", { name: "名称", exact: true }).getAttribute("aria-invalid")).toBe("true");
  expect(save).not.toHaveBeenCalled();
});

it("保存失败后保留配置内容并允许重试", async () => {
  const profile = { ...blankProfile("external", "test"), name: "项目", repoName: "project", transferDir: "/usb", mirrorDir: "/mirror" };
  const save = vi.fn().mockResolvedValue(false);
  render(<ProfileEditor initial={profile} isNew onSave={save} onCancel={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "名称", exact: true }) as HTMLInputElement).value).toBe("项目");
  expect((screen.getByRole("button", { name: "保存", exact: true }) as HTMLButtonElement).disabled).toBe(false);
});

it("取消编辑前保护未保存内容", async () => {
  const cancel = vi.fn();
  render(<ProfileEditor initial={blankProfile("external", "test")} isNew onSave={() => {}} onCancel={cancel} />);
  fireEvent.change(screen.getByRole("textbox", { name: "名称", exact: true }), { target: { value: "未保存项目" } });
  fireEvent.click(screen.getByRole("button", { name: "取消", exact: true }));
  expect(await screen.findByRole("alertdialog")).toBeTruthy();
  expect(cancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((screen.getByRole("textbox", { name: "名称", exact: true }) as HTMLInputElement).value).toBe("未保存项目");
});

it("搜索内全选与取消全选保留搜索外的选择，清空选择覆盖全部", () => {
  function Harness() {
    const [selected, setSelected] = useState(["feature/one"]);
    const branches = ["feature/one", "feature/two"].map((name) => ({ name, sha: "123456", base: "main", baseInferred: false, ahead: 0, behind: 0, current: false, worktree: null }));
    return <RunnerProvider><BranchTable branches={branches} selected={selected} onSelect={setSelected} multi /><output>{selected.join(",")}</output></RunnerProvider>;
  }
  render(<Harness />);
  fireEvent.change(screen.getByRole("textbox", { name: "查找分支" }), { target: { value: "two" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "全选" }));
  expect(screen.getByText("feature/one,feature/two")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "全选" }));
  expect(screen.getByText("feature/one", { selector: "output" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "清空选择" }));
  expect(document.querySelector("output")?.textContent).toBe("");
});

it("刷新期间展示进度并拦截重复点击", async () => {
  let finish!: () => void;
  const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<RunnerProvider><RefreshButton onPress={refresh} /></RunnerProvider>);
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  const pending = screen.getByRole("button", { name: /刷新中/ });
  expect((pending as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(pending);
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
});

it("日志允许暂停和恢复跟随", () => {
  render(<LogPanel lines={[]} clear={() => {}} open setOpen={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "暂停跟随" }));
  expect(screen.getByRole("button", { name: "跟随最新" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "跟随最新" }));
  expect(screen.getByRole("button", { name: "暂停跟随" }).getAttribute("aria-pressed")).toBe("true");
});

it("操作失败后保留可关闭的错误提示", async () => {
  function Harness() {
    const { run } = useRunner();
    return <><button onClick={() => run("导出", async () => { throw new Error("传输目录不可写"); })}>执行</button><OperationStatus /></>;
  }
  render(<RunnerProvider><Harness /></RunnerProvider>);
  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  expect((await screen.findByRole("alert")).textContent).toContain("传输目录不可写");
  fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

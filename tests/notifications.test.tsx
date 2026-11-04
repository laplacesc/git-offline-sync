import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Button } from "../src/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../src/components/ui/dialog";
import { Feedback, OperationStatus, RunnerProvider, useRunner } from "../src/runner";
import { OutcomeView } from "../src/ui";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function Harness() {
  const { notify, run } = useRunner();
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => notify("ok", "分支已复制")}>成功反馈</button>
    <button onClick={() => notify("warn", "请接回原回传包")}>警告反馈</button>
    <button onClick={() => run("同步", async () => { throw new Error("镜像不可写"); })}>失败反馈</button>
    <Button onClick={() => setOpen(true)}>打开编辑器</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined} topLayer={<OperationStatus inline />}>
        <DialogTitle>编辑器</DialogTitle>
        <Button onClick={() => notify("error", "保存配置失败")}>保存</Button>
      </DialogContent>
    </Dialog>
    <OperationStatus />
  </>;
}

it("读取状态在所属区块内持续展示，状态更新后替换，恢复后移除", () => {
  const view = (text: string | null) => <RunnerProvider>
    <section aria-label="仓库状态">{text && <Feedback kind="error" text={text} />}</section><OperationStatus />
  </RunnerProvider>;
  const { rerender } = render(view("同步记录不可读"));
  expect(within(screen.getByRole("region", { name: "仓库状态" })).getByRole("alert").textContent).toContain("同步记录不可读");
  expect(screen.queryByRole("region", { name: "操作提示" })).toBeNull();
  rerender(view("同步记录不可读"));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "关闭错误提示" })).toBeNull();
  rerender(view("传输目录不可读"));
  expect(screen.getByRole("alert").textContent).toContain("传输目录不可读");
  expect(screen.queryByText("同步记录不可读")).toBeNull();
  rerender(view(null));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("冲突状态及文件明细在所属页面展示，不产生额外通知", () => {
  const outcome = { ok: false, conflict: true, message: "整理提交出现冲突", files: ["src/main.ts"], worktree: "/review" };
  const { container } = render(<RunnerProvider><Feedback kind="warn" text={outcome.message} />
    <OutcomeView outcome={outcome} /><OperationStatus /></RunnerProvider>);
  expect(screen.getAllByText(outcome.message)).toHaveLength(1);
  expect(screen.queryByRole("region", { name: "操作提示" })).toBeNull();
  expect(container.textContent).toContain("src/main.ts");
  expect(container.textContent).toContain(outcome.message);
});

it("操作失败只显示一条横幅，新通知不会覆盖错误，重复通知不堆叠", async () => {
  render(<RunnerProvider><Harness /></RunnerProvider>);
  fireEvent.click(screen.getByRole("button", { name: "失败反馈" }));
  expect((await screen.findByRole("alert")).textContent).toContain("同步失败：Error: 镜像不可写");
  expect(screen.getAllByText("同步失败：Error: 镜像不可写")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "成功反馈" }));
  fireEvent.click(screen.getByRole("button", { name: "成功反馈" }));
  fireEvent.click(screen.getByRole("button", { name: "警告反馈" }));
  const notices = within(screen.getByRole("region", { name: "操作提示" }));
  expect(notices.getAllByRole("status")).toHaveLength(1);
  expect(notices.getAllByRole("alert")).toHaveLength(2);
  expect(notices.getByText("分支已复制")).toBeTruthy();
  fireEvent.click(notices.getByRole("button", { name: "关闭错误提示" }));
  expect(notices.queryByText("同步失败：Error: 镜像不可写")).toBeNull();
  expect(notices.getByText("请接回原回传包")).toBeTruthy();
  for (const button of notices.getAllByRole("button", { name: "关闭提示", exact: true })) fireEvent.click(button);
  expect(screen.queryByRole("region", { name: "操作提示" })).toBeNull();
});

it("成功弹窗五秒后收起，悬停时暂停，警告保留到手动关闭", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { container } = render(<RunnerProvider><Harness /></RunnerProvider>);
  fireEvent.click(screen.getByRole("button", { name: "成功反馈" }));
  const popup = screen.getByText("分支已复制").closest(".operation-popup")!;
  expect(container.querySelector(".operation-popups")).toBeNull();
  act(() => vi.advanceTimersByTime(4999));
  expect(screen.getByText("分支已复制")).toBeTruthy();
  fireEvent.mouseEnter(popup);
  act(() => vi.advanceTimersByTime(10000));
  expect(screen.getByText("分支已复制")).toBeTruthy();
  fireEvent.mouseLeave(popup);
  act(() => vi.advanceTimersByTime(5000));
  expect(screen.queryByText("分支已复制")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "警告反馈" }));
  act(() => vi.advanceTimersByTime(20000));
  expect(screen.getByRole("alert").textContent).toContain("请接回原回传包");
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(screen.queryByRole("region", { name: "操作提示" })).toBeNull();
});

it("弹窗打开后新增的横幅可被读屏器访问和键盘关闭，不关闭编辑器", async () => {
  render(<RunnerProvider><Harness /></RunnerProvider>);
  fireEvent.click(screen.getByRole("button", { name: "打开编辑器" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑器" });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  const region = await screen.findByRole("region", { name: "操作提示" });
  expect(within(region).getByRole("alert").textContent).toContain("保存配置失败");
  expect(dialog.contains(region)).toBe(true);
  const dismiss = within(region).getByRole("button", { name: "关闭错误提示" });
  act(() => dismiss.focus());
  expect(document.activeElement).toBe(dismiss);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("region", { name: "操作提示" })).toBeNull());
  expect(screen.getByRole("dialog", { name: "编辑器" })).toBeTruthy();
});

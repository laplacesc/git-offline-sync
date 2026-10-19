import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Button, Modal } from "@heroui/react";
import { Feedback, FeedbackScope, OperationStatus, RunnerProvider, useRunner } from "../src/runner";
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
    <Button onPress={() => setOpen(true)}>打开编辑器</Button>
    <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
      <Modal.Container><Modal.Dialog aria-label="编辑器">
        <Button onPress={() => notify("error", "保存配置失败")}>保存</Button>
      </Modal.Dialog></Modal.Container>
    </Modal.Backdrop>
    <OperationStatus />
  </>;
}

it("读取反馈只弹出一次，关闭后不会因重渲染复现，问题消失时自动清理", () => {
  const view = (text: string | null) => <RunnerProvider>
    {text && <Feedback kind="error" text={text} />}<OperationStatus />
  </RunnerProvider>;
  const { container, rerender } = render(view("同步记录不可读"));
  expect(container.textContent).toBe("");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  rerender(view("同步记录不可读"));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
  rerender(view("同步记录不可读"));
  expect(screen.queryByRole("alert")).toBeNull();
  rerender(view("传输目录不可读"));
  expect(screen.getByRole("alert").textContent).toContain("传输目录不可读");
  rerender(view(null));
  expect(screen.queryByRole("region", { name: "操作提示" })).toBeNull();
});

it("隐藏页签的迟到错误保持静默，返回时只展示最新状态", () => {
  const view = (active: boolean, text: string) => <RunnerProvider>
    <FeedbackScope value={active}><Feedback kind="error" text={text} /></FeedbackScope>
    <OperationStatus />
  </RunnerProvider>;
  const { rerender } = render(view(true, "旧读取错误"));
  expect(screen.getByRole("alert").textContent).toContain("旧读取错误");
  rerender(view(false, "旧读取错误"));
  expect(screen.queryByRole("alert")).toBeNull();
  rerender(view(false, "迟到的读取错误"));
  expect(screen.queryByRole("alert")).toBeNull();
  rerender(view(true, "迟到的读取错误"));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).toContain("迟到的读取错误");
  expect(screen.queryByText("旧读取错误")).toBeNull();
});

it("冲突结果只在横幅提示一次，文件明细留在页面", () => {
  const outcome = { ok: false, conflict: true, message: "整理提交出现冲突", files: ["src/main.ts"], worktree: "/review" };
  const { container } = render(<RunnerProvider><Feedback kind="warn" text={outcome.message} />
    <OutcomeView outcome={outcome} /><OperationStatus /></RunnerProvider>);
  expect(screen.getAllByText(outcome.message)).toHaveLength(1);
  expect(screen.getByText(outcome.message).closest(".operation-popups")).toBeTruthy();
  expect(container.textContent).toContain("src/main.ts");
  expect(container.textContent).not.toContain(outcome.message);
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
  expect(region.parentElement).toBe(document.body);
  const dismiss = within(region).getByRole("button", { name: "关闭错误提示" });
  act(() => dismiss.focus());
  expect(document.activeElement).toBe(dismiss);
  fireEvent.keyDown(dismiss, { key: "Enter", code: "Enter" });
  fireEvent.keyUp(dismiss, { key: "Enter", code: "Enter" });
  await waitFor(() => expect(screen.queryByRole("region", { name: "操作提示" })).toBeNull());
  expect(screen.getByRole("dialog", { name: "编辑器" })).toBeTruthy();
});

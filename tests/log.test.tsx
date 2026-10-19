import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render as renderComponent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LogPanel, useGitLog } from "../src/LogPanel";
import { OperationStatus, RunnerProvider, useRunner } from "../src/runner";
import type { LogEvent } from "../src/api";

const render = (ui: ReactNode) => renderComponent(ui, { wrapper: RunnerProvider });
let emit: (event: { payload: LogEvent }) => void;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event, callback) => { emit = callback; return () => {}; }),
}));
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("原生日志折叠保留收起状态，后续输出不会强行展开", () => {
  const lines: LogEvent[] = [{ kind: "stdout", text: "first output", ts: 1 }];
  const props = { open: true, setOpen: () => {}, clear: () => {} };
  const { rerender } = render(<LogPanel {...props} lines={lines} />);
  const trigger = screen.getByRole("button", { name: /仓库状态与其他输出/ });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  rerender(<LogPanel {...props} lines={[...lines, { kind: "stdout", text: "next output", ts: 2 }]} />);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(trigger);
  expect(screen.getByText("next output")).toBeTruthy();
});

it("同步到达的命令按实际操作分组，连续同名操作独立，后台输出不归入已结束操作", async () => {
  let finish!: () => void;
  function Harness() {
    const runner = useRunner();
    const log = useGitLog();
    return <><button onClick={() => runner.run("同步", async () => {
      emit({ payload: { kind: "cmd", text: "git fetch", ts: Date.now() } });
      await new Promise<void>((resolve) => { finish = resolve; });
    })}>开始</button><LogPanel lines={log.lines} operations={runner.operations} clear={log.clear} open setOpen={() => {}} /></>;
  }
  render(<RunnerProvider><Harness /></RunnerProvider>);
  fireEvent.click(screen.getByRole("button", { name: "开始" }));
  expect(screen.getByText("git fetch").closest(".log-group")?.textContent).toContain("运行中");
  await act(async () => finish());
  expect(screen.getByText("git fetch").closest(".log-group")?.textContent).toContain("已结束");
  act(() => emit({ payload: { kind: "stdout", text: "background status", ts: Date.now() } }));
  expect(screen.getByText("background status").closest(".log-group")?.textContent).toContain("后台读取");
  fireEvent.click(screen.getByRole("button", { name: "开始" }));
  expect(screen.getAllByText("git fetch")).toHaveLength(2);
  expect(new Set(screen.getAllByText("git fetch").map((node) => node.closest(".log-group"))).size).toBe(2);
  await act(async () => finish());
});

it("原生日志高度按钮逐步调整高度，在上下限禁用且离开边界后恢复", () => {
  const { container } = render(<LogPanel lines={[]} clear={() => {}} open setOpen={() => {}} />);
  const panel = container.querySelector<HTMLElement>(".log-panel")!;
  const decrease = screen.getByRole<HTMLButtonElement>("button", { name: "缩小日志面板" });
  const increase = screen.getByRole<HTMLButtonElement>("button", { name: "增大日志面板" });
  const expectHeight = (height: number) => expect(panel.style.getPropertyValue("--log-height")).toBe(`${height}px`);

  expectHeight(240);
  expect(decrease.disabled).toBe(false);
  expect(increase.disabled).toBe(false);
  for (const height of [180, 150]) {
    fireEvent.click(decrease);
    expectHeight(height);
  }
  expect(decrease.disabled).toBe(true);
  fireEvent.click(decrease);
  expectHeight(150);
  for (const height of [210, 270, 330, 390, 450, 480]) {
    fireEvent.click(increase);
    expectHeight(height);
    expect(decrease.disabled).toBe(false);
  }
  expect(increase.disabled).toBe(true);
  fireEvent.click(increase);
  expectHeight(480);
  fireEvent.click(decrease);
  expectHeight(420);
  expect(increase.disabled).toBe(false);
});

it("原生日志高度按钮支持 Enter 和空格键激活", () => {
  const { container } = render(<LogPanel lines={[]} clear={() => {}} open setOpen={() => {}} />);
  const panel = container.querySelector<HTMLElement>(".log-panel")!;
  const increase = screen.getByRole("button", { name: "增大日志面板" });
  const decrease = screen.getByRole("button", { name: "缩小日志面板" });

  act(() => increase.focus());
  fireEvent.keyDown(increase, { key: "Enter", code: "Enter" });
  fireEvent.keyUp(increase, { key: "Enter", code: "Enter" });
  expect(panel.style.getPropertyValue("--log-height")).toBe("300px");
  act(() => decrease.focus());
  fireEvent.keyDown(decrease, { key: " ", code: "Space" });
  fireEvent.keyUp(decrease, { key: " ", code: "Space" });
  expect(panel.style.getPropertyValue("--log-height")).toBe("240px");
});

it.each([true, false])("复制日志通过全局浮动横幅反馈（成功=%s）", async (ok) => {
  const writeText = vi.fn().mockImplementation(async () => { if (!ok) throw new Error("denied"); });
  vi.stubGlobal("navigator", { userAgent: navigator.userAgent, clipboard: { writeText } });
  render(<><LogPanel lines={[{ kind: "stdout", text: "log output", ts: 1 }]} clear={() => {}} open setOpen={() => {}} /><OperationStatus /></>);
  fireEvent.click(screen.getByRole("button", { name: "复制日志" }));
  const message = await screen.findByText(ok ? "日志已复制" : "复制失败，请选择日志文本复制");
  expect(message.closest(".operation-popups")?.parentElement).toBe(document.body);
  expect(message.closest(".log-panel")).toBeNull();
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("log output"));
  fireEvent.click(screen.getByRole("button", { name: ok ? "关闭提示" : "关闭错误提示" }));
  expect(screen.queryByText(ok ? "日志已复制" : "复制失败，请选择日志文本复制")).toBeNull();
});

it("失败即使没有后端日志也显示错误组，并可以清空", async () => {
  function Harness() {
    const runner = useRunner();
    return <><button onClick={() => runner.run("导出", async () => { throw new Error("unavailable"); })}>开始</button>
      <LogPanel lines={[]} operations={runner.operations} clear={runner.clearOperations} open setOpen={() => {}} /></>;
  }
  render(<RunnerProvider><Harness /></RunnerProvider>);
  fireEvent.click(screen.getByRole("button", { name: "开始" }));
  await waitFor(() => expect(screen.getByText("有错误")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "清空" }));
  expect(screen.queryByText("有错误")).toBeNull();
});

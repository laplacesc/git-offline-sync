import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WindowControls } from "../src/WindowControls";

const mocks = vi.hoisted(() => ({
  window: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), destroy: vi.fn(), isMaximized: vi.fn(), onResized: vi.fn() },
  notify: vi.fn(), stop: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks.window }));
vi.mock("../src/runner", () => ({ useRunner: () => ({ notify: mocks.notify }) }));
let resize: () => Promise<void>;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.window.minimize.mockResolvedValue(undefined);
  mocks.window.toggleMaximize.mockResolvedValue(undefined);
  mocks.window.close.mockResolvedValue(undefined);
  mocks.window.isMaximized.mockResolvedValue(false);
  mocks.window.onResized.mockImplementation(async (handler) => { resize = handler; return mocks.stop; });
});
afterEach(cleanup);

it("窗口按钮分别调用原生动作，关闭走 CloseRequested 而非直接销毁", async () => {
  render(<WindowControls />);
  await waitFor(() => expect(mocks.window.isMaximized).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "最小化窗口" }));
  fireEvent.click(screen.getByRole("button", { name: "最大化窗口" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
  expect(mocks.window.minimize).toHaveBeenCalledTimes(1);
  expect(mocks.window.toggleMaximize).toHaveBeenCalledTimes(1);
  expect(mocks.window.close).toHaveBeenCalledTimes(1);
  expect(mocks.window.destroy).not.toHaveBeenCalled();
  expect(screen.getByRole("group", { name: "窗口控制" }).getAttribute("data-tauri-drag-region")).toBe("false");
});

it("初始最大化及系统缩放事件会同步还原按钮状态", async () => {
  mocks.window.isMaximized.mockResolvedValue(true);
  const view = render(<WindowControls />);
  expect(await screen.findByRole("button", { name: "还原窗口" })).toBeTruthy();
  mocks.window.isMaximized.mockResolvedValue(false);
  await act(async () => resize());
  expect(screen.getByRole("button", { name: "最大化窗口" })).toBeTruthy();
  view.unmount();
  expect(mocks.stop).toHaveBeenCalledTimes(1);
});

it("迟到的旧尺寸查询不会覆盖新的最大化状态", async () => {
  let oldResult!: (value: boolean) => void;
  mocks.window.isMaximized.mockImplementationOnce(() => new Promise<boolean>((resolve) => { oldResult = resolve; }));
  render(<WindowControls />);
  await waitFor(() => expect(mocks.window.isMaximized).toHaveBeenCalledTimes(1));
  mocks.window.isMaximized.mockResolvedValue(true);
  await act(async () => resize());
  expect(screen.getByRole("button", { name: "还原窗口" })).toBeTruthy();
  await act(async () => oldResult(false));
  expect(screen.getByRole("button", { name: "还原窗口" })).toBeTruthy();
});

it("卸载后才注册完成的原生监听也会释放", async () => {
  let registered!: (stop: () => void) => void;
  mocks.window.onResized.mockReturnValue(new Promise<() => void>((resolve) => { registered = resolve; }));
  const view = render(<WindowControls />);
  view.unmount();
  await act(async () => registered(mocks.stop));
  expect(mocks.stop).toHaveBeenCalledTimes(1);
  expect(mocks.window.isMaximized).not.toHaveBeenCalled();
});

it("原生操作失败给出可见反馈", async () => {
  mocks.window.minimize.mockRejectedValue(new Error("permission denied"));
  render(<WindowControls />);
  fireEvent.click(screen.getByRole("button", { name: "最小化窗口" }));
  await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith("error", "最小化窗口失败：Error: permission denied"));
});

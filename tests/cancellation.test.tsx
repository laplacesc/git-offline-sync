import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { OperationStatus, RunnerProvider, useRunner } from "../src/runner";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function Harness({ operation }: { operation: () => Promise<null> }) {
  const { run, busy } = useRunner();
  return <><button disabled={!!busy} onClick={() => run("同步", operation)}>开始</button><OperationStatus /></>;
}

it("请求停止后保持忙碌，直到原操作完成才允许下一操作", async () => {
  const task = deferred<null>();
  vi.spyOn(api, "activeOperation").mockResolvedValue(7);
  const cancel = vi.spyOn(api, "cancelOperation").mockResolvedValue(true);
  render(<RunnerProvider><Harness operation={() => task.promise} /></RunnerProvider>);
  fireEvent.click(screen.getByRole("button", { name: "开始" }));
  fireEvent.click(screen.getByRole("button", { name: "请求停止" }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith(7));
  expect((screen.getByRole("button", { name: "等待停止" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "开始" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => task.reject(new Error("已停止 Git 操作，请刷新检查仓库")));
  expect((await screen.findByRole("alert")).textContent).toContain("刷新检查仓库");
  expect((screen.getByRole("button", { name: "开始" }) as HTMLButtonElement).disabled).toBe(false);
});

it("取消查询的旧响应不会停止新启动的操作", async () => {
  const oldTask = deferred<null>();
  const nextTask = deferred<null>();
  const active = deferred<number | null>();
  vi.spyOn(api, "activeOperation").mockReturnValue(active.promise);
  const cancel = vi.spyOn(api, "cancelOperation").mockResolvedValue(true);
  const operation = vi.fn().mockReturnValueOnce(oldTask.promise).mockReturnValueOnce(nextTask.promise);
  render(<RunnerProvider><Harness operation={operation} /></RunnerProvider>);
  fireEvent.click(screen.getByRole("button", { name: "开始" }));
  fireEvent.click(screen.getByRole("button", { name: "请求停止" }));
  await act(async () => oldTask.resolve(null));
  fireEvent.click(screen.getByRole("button", { name: "开始" }));
  await act(async () => active.resolve(8));
  expect(cancel).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "请求停止" })).toBeTruthy();
  await act(async () => nextTask.resolve(null));
});

it("没有可取消的操作时可以重试，不误报回滚成功", async () => {
  const task = deferred<null>();
  vi.spyOn(api, "activeOperation").mockResolvedValue(null);
  const cancel = vi.spyOn(api, "cancelOperation").mockResolvedValue(false);
  render(<RunnerProvider><Harness operation={() => task.promise} /></RunnerProvider>);
  fireEvent.click(screen.getByRole("button", { name: "开始" }));
  fireEvent.click(screen.getByRole("button", { name: "请求停止" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "请求停止" })).toBeTruthy());
  expect(cancel).not.toHaveBeenCalled();
  await act(async () => task.resolve(null));
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpdatePanel, VersionChip } from "../src/UpdatePanel";
import { RunnerProvider } from "../src/runner";
import { __resetUpdater, checkForUpdates, downloadUpdate, getUpdateState } from "../src/updater";

const { check, relaunch } = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  relaunch.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  __resetUpdater();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function prepareDownload() {
  const update = {
    version: "2.1.0",
    body: "修复更新重试",
    close: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
  };
  check.mockResolvedValue(update);
  await checkForUpdates();
  await downloadUpdate();
  return update;
}

it("重启失败后展示待重启摘要和可用重试按钮，点击只重启", async () => {
  const update = await prepareDownload();
  relaunch.mockRejectedValueOnce(new Error("relaunch failed"));
  const onOpenUpdates = vi.fn();
  render(<RunnerProvider>
    <UpdatePanel currentVersion="2.0.0" />
    <VersionChip version="2.0.0" onOpenUpdates={onOpenUpdates} />
  </RunnerProvider>);

  fireEvent.click(screen.getByRole("button", { name: "重启并安装" }));
  const retry = await screen.findByRole("button", { name: "重试重启" });
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByText("已安装版本 v2.1.0，待重启")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重启并安装" })).toBeNull();
  expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "新版本 v2.1.0 已安装，待重启，点击查看" }));
  expect(onOpenUpdates).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledTimes(1);

  fireEvent.click(retry);
  await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(2));
  await waitFor(() => expect((screen.getByRole("button", { name: "立即重启" }) as HTMLButtonElement).disabled).toBe(false));
  expect(update.install).toHaveBeenCalledTimes(1);
  expect(getUpdateState().error).toBeUndefined();
});

it("安装失败后恢复安装按钮，点击可以重新安装", async () => {
  const update = await prepareDownload();
  update.install.mockRejectedValueOnce(new Error("install failed"));
  render(<RunnerProvider><UpdatePanel currentVersion="2.0.0" /></RunnerProvider>);

  fireEvent.click(screen.getByRole("button", { name: "重启并安装" }));
  await waitFor(() => expect(getUpdateState().error).toBe("安装失败：install failed"));
  const retry = screen.getByRole("button", { name: "重启并安装" }) as HTMLButtonElement;
  await waitFor(() => expect(retry.disabled).toBe(false));
  expect(screen.getByText("待安装版本 v2.1.0")).toBeTruthy();
  expect(relaunch).not.toHaveBeenCalled();

  fireEvent.click(retry);
  await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
  expect(update.install).toHaveBeenCalledTimes(2);
  expect(await screen.findByText("已安装版本 v2.1.0，待重启")).toBeTruthy();
});

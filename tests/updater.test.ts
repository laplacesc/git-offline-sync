import { afterEach, describe, expect, it, vi } from "vitest";

const check = vi.fn();
const relaunch = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...a: unknown[]) => check(...a) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));

import { __resetUpdater, checkForUpdates, describeUpdateError, downloadUpdate, getUpdateState, hasUpdate, installUpdate } from "../src/updater";

function fakeUpdate() {
  return {
    version: "2.1.0",
    body: " 修复若干问题 ",
    close: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    download: vi.fn(async (cb: (e: unknown) => void) => {
      cb({ event: "Started", data: { contentLength: 200 } });
      cb({ event: "Progress", data: { chunkLength: 100 } });
      cb({ event: "Progress", data: { chunkLength: 100 } });
      cb({ event: "Finished" });
    }),
  };
}

afterEach(() => {
  __resetUpdater();
  check.mockReset();
  relaunch.mockReset();
});

describe("updater", () => {
  it("没有新版本时为 up-to-date", async () => {
    check.mockResolvedValue(null);
    const s = await checkForUpdates({ manual: true });
    expect(s.status).toBe("up-to-date");
    expect(hasUpdate(s)).toBe(false);
  });

  it("发现新版本 → 下载 → 安装并重启", async () => {
    const u = fakeUpdate();
    check.mockResolvedValue(u);
    const s = await checkForUpdates();
    expect(s).toMatchObject({ status: "available", availableVersion: "2.1.0", releaseNotes: "修复若干问题" });

    await downloadUpdate();
    expect(getUpdateState()).toMatchObject({ status: "downloaded", progressPercent: 100 });

    await installUpdate();
    expect(u.install).toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalled();
  });

  it("自动检查失败保持安静，手动检查失败抛错", async () => {
    check.mockRejectedValue(new Error("network"));
    const s = await checkForUpdates();
    expect(s.status).toBe("idle");
    expect(s.error).toBeUndefined();

    await expect(checkForUpdates({ manual: true })).rejects.toThrow("network");
    expect(getUpdateState().status).toBe("error");
  });

  it("下载失败回到 available 并记录错误", async () => {
    const u = fakeUpdate();
    u.download.mockRejectedValue(new Error("boom"));
    check.mockResolvedValue(u);
    await checkForUpdates();
    await expect(downloadUpdate()).rejects.toThrow("boom");
    expect(getUpdateState()).toMatchObject({ status: "available" });
    expect(getUpdateState().error).toContain("下载失败");
  });

  it("常见插件错误转成中文说明", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(describeUpdateError(new Error("Could not fetch a valid release JSON from the remote"))).toContain("latest.json");
    expect(describeUpdateError("error sending request for url (https://github.com/...)")).toContain("无法连接到 GitHub");
    expect(describeUpdateError(new Error("something else"))).toBe("something else");
  });

  it("手动检查拿不到 latest.json 时给出中文提示", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    check.mockRejectedValue("Could not fetch a valid release JSON from the remote");
    await expect(checkForUpdates({ manual: true })).rejects.toThrow("发布页手动下载");
  });
});

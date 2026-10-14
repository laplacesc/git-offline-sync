import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppearance } from "../src/appearance";

let systemDark = true;
const listeners = new Set<() => void>();
beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  systemDark = true;
  listeners.clear();
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return systemDark; },
    addEventListener(_event: string, listener: () => void) { listeners.add(listener); },
    removeEventListener(_event: string, listener: () => void) { listeners.delete(listener); },
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it("首次采用系统外观，切换后在重新挂载时恢复选择", () => {
  const first = renderHook(useAppearance);
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(first.result.current.preference).toBe("system");
  act(() => first.result.current.setPreference("light"));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("app-shell-theme")).toBe("light");
  first.unmount();
  renderHook(useAppearance);
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("存储不可用时仍能跟随系统并切换外观", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  const { result } = renderHook(useAppearance);
  expect(result.current.appearance).toBe("dark");
  act(() => result.current.setPreference("light"));
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("跟随系统实时响应外观变化，持久化的仍是系统偏好", () => {
  const { result, unmount } = renderHook(useAppearance);
  act(() => { systemDark = false; listeners.forEach((update) => update()); });
  expect(result.current.appearance).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("app-shell-theme")).toBe("system");
  act(() => { systemDark = true; listeners.forEach((update) => update()); });
  expect(result.current.appearance).toBe("dark");
  unmount();
  expect(listeners.size).toBe(0);
});

it("手动选择不受系统变化影响，重新跟随时立即采用当前系统外观", () => {
  localStorage.setItem("app-shell-theme", "light");
  const { result } = renderHook(useAppearance);
  act(() => { systemDark = false; listeners.forEach((update) => update()); });
  act(() => { systemDark = true; listeners.forEach((update) => update()); });
  expect(result.current.appearance).toBe("light");
  expect(localStorage.getItem("app-shell-theme")).toBe("light");
  act(() => result.current.setPreference("system"));
  expect(result.current.appearance).toBe("dark");
  expect(localStorage.getItem("app-shell-theme")).toBe("system");
});

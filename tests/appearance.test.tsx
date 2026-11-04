import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppearance } from "../src/appearance";
import indexHtml from "../index.html?raw";

let systemDark = true;
const listeners = new Set<() => void>();
beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("style");
  document.head.innerHTML = '<meta name="theme-color" content="#ffffff">';
  systemDark = true;
  listeners.clear();
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return systemDark; },
    addEventListener(_event: string, listener: () => void) { listeners.add(listener); },
    removeEventListener(_event: string, listener: () => void) { listeners.delete(listener); },
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it("首次跟随系统，手动切换后重新挂载恢复选择", () => {
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

it("存储不可用时仍能切换，首屏脚本也能跟随系统", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(() => new Function(indexHtml.match(/<script>([\s\S]*?)<\/script>/)![1])()).not.toThrow();
  expect(document.documentElement.dataset.theme).toBe("dark");
  const { result } = renderHook(useAppearance);
  act(() => result.current.setPreference("light"));
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("系统变化只影响跟随系统，卸载时清理监听", () => {
  const { result, unmount } = renderHook(useAppearance);
  act(() => { systemDark = false; listeners.forEach((update) => update()); });
  expect(result.current.appearance).toBe("light");
  act(() => result.current.setPreference("dark"));
  act(() => { systemDark = true; listeners.forEach((update) => update()); });
  act(() => { systemDark = false; listeners.forEach((update) => update()); });
  expect(result.current.appearance).toBe("dark");
  act(() => result.current.setPreference("system"));
  expect(result.current.appearance).toBe("light");
  expect(localStorage.getItem("app-shell-theme")).toBe("system");
  unmount();
  expect(listeners.size).toBe(0);
});

it("切换同步首屏底色、color-scheme 和 theme-color", () => {
  const { result } = renderHook(useAppearance);
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#181818");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  act(() => result.current.setPreference("light"));
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#ffffff");
  expect(document.documentElement.style.colorScheme).toBe("light");
  expect(document.documentElement.style.backgroundColor).toBe("rgb(255, 255, 255)");
});

it.each([
  ["light", true, "light"], ["dark", false, "dark"],
  ["system", true, "dark"], ["system", false, "light"], ["invalid", true, "dark"],
])("首屏脚本与挂载后的主题一致：%s，系统深色 %s", (saved, dark, expected) => {
  localStorage.setItem("app-shell-theme", saved);
  systemDark = dark as boolean;
  new Function(indexHtml.match(/<script>([\s\S]*?)<\/script>/)![1])();
  expect(document.documentElement.dataset.theme).toBe(expected);
  renderHook(useAppearance);
  expect(document.documentElement.dataset.theme).toBe(expected);
});

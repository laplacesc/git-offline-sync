import { readFileSync } from "node:fs";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppearance } from "../src/appearance";
import indexHtml from "../index.html?raw";

const appearanceCss = readFileSync(`${process.cwd()}/src/index.css`, "utf8");

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

it("切换主题同步浏览器底色、color-scheme 与 theme-color", () => {
  const { result } = renderHook(useAppearance);
  const meta = document.querySelector('meta[name="theme-color"]')!;
  expect(meta.getAttribute("content")).toBe("#181818");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  act(() => result.current.setPreference("light"));
  expect(meta.getAttribute("content")).toBe("#ffffff");
  expect(document.documentElement.style.colorScheme).toBe("light");
  expect(document.documentElement.style.backgroundColor).toBe("rgb(255, 255, 255)");
});

it.each([
  ["light", true, "light"], ["dark", false, "dark"],
  ["system", true, "dark"], ["system", false, "light"], ["invalid", true, "dark"],
])("首屏脚本在 React 挂载前恢复 %s（系统深色 %s）", (saved, dark, expected) => {
  localStorage.setItem("app-shell-theme", saved);
  systemDark = dark as boolean;
  const script = indexHtml.match(/<script>([\s\S]*?)<\/script>/)![1];
  new Function(script)();
  expect(document.documentElement.dataset.theme).toBe(expected);
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content"))
    .toBe(expected === "dark" ? "#181818" : "#ffffff");
  renderHook(useAppearance);
  expect(document.documentElement.dataset.theme).toBe(expected);
});

it("首屏脚本在 storage 禁用时仍可恢复系统主题", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(() => new Function(indexHtml.match(/<script>([\s\S]*?)<\/script>/)![1])()).not.toThrow();
  expect(document.documentElement.dataset.theme).toBe("dark");
});

it.each([
  ["light", "#ffffff", "#1a1c1f", "#ffffff", "200ms", "#ffffff"],
  ["dark", "#181818", "#ffffff", "#181818", "200ms", "#282828"],
])("%s 主题使用 PI-Desktop 的中性配色与浮层", (theme, bg, primary, foreground, motion, overlay) => {
  const style = document.createElement("style");
  style.textContent = appearanceCss.slice(appearanceCss.indexOf(":root"), appearanceCss.indexOf("@theme inline"));
  document.head.append(style);
  document.documentElement.dataset.theme = theme;
  const tokens = getComputedStyle(document.documentElement);
  expect(tokens.getPropertyValue("--bg").trim()).toBe(bg);
  expect(tokens.getPropertyValue("--primary").replace(/\s/g, "")).toBe(primary.replace(/\s/g, ""));
  expect(tokens.getPropertyValue("--primary-fg").trim()).toBe(foreground);
  expect(tokens.getPropertyValue("--motion-disclosure-duration").trim()).toBe(motion);
  expect(tokens.getPropertyValue("--floating-surface").trim()).toBe(overlay);
});

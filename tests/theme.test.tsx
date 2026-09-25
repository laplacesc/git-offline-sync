import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Theme } from "../src/api";
import { useTheme } from "../src/theme";

let dark: boolean;
let listeners: Set<() => void>;
beforeEach(() => {
  dark = false;
  listeners = new Set();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return dark; },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setSystemDark(value: boolean) {
  act(() => {
    dark = value;
    for (const listener of listeners) listener();
  });
}

it("未配置主题时默认跟随系统，并监听后续变化", () => {
  const { unmount } = renderHook(() => useTheme());
  expect(document.documentElement.dataset.theme).toBe("light");
  setSystemDark(true);
  expect(document.documentElement.dataset.theme).toBe("dark");
  setSystemDark(false);
  expect(document.documentElement.dataset.theme).toBe("light");
  unmount();
  expect(listeners.size).toBe(0);
  expect(document.documentElement.dataset.theme).toBeUndefined();
});

it.each(["light", "dark"] as const)("固定 %s 主题不受系统变化影响", (theme) => {
  dark = theme === "light";
  renderHook(() => useTheme(theme));
  expect(document.documentElement.dataset.theme).toBe(theme);
  setSystemDark(!dark);
  expect(document.documentElement.dataset.theme).toBe(theme);
  expect(listeners.size).toBe(0);
});

it("切换到固定主题时解除监听，切回系统时恢复", () => {
  const { rerender } = renderHook(({ theme }: { theme: Theme }) => useTheme(theme), { initialProps: { theme: "system" as Theme } });
  expect(listeners.size).toBe(1);
  rerender({ theme: "dark" });
  expect(listeners.size).toBe(0);
  expect(document.documentElement.dataset.theme).toBe("dark");
  rerender({ theme: "system" });
  expect(listeners.size).toBe(1);
  expect(document.documentElement.dataset.theme).toBe("light");
  setSystemDark(true);
  expect(document.documentElement.dataset.theme).toBe("dark");
});

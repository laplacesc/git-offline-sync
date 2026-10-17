import { readFileSync } from "node:fs";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppearance } from "../src/appearance";
import { BackgroundScene } from "../src/BackgroundScene";
import indexHtml from "../index.html?raw";

const appearanceCss = readFileSync(`${process.cwd()}/src/index.css`, "utf8");

let systemDark = true;
const listeners = new Set<() => void>();
beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("style");
  document.head.innerHTML = '<meta name="theme-color" content="#f8f4eb">';
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
  expect(meta.getAttribute("content")).toBe("#0b1322");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  act(() => result.current.setPreference("light"));
  expect(meta.getAttribute("content")).toBe("#f8f4eb");
  expect(document.documentElement.style.colorScheme).toBe("light");
  expect(document.documentElement.style.backgroundColor).toBe("rgb(248, 244, 235)");
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
    .toBe(expected === "dark" ? "#0b1322" : "#f8f4eb");
  renderHook(useAppearance);
  expect(document.documentElement.dataset.theme).toBe(expected);
});

it("首屏脚本在 storage 禁用时仍可恢复系统主题", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(() => new Function(indexHtml.match(/<script>([\s\S]*?)<\/script>/)![1])()).not.toThrow();
  expect(document.documentElement.dataset.theme).toBe("dark");
});

it.each([
  ["light", "#f8f4eb", "#7351e5", "#ffffff", "0ms", "blur(24px) saturate(110%)"],
  ["dark", "#0b1322", "rgba(228, 184, 99, .15)", "#f3dca8", "500ms", "blur(60px) saturate(180%)"],
])("%s 主题独立使用确认的配色、玻璃和动效 token", (theme, bg, primary, foreground, motion, filter) => {
  const style = document.createElement("style");
  style.textContent = appearanceCss.slice(appearanceCss.indexOf(":root"), appearanceCss.indexOf("@theme inline"));
  document.head.append(style);
  document.documentElement.dataset.theme = theme;
  const tokens = getComputedStyle(document.documentElement);
  expect(tokens.getPropertyValue("--bg").trim()).toBe(bg);
  expect(tokens.getPropertyValue("--primary").replace(/\s/g, "")).toBe(primary.replace(/\s/g, ""));
  expect(tokens.getPropertyValue("--primary-fg").trim()).toBe(foreground);
  expect(tokens.getPropertyValue("--motion-disclosure-duration").trim()).toBe(motion);
  expect(tokens.getPropertyValue("--panel-filter").trim()).toBe(filter);
});

describe("BackgroundScene 生命周期", () => {
  let reduced = false;
  let hidden = false;
  let width = 1000;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const reductions = new Set<() => void>();
  const intersections: { callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const resizes: { callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TRIANGLES: 8,
    createShader: vi.fn(() => ({})), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})), attachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), deleteProgram: vi.fn(),
    createBuffer: vi.fn(() => ({})), deleteBuffer: vi.fn(), bindBuffer: vi.fn(), bufferData: vi.fn(),
    useProgram: vi.fn(), getAttribLocation: vi.fn(() => 0), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn(() => ({})), viewport: vi.fn(), uniform2f: vi.fn(), uniform1f: vi.fn(),
    drawArrays: vi.fn(), isContextLost: vi.fn(() => false), getExtension: vi.fn(),
  };
  const enter = (isIntersecting = true) => act(() => {
    for (const observer of intersections) {
      if (!observer.disconnect.mock.calls.length) observer.callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });
  const advanceFrame = (now: number) => act(() => {
    const scheduled = [...frames.values()];
    frames.clear();
    scheduled.forEach((callback) => callback(now));
  });

  beforeEach(() => {
    reduced = false; hidden = false; width = 1000; nextFrame = 0;
    frames.clear(); reductions.clear(); intersections.length = 0; resizes.length = 0;
    for (const value of Object.values(gl)) if (typeof value === "function") value.mockClear();
    gl.getShaderParameter.mockReturnValue(true);
    gl.getProgramParameter.mockReturnValue(true);
    gl.isContextLost.mockReturnValue(false);
    document.documentElement.dataset.theme = "light";
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("matchMedia", () => ({
      get matches() { return reduced; },
      addEventListener(_event: string, listener: () => void) { reductions.add(listener); },
      removeEventListener(_event: string, listener: () => void) { reductions.delete(listener); },
    }));
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback); return nextFrame;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
    vi.stubGlobal("IntersectionObserver", class {
      disconnect = vi.fn();
      constructor(callback: IntersectionObserverCallback) { intersections.push({ callback, disconnect: this.disconnect }); }
      observe() {}
    });
    vi.stubGlobal("ResizeObserver", class {
      disconnect = vi.fn();
      constructor(callback: ResizeObserverCallback) { resizes.push({ callback, disconnect: this.disconnect }); }
      observe() {}
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width, height: 800 }) as DOMRect);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(gl as unknown as WebGLRenderingContext);
  });

  it("StrictMode 清理观察器、监听、RAF 与 GL 资源，同一个 canvas 可再次初始化", () => {
    // Without IntersectionObserver the setup draws immediately, including the StrictMode replay.
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container, unmount } = render(<StrictMode><BackgroundScene /></StrictMode>);
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
    expect(container.querySelector("canvas")?.dataset.state).toBe("ready");
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
    expect(reductions.size).toBe(0);
    expect(resizes.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(2);
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
    expect(gl.deleteShader).toHaveBeenCalledTimes(4);
    expect(gl.getExtension).not.toHaveBeenCalled();
    fireEvent(window, new Event("pageshow"));
    fireEvent(window, new Event("resize"));
    expect(frames.size).toBe(0);
  });

  it("离屏、隐藏、深色和 pagehide 暂停，恢复后继续且最多每秒绘制 24 帧", async () => {
    const { unmount } = render(<BackgroundScene />);
    expect(gl.drawArrays).not.toHaveBeenCalled();
    enter();
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    advanceFrame(16); advanceFrame(32);
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    advanceFrame(48);
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
    enter(false); expect(frames.size).toBe(0);
    enter(); expect(frames.size).toBe(1);
    hidden = true; fireEvent(document, new Event("visibilitychange")); expect(frames.size).toBe(0);
    hidden = false; fireEvent(document, new Event("visibilitychange")); expect(frames.size).toBe(1);
    await act(async () => { document.documentElement.dataset.theme = "dark"; });
    expect(frames.size).toBe(0);
    await act(async () => { document.documentElement.dataset.theme = "light"; });
    expect(frames.size).toBe(1);
    fireEvent(window, new Event("pagehide")); expect(frames.size).toBe(0);
    fireEvent(window, new Event("pageshow")); expect(frames.size).toBe(1);
    unmount();
    expect(intersections.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it("减少动态效果只绘制一帧，重绘尺寸时桌面 DPR 上限 1.5、移动端上限 1", () => {
    reduced = true;
    const { container } = render(<BackgroundScene />);
    enter();
    const canvas = container.querySelector("canvas")!;
    expect(canvas.width).toBe(1500);
    expect(canvas.height).toBe(1200);
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    expect(gl.uniform1f).toHaveBeenLastCalledWith(expect.anything(), 0);
    expect(frames.size).toBe(0);
    fireEvent(window, new Event("resize"));
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    width = 390;
    fireEvent(window, new Event("resize"));
    expect(canvas.width).toBe(390);
    expect(canvas.height).toBe(800);
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
    act(() => { reduced = false; reductions.forEach((callback) => callback()); });
    expect(frames.size).toBe(1);
    act(() => { reduced = true; reductions.forEach((callback) => callback()); });
    expect(frames.size).toBe(0);
  });

  it("上下文丢失显示 CSS 降级，恢复后重新建立资源", () => {
    const { container } = render(<BackgroundScene />);
    enter();
    const canvas = container.querySelector("canvas")!;
    const loss = new Event("webglcontextlost", { cancelable: true });
    fireEvent(canvas, loss);
    expect(loss.defaultPrevented).toBe(true);
    expect(canvas.dataset.state).toBe("fallback");
    expect(frames.size).toBe(0);
    fireEvent(canvas, new Event("webglcontextrestored"));
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    expect(canvas.dataset.state).toBe("ready");
    expect(frames.size).toBe(1);
  });

  it.each(["unavailable", "throws", "compile", "link"])("WebGL %s 时不抛异常或阻塞 UI", (failure) => {
    if (failure === "unavailable") vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    if (failure === "throws") vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => { throw new Error("blocked"); });
    if (failure === "compile") gl.getShaderParameter.mockReturnValue(false);
    if (failure === "link") gl.getProgramParameter.mockReturnValue(false);
    const { container } = render(<><BackgroundScene /><button>同步</button></>);
    expect(() => enter()).not.toThrow();
    expect(container.querySelector("canvas")?.dataset.state).toBe("fallback");
    expect(container.querySelector("button")?.textContent).toBe("同步");
    expect(frames.size).toBe(0);
  });
});

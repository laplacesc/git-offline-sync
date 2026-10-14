import { CSSProperties, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDisclosureMotion, useInputModality } from "../src/motion";

const animations: { finish: () => void; cancel: ReturnType<typeof vi.fn> }[] = [];
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
let reduced = false;
let reductionChanged: () => void;
const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
  let finish!: () => void;
  let reject!: () => void;
  const finished = new Promise<void>((resolve, no) => { finish = resolve; reject = no; });
  const cancel = vi.fn(reject);
  animations.push({ finish, cancel });
  return { finished, cancel };
});

beforeEach(() => {
  reduced = false;
  animations.length = 0;
  animate.mockClear();
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return reduced; },
    addEventListener(_event: string, listener: () => void) { reductionChanged = listener; },
    removeEventListener() {},
  }));
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
});
afterEach(() => {
  cleanup();
  if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Harness({ enabled = true }: { enabled?: boolean }) {
  useInputModality();
  const [open, setOpen] = useState(false);
  const motion = useDisclosureMotion<HTMLDivElement>(open, "collapse", enabled);
  return <><button onClick={() => setOpen(!open)}>切换</button>
    <div ref={motion.ref} data-testid="content" role="region" aria-label="链路"
      hidden={!motion.visible} inert={!open} aria-hidden={!open}
      style={{ "--spring": "cubic-bezier(0.23, 1, 0.32, 1)", "--motion-disclosure-duration": "200ms" } as CSSProperties}>
      <button>链路操作</button>
    </div></>;
}

it("关闭立即移出焦点与读屏，退出完成后隐藏视觉内容", async () => {
  render(<Harness />);
  const toggle = screen.getByRole("button", { name: "切换" });
  fireEvent.pointerDown(toggle);
  fireEvent.click(toggle);
  await act(async () => animations[0].finish());
  fireEvent.click(toggle);
  const content = screen.getByTestId("content");
  expect(content.hidden).toBe(false);
  expect(content.hasAttribute("inert")).toBe(true);
  expect(screen.queryByRole("region", { name: "链路" })).toBeNull();
  await act(async () => animations[1].finish());
  expect(content.hidden).toBe(true);
});

it("展开期间反向关闭从当前高度继续，过期动画不能隐藏再次展开的内容", async () => {
  render(<Harness />);
  const toggle = screen.getByRole("button", { name: "切换" });
  fireEvent.pointerDown(toggle);
  fireEvent.click(toggle);
  vi.spyOn(screen.getByTestId("content"), "getBoundingClientRect").mockReturnValue({ height: 80 } as DOMRect);
  fireEvent.click(toggle);
  expect(animate.mock.calls[1]?.[0][0]).toMatchObject({ height: "80px" });
  expect(animations[0].cancel).toHaveBeenCalledOnce();
  fireEvent.click(toggle);
  await act(async () => animations[1].finish());
  expect(screen.getByTestId("content").hidden).toBe(false);
  expect(screen.getByRole("region", { name: "链路" })).toBeTruthy();
  await act(async () => animations[2].finish());
  expect(screen.getByTestId("content").hidden).toBe(false);
});

it.each(["keyboard", "reduced", "disabled"])("%s 模式的展开与收起即时完成", (mode) => {
  reduced = mode === "reduced";
  render(<Harness enabled={mode !== "disabled"} />);
  const toggle = screen.getByRole("button", { name: "切换" });
  if (mode === "keyboard") fireEvent.keyDown(toggle, { key: "Enter" });
  else fireEvent.pointerDown(toggle);
  fireEvent.click(toggle);
  expect(screen.getByTestId("content").hidden).toBe(false);
  fireEvent.click(toggle);
  expect(screen.getByTestId("content").hidden).toBe(true);
  expect(animate).not.toHaveBeenCalled();
});

it("动画中切换减少动态效果会立刻结束，卸载会清理尚未完成的动画", () => {
  const view = render(<Harness />);
  const toggle = screen.getByRole("button", { name: "切换" });
  fireEvent.pointerDown(toggle);
  fireEvent.click(toggle);
  act(() => { reduced = true; reductionChanged(); });
  expect(animations[0].cancel).toHaveBeenCalledOnce();
  expect(screen.getByTestId("content").hidden).toBe(false);
  act(() => { reduced = false; reductionChanged(); });
  fireEvent.click(toggle);
  view.unmount();
  expect(animations[1].cancel).toHaveBeenCalledOnce();
});

it("响应式模式切换即时完成，之后的主动操作仍可动画", () => {
  const view = render(<Harness />);
  const toggle = screen.getByRole("button", { name: "切换" });
  fireEvent.pointerDown(toggle);
  fireEvent.click(toggle);
  view.rerender(<Harness enabled={false} />);
  expect(animations[0].cancel).toHaveBeenCalledOnce();
  expect(screen.getByTestId("content").hidden).toBe(false);
  fireEvent.click(toggle);
  view.rerender(<Harness enabled />);
  expect(animate).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("content").hidden).toBe(true);
  fireEvent.click(toggle);
  expect(animate).toHaveBeenCalledTimes(2);
});

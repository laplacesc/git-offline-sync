import { beforeEach } from "vitest";

beforeEach(() => {
  // jsdom 30 移除聚焦节点后会在下次聚焦时误发 window.blur，导致 Radix 菜单立即关闭。
  // 使用 DOM API 清空遗留焦点，保证各测试从未聚焦的状态开始。
  const focusReset = document.createElement("button");
  document.body.append(focusReset);
  focusReset.focus();
  focusReset.blur();
  focusReset.remove();
});

// jsdom 缺少 Radix 在浏览器中使用的布局和指针 API。
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!window.PointerEvent) window.PointerEvent = MouseEvent as typeof PointerEvent;
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useInputModality } from "../src/motion";

afterEach(cleanup);

it("跟踪指针与键盘输入，卸载后清理标记与监听器", () => {
  const { unmount } = renderHook(useInputModality);
  fireEvent.pointerDown(document);
  expect(document.documentElement.dataset.inputModality).toBe("pointer");
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.documentElement.dataset.inputModality).toBe("keyboard");
  fireEvent.pointerDown(document);
  expect(document.documentElement.dataset.inputModality).toBe("pointer");

  unmount();
  expect(document.documentElement.dataset.inputModality).toBeUndefined();
  fireEvent.keyDown(document, { key: "Tab" });
  fireEvent.pointerDown(document);
  expect(document.documentElement.dataset.inputModality).toBeUndefined();
});

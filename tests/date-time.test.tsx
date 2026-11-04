import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DateTime, Time } from "../src/DateTime";

afterEach(cleanup);

it("提交日期以语义化只读时间展示，不进入键盘焦点顺序", () => {
  const { container } = render(<DateTime value="2026-10-19 14:35" label="提交时间" />);
  const field = screen.getByLabelText("提交时间");
  expect(field.tagName).toBe("TIME");
  expect(field.getAttribute("datetime")).toBe(new Date(2026, 9, 19, 14, 35).toISOString());
  expect(field.textContent).toContain("2026");
  expect(field.textContent).toContain("35");
  const before = field.textContent;
  fireEvent.keyDown(field, { key: "ArrowUp" });
  expect(field.textContent).toBe(before);
  expect(container.querySelector('[contenteditable="true"], [tabindex="0"], input')).toBeNull();
});

it("缺失或损坏日期显示占位，Unix 零时刻仍可展示", () => {
  const { rerender } = render(<DateTime value={null} />);
  expect(screen.getByText("—")).toBeTruthy();
  rerender(<DateTime value="invalid" />);
  expect(screen.getByText("—")).toBeTruthy();
  rerender(<DateTime value={0} />);
  expect(screen.getByLabelText("日期时间").getAttribute("datetime")).toBe("1970-01-01T00:00:00.000Z");
});

it("日志时间保留秒，不提供编辑控件", () => {
  const { container } = render(<Time value={new Date(2026, 9, 19, 14, 35, 42).getTime()} label="日志时间" />);
  expect(screen.getByLabelText("日志时间").textContent).toBe("14:35:42");
  expect(container.querySelector('[tabindex="0"], input')).toBeNull();
});

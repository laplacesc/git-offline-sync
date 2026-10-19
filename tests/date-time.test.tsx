import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DateTime, Time } from "../src/DateTime";

afterEach(cleanup);

it("提交日期使用 HeroUI 只读字段，键盘不能修改时间", () => {
  const { container } = render(<DateTime value="2026-10-19 14:35" label="提交时间" />);
  const field = screen.getByRole("group", { name: "提交时间" });
  expect(field.getAttribute("data-readonly")).not.toBeNull();
  expect(field.textContent).toContain("2026");
  expect(field.textContent).toContain("35");
  const before = field.textContent;
  const year = container.querySelector('[data-type="year"]')!;
  fireEvent.keyDown(year, { key: "ArrowUp" });
  expect(field.textContent).toBe(before);
  expect(container.querySelector('[contenteditable="true"]')).toBeNull();
  expect(container.querySelector('[tabindex="0"]')).toBeNull();
});

it("缺失或损坏日期显示占位，Unix 零时刻仍可展示", () => {
  const { rerender } = render(<DateTime value={null} />);
  expect(screen.getByText("—")).toBeTruthy();
  rerender(<DateTime value="invalid" />);
  expect(screen.getByText("—")).toBeTruthy();
  rerender(<DateTime value={0} />);
  expect(screen.getByRole("group", { name: "日期时间" })).toBeTruthy();
});

it("日志使用 HeroUI 只读时间字段并保留秒", () => {
  const { container } = render(<Time value={new Date(2026, 9, 19, 14, 35, 42).getTime()} label="日志时间" />);
  const field = screen.getByRole("group", { name: "日志时间" });
  expect(field.getAttribute("data-readonly")).not.toBeNull();
  expect(field.textContent).toContain("42");
  expect(container.querySelector('[tabindex="0"]')).toBeNull();
});

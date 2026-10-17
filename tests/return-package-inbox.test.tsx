import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Button } from "@heroui/react";
import { ReturnPackageInbox } from "../src/ReturnPackageInbox";
import type { ReturnPackageInfo } from "../src/api";

function packages(count: number): ReturnPackageInfo[] {
  return Array.from({ length: count }, (_, index) => {
    const seq = index + 1;
    const id = String(seq).padStart(4, "0");
    return { payloadPath: `/usb/package-${id}.bundle`, manifestPath: `/usb/package-${id}.json`, payloadExists: true,
      received: false, receiptKey: `receipt-${id}`, manifest: { format: 1, kind: "back", repoName: "project", repoId: "project-id",
        seq, createdAt: seq, payload: `package-${id}.bundle`, baseBranch: "main", toolVersion: "2.1.0",
        refs: [{ name: `refs/heads/feature/item-${id}`, sha: `sha-${id}`, base: "main" }] } };
  });
}
function view(items: ReturnPackageInfo[], imported = vi.fn()) {
  return <ReturnPackageInbox packages={items} disabled={false} getIssue={() => null}
    renderDetails={(pkg) => <><h2>{pkg.payloadPath}</h2><Button onPress={() => imported(pkg.payloadPath)}>导入回传</Button></>} />;
}
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("大量包每页只渲染20项，只有选中的包显示导入入口", () => {
  const imported = vi.fn();
  render(view(packages(53), imported));
  const list = screen.getByRole("listbox", { name: "回传包列表" });
  expect(within(list).getAllByRole("option")).toHaveLength(20);
  expect(screen.getAllByRole("button", { name: "导入回传" })).toHaveLength(1);
  expect(screen.getByText("1–20 / 53")).toBeTruthy();
  fireEvent.click(within(list).getByRole("option", { name: /package-0050.bundle/ }));
  fireEvent.click(screen.getByRole("button", { name: "导入回传" }));
  expect(imported).toHaveBeenCalledExactlyOnceWith("/usb/package-0050.bundle");
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByText("21–40 / 53")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "/usb/package-0033.bundle" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(within(list).getAllByRole("option")).toHaveLength(13);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "下一页" }).disabled).toBe(true);
});

it("搜索跨越所有分页，支持分支和文件名且无结果可清除", () => {
  render(view(packages(53)));
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  const search = screen.getByRole("textbox", { name: "搜索回传包" });
  fireEvent.change(search, { target: { value: "FEATURE/item-0001" } });
  expect(screen.getByText("1–1 / 1")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "/usb/package-0001.bundle" })).toBeTruthy();
  fireEvent.change(search, { target: { value: "package-0052.bundle" } });
  expect(screen.getByRole("heading", { name: "/usb/package-0052.bundle" })).toBeTruthy();
  fireEvent.change(search, { target: { value: "no-such-package" } });
  expect(screen.getByText("没有匹配的回传包。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "导入回传" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  expect(screen.getByText("1–20 / 53")).toBeTruthy();
});

it("按接收状态筛选，不把历史包混入待接收列表", async () => {
  const items = packages(2);
  items[1].received = true;
  render(view(items));
  expect(screen.getByRole("heading", { name: "/usb/package-0001.bundle" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /接收状态/ }));
  fireEvent.click(await screen.findByRole("option", { name: /已接收/ }));
  expect(screen.getByRole("heading", { name: "/usb/package-0002.bundle" })).toBeTruthy();
  expect(screen.getByText("1–1 / 1")).toBeTruthy();
});

it("接收状态刷新后移除已处理项，自动展示下一项但不自动导入", () => {
  const items = packages(2);
  const imported = vi.fn();
  const { rerender } = render(view(items, imported));
  fireEvent.click(screen.getByRole("button", { name: "导入回传" }));
  expect(imported).toHaveBeenCalledExactlyOnceWith("/usb/package-0002.bundle");
  rerender(view(items.map((pkg) => pkg.manifest!.seq === 2 ? { ...pkg, received: true } : pkg), imported));
  expect(screen.getByRole("heading", { name: "/usb/package-0001.bundle" })).toBeTruthy();
  expect(imported).toHaveBeenCalledTimes(1);
  rerender(view(items.map((pkg) => ({ ...pkg, received: true })), imported));
  expect(screen.queryByRole("button", { name: "导入回传" })).toBeNull();
  expect(screen.getByRole("button", { name: "查看已接收的包" })).toBeTruthy();
});

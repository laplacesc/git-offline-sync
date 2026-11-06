import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Button } from "../src/components/ui/button";
import { PackageInbox } from "../src/PackageInbox";
import type { PackageInfo } from "../src/api";

function packages(count: number): PackageInfo[] {
  return Array.from({ length: count }, (_, index) => {
    const seq = index + 1;
    const id = String(seq).padStart(4, "0");
    return { payloadPath: `/usb/package-${id}.bundle`, payloadExists: true,
      manifest: { format: 1, kind: "back", repoName: "project", repoId: "project-id",
        seq, createdAt: seq, payload: `package-${id}.bundle`, baseBranch: "main", toolVersion: "2.1.0",
        refs: [{ name: `refs/heads/feature/item-${id}`, sha: `sha-${id}`, base: "main" }] } };
  });
}
function view(items: PackageInfo[], imported = vi.fn()) {
  return <PackageInbox packages={items} disabled={false}
    renderDetails={(pkg) => <><h2>{pkg.payloadPath}</h2><Button onClick={() => imported(pkg.payloadPath)}>导入回传</Button></>} />;
}
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("默认仅展示最新五个，展开后分页，每行都能直接导入", () => {
  const imported = vi.fn();
  render(view(packages(53), imported));
  const list = screen.getByRole("list", { name: "回传包列表" });
  expect(within(list).getAllByRole("listitem").map((row) => row.getAttribute("aria-label"))).toEqual([
    "package-0053.bundle", "package-0052.bundle", "package-0051.bundle", "package-0050.bundle", "package-0049.bundle",
  ]);
  expect(screen.queryByRole("navigation", { name: "回传包分页" })).toBeNull();
  const toggle = screen.getByRole("button", { name: "展开其余 48 个回传包" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-controls")).toBe(list.id);
  fireEvent.click(within(within(list).getByRole("listitem", { name: "package-0050.bundle" })).getByRole("button", { name: "导入回传" }));
  expect(imported).toHaveBeenCalledExactlyOnceWith("/usb/package-0050.bundle");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(within(list).getAllByRole("listitem")).toHaveLength(20);
  expect(screen.getAllByRole("button", { name: "导入回传" })).toHaveLength(20);
  expect(screen.getByText("1–20 / 53")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByText("21–40 / 53")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "/usb/package-0033.bundle" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(within(list).getAllByRole("listitem")).toHaveLength(13);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "下一页" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "收起", exact: true }));
  expect(within(list).getAllByRole("listitem")).toHaveLength(5);
  expect(screen.getByRole("listitem", { name: "package-0053.bundle" })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "回传包分页" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "展开其余 48 个回传包" }));
  expect(screen.getByText("1–20 / 53")).toBeTruthy();
});

it("搜索跨越所有折叠项和分页，支持分支和文件名且无结果可清除", () => {
  render(view(packages(53)));
  const search = screen.getByRole("textbox", { name: "搜索回传包" });
  fireEvent.change(search, { target: { value: "FEATURE/item-0001" } });
  expect(screen.getByRole("heading", { name: "/usb/package-0001.bundle" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /展开其余/ })).toBeNull();
  fireEvent.change(search, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "展开其余 48 个回传包" }));
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  fireEvent.change(search, { target: { value: "package-0052.bundle" } });
  expect(screen.queryByRole("navigation", { name: "回传包分页" })).toBeNull();
  expect(screen.getByRole("heading", { name: "/usb/package-0052.bundle" })).toBeTruthy();
  fireEvent.change(search, { target: { value: "no-such-package" } });
  expect(screen.getByText("没有匹配的回传包。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "导入回传" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  expect(screen.getByText("1–20 / 53")).toBeTruthy();
});

it("五个以内不显示折叠入口，包的刷新不会自动展开", () => {
  const { rerender } = render(view(packages(5)));
  expect(screen.getAllByRole("listitem")).toHaveLength(5);
  expect(screen.queryByRole("button", { name: /展开其余/ })).toBeNull();
  rerender(view(packages(6)));
  expect(screen.getAllByRole("listitem")).toHaveLength(5);
  expect(screen.getByRole("listitem", { name: "package-0006.bundle" })).toBeTruthy();
  expect(screen.queryByRole("listitem", { name: "package-0001.bundle" })).toBeNull();
  expect(screen.getByRole("button", { name: "展开其余 1 个回传包" })).toBeTruthy();
});

it("不按导入状态筛选，所有包都直接显示导入入口", () => {
  const items = packages(2);
  render(view(items));
  expect(screen.getAllByRole("button", { name: "导入回传" })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /接收状态/ })).toBeNull();
  expect(screen.queryByText("已接收")).toBeNull();
  expect(screen.queryByText("待接收")).toBeNull();
});

it("包列表只展示序号、分支和文件名，不展示时间或技术详情", () => {
  render(<PackageInbox packages={packages(1)} disabled={false} renderDetails={() => <Button>导入回传</Button>} />);
  const row = screen.getByRole("listitem", { name: "package-0001.bundle" });
  expect(within(row).getByText("#1")).toBeTruthy();
  expect(within(row).getByText("feature/item-0001")).toBeTruthy();
  expect(within(row).getByText("package-0001.bundle")).toBeTruthy();
  expect(row.querySelector("time")).toBeNull();
  expect(within(row).queryByText("project-id")).toBeNull();
  expect(within(row).queryByText("receipt-0001")).toBeNull();
});

it("导入后包保留在原列表，刷新后可再次导入且不会自动执行", () => {
  const items = packages(2);
  const imported = vi.fn();
  const { rerender } = render(view(items, imported));
  const importSecond = () => fireEvent.click(within(screen.getByRole("listitem", { name: "package-0002.bundle" })).getByRole("button", { name: "导入回传" }));
  importSecond();
  expect(imported).toHaveBeenCalledExactlyOnceWith("/usb/package-0002.bundle");
  rerender(view(items.map((pkg) => ({ ...pkg })), imported));
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(imported).toHaveBeenCalledTimes(1);
  importSecond();
  expect(imported).toHaveBeenCalledTimes(2);
  expect(imported).toHaveBeenLastCalledWith("/usb/package-0002.bundle");
});

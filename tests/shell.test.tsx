import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";
import { api, type Profile } from "../src/api";
import { StepCard, WorkflowNav } from "../src/ui";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../src/ExternalView", () => ({ ExternalView: ({ profile }: { profile: Profile }) => <p>外网工作区：{profile.name}</p> }));
vi.mock("../src/InternalView", () => ({ InternalView: ({ profile }: { profile: Profile }) => <p>内网工作区：{profile.name}</p> }));

const profiles: Profile[] = [
  { id: "orders", name: "订单服务", role: "external", repoName: "order-service", baseBranch: "main", transferDir: "/transfer/orders", mirrorDir: "/mirrors/orders" },
  { id: "platform", name: "基础平台", role: "internal", repoName: "platform", baseBranch: "main", transferDir: "/transfer/platform", mirrorDir: "/mirrors/platform", workDir: "/work/platform" },
];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(api, "loadConfig").mockResolvedValue({ profiles, lastProfileId: "orders" });
  vi.spyOn(api, "saveConfig").mockResolvedValue(undefined);
  vi.spyOn(api, "environment").mockResolvedValue({ os: "macos", git: { Ok: "git version 2.49.0" }, configPath: "/config.json", version: "2.0.1" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("按名称和包名前缀搜索配置，不改变当前工作区", async () => {
  render(<App />);
  const search = await screen.findByRole("textbox", { name: "搜索同步配置" });
  fireEvent.change(search, { target: { value: "PLATFORM" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option", { name: /基础平台/ })).toBeTruthy();
  expect(screen.getByText("外网工作区：订单服务")).toBeTruthy();
  expect(api.saveConfig).not.toHaveBeenCalled();
  fireEvent.change(search, { target: { value: "不存在" } });
  expect(screen.getByText("没有匹配的配置")).toBeTruthy();
  fireEvent.change(search, { target: { value: "订单" } });
  expect(screen.getByRole("option", { name: /订单服务/ }).getAttribute("aria-selected")).toBe("true");
  fireEvent.change(search, { target: { value: "" } });
  expect(screen.getAllByRole("option")).toHaveLength(2);
});

it("收起和展开侧栏时保留搜索和当前配置", async () => {
  render(<App />);
  const search = await screen.findByRole("textbox", { name: "搜索同步配置" });
  fireEvent.change(search, { target: { value: "订单" } });
  fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
  expect(screen.queryByRole("complementary", { name: "工作区导航" })).toBeNull();
  expect(screen.getByRole("button", { name: "展开侧栏" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("外网工作区：订单服务")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
  expect((screen.getByRole("textbox", { name: "搜索同步配置" }) as HTMLInputElement).value).toBe("订单");
  expect(screen.getByRole("button", { name: "收起侧栏" }).getAttribute("aria-expanded")).toBe("true");
});

it("筛选后切换配置会持久化选择并更新顶栏", async () => {
  render(<App />);
  fireEvent.change(await screen.findByRole("textbox", { name: "搜索同步配置" }), { target: { value: "基础" } });
  fireEvent.click(screen.getByRole("option", { name: /基础平台/ }));
  expect(await screen.findByText("内网工作区：基础平台")).toBeTruthy();
  expect(api.saveConfig).toHaveBeenCalledWith({ profiles, lastProfileId: "platform" });
  expect(document.querySelector(".workspace-title")?.textContent).toBe("基础平台内网端");
});

it("编辑时禁用配置切换和设置，取消后可以打开设置", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑配置" }));
  expect((screen.getByRole("button", { name: "新建配置", exact: true }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "打开设置" }) as HTMLButtonElement).disabled).toBe(true);
  for (const option of screen.getAllByRole("option")) expect(option.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "取消", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  expect(screen.getByRole("button", { name: "打开设置" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "保存并重新检测" })).toBeTruthy();
});

it("首次使用可以选择内外网角色创建配置", async () => {
  vi.mocked(api.loadConfig).mockResolvedValue({ profiles: [] });
  render(<App />);
  expect(await screen.findByRole("heading", { name: "从一个同步配置开始" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "新建内网端配置" }));
  await waitFor(() => expect((screen.getByRole("radio", { name: /内网端/ }) as HTMLInputElement).checked).toBe(true));
  expect(screen.getByRole("textbox", { name: "GitLab 仓库地址" })).toBeTruthy();
});

it("流程导航将键盘焦点移动到对应步骤", () => {
  render(<><WorkflowNav steps={["导入内网包", "开发仓库"]} /><StepCard step={2} label="Sync" title="开发仓库">仓库内容</StepCard></>);
  const step = document.getElementById("step-2")!;
  step.scrollIntoView = vi.fn();
  fireEvent.click(within(screen.getByRole("navigation", { name: "同步流程" })).getByRole("link", { name: /2\s*开发仓库/ }));
  expect(step.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  expect(document.activeElement).toBe(step);
});

it("旧配置默认系统主题，保存深色后生效并在重新加载时恢复", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "打开设置" }));
  const trigger = screen.getByRole("button", { name: /主题$/ });
  expect(trigger.textContent).toContain("系统");
  fireEvent.click(trigger);
  expect((await screen.findByRole("option", { name: "系统", exact: true })).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("option", { name: "深色", exact: true }));
  expect(document.documentElement.dataset.theme).toBe("light");
  fireEvent.click(screen.getByRole("button", { name: "保存并重新检测" }));
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
  expect(api.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark", profiles, lastProfileId: "orders" }));
  const saved = vi.mocked(api.saveConfig).mock.calls[0][0];
  cleanup();
  vi.mocked(api.loadConfig).mockResolvedValue(saved);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "打开设置" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(screen.getByRole("button", { name: /主题$/ }).textContent).toContain("深色");
});

it("取消主题修改不保存也不影响当前主题", async () => {
  vi.mocked(api.loadConfig).mockResolvedValue({ profiles, theme: "dark" });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "打开设置" }));
  fireEvent.click(screen.getByRole("button", { name: /主题$/ }));
  fireEvent.click(await screen.findByRole("option", { name: "浅色", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "取消", exact: true }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(api.saveConfig).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  expect(screen.getByRole("button", { name: /主题$/ }).textContent).toContain("深色");
});

it("主题保存失败时保留选择供重试，当前主题不变", async () => {
  vi.mocked(api.saveConfig).mockRejectedValueOnce(new Error("配置不可写"));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "打开设置" }));
  fireEvent.click(screen.getByRole("button", { name: /主题$/ }));
  fireEvent.click(await screen.findByRole("option", { name: "深色", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "保存并重新检测" }));
  expect(await screen.findByText("保存失败，请检查错误提示后重试。")).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(screen.getByRole("button", { name: /主题$/ }).textContent).toContain("深色");
  fireEvent.click(screen.getByRole("button", { name: "保存并重新检测" }));
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
});

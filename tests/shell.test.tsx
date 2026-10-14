import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";
import { api, type Profile } from "../src/api";
import { StepCard, Workflow, WorkflowNav } from "../src/ui";

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
  vi.spyOn(api, "saveConfig").mockResolvedValue(null);
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

it("右上角外观菜单提供浅色、深色和跟随系统，并保存选择", async () => {
  localStorage.clear();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "外观：跟随系统" }));
  expect(await screen.findByRole("menuitemradio", { name: "浅色" })).toBeTruthy();
  expect(screen.getByRole("menuitemradio", { name: "跟随系统" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "深色" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("app-shell-theme")).toBe("dark");
  fireEvent.click(screen.getByRole("button", { name: "外观：深色" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "跟随系统" }));
  expect(localStorage.getItem("app-shell-theme")).toBe("system");
  expect(document.documentElement.dataset.theme).toBe("light");
  localStorage.clear();
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

it("流程页签支持键盘切换，隐藏面板保留输入，导航关联正确", () => {
  render(<Workflow><WorkflowNav steps={["导入内网包", "开发仓库"]} />
    <StepCard step={1} label="Import" title="导入内网包"><input aria-label="包路径" defaultValue="/usb" /></StepCard>
    <StepCard step={2} label="Sync" title="开发仓库">仓库内容</StepCard></Workflow>);
  const tabs = screen.getAllByRole("tab");
  fireEvent.change(screen.getByRole("textbox", { name: "包路径" }), { target: { value: "/changed" } });
  fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
  expect(document.activeElement).toBe(tabs[1]);
  expect(tabs[1].getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel").id).toBe(tabs[1].getAttribute("aria-controls"));
  expect(screen.queryByRole("textbox", { name: "包路径" })).toBeNull();
  fireEvent.keyDown(tabs[1], { key: "Home" });
  expect((screen.getByRole("textbox", { name: "包路径" }) as HTMLInputElement).value).toBe("/changed");
  fireEvent.click(tabs[1]);
  expect(screen.getByRole("tabpanel").textContent).toContain("仓库内容");
});

it("设置不提供主题切换，保存 Git 路径后重新检测环境", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "打开设置" }));
  expect(screen.queryByText("外观", { exact: true })).toBeNull();
  expect(screen.queryByRole("button", { name: /主题$/ })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "git 可执行文件" }), { target: { value: " /custom/git " } });
  fireEvent.click(screen.getByRole("button", { name: "保存并重新检测" }));
  await waitFor(() => expect(api.saveConfig).toHaveBeenCalledWith({ profiles, lastProfileId: "orders", gitPath: "/custom/git" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "保存并重新检测" })).toBeNull());
  expect(api.environment).toHaveBeenCalledTimes(2);
});

it("取消设置修改后保留原 Git 路径", async () => {
  vi.mocked(api.loadConfig).mockResolvedValue({ profiles, gitPath: "/original/git" });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "打开设置" }));
  fireEvent.change(screen.getByRole("textbox", { name: "git 可执行文件" }), { target: { value: "/changed/git" } });
  fireEvent.click(screen.getByRole("button", { name: "取消", exact: true }));
  expect(api.saveConfig).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  expect((screen.getByRole("textbox", { name: "git 可执行文件" }) as HTMLInputElement).value).toBe("/original/git");
});

it("设置保存失败时保留输入供重试", async () => {
  vi.mocked(api.saveConfig).mockRejectedValueOnce(new Error("配置不可写"));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "打开设置" }));
  const path = screen.getByRole("textbox", { name: "git 可执行文件" }) as HTMLInputElement;
  fireEvent.change(path, { target: { value: "/custom/git" } });
  fireEvent.click(screen.getByRole("button", { name: "保存并重新检测" }));
  expect(await screen.findByText("保存失败，请检查错误提示后重试。")).toBeTruthy();
  expect(path.value).toBe("/custom/git");
  fireEvent.click(screen.getByRole("button", { name: "保存并重新检测" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "保存并重新检测" })).toBeNull());
  expect(api.saveConfig).toHaveBeenLastCalledWith({ profiles, lastProfileId: "orders", gitPath: "/custom/git" });
});

it("小屏默认收起侧栏，抽屉限制焦点，Escape 关闭并恢复焦点，选择配置后关闭", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(max-width: 1023px)", media: query, addEventListener() {}, removeEventListener() {} }));
  render(<App />);
  const toggle = await screen.findByRole("button", { name: "展开侧栏" });
  expect(screen.queryByRole("dialog", { name: "工作区导航" })).toBeNull();
  fireEvent.click(toggle);
  const drawer = screen.getByRole("dialog", { name: "工作区导航" });
  const close = screen.getByRole("button", { name: "关闭侧栏", exact: true });
  expect(drawer.getAttribute("aria-modal")).toBe("true");
  expect(document.activeElement).toBe(close);
  expect(document.getElementById("main-content")?.hasAttribute("inert")).toBe(true);
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "打开设置" }));
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(drawer, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "工作区导航" })).toBeNull();
  expect(document.activeElement).toBe(toggle);
  expect(document.getElementById("main-content")?.hasAttribute("inert")).toBe(false);
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("option", { name: /基础平台/ }));
  expect(await screen.findByText("内网工作区：基础平台")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "工作区导航" })).toBeNull();
});

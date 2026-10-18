import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";
import { api, type Profile } from "../src/api";
import { StepCard, Workflow, WorkflowNav } from "../src/ui";
import { useRunner } from "../src/runner";

const operation = vi.hoisted(() => ({ run: vi.fn<() => Promise<void>>() }));
const nativeWindow = vi.hoisted(() => ({
  onResized: vi.fn(async () => () => {}), isMaximized: vi.fn(async () => false),
  minimize: vi.fn(async () => {}), toggleMaximize: vi.fn(async () => {}), close: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => nativeWindow }));

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../src/BackgroundScene", () => ({ BackgroundScene: () => null }));
vi.mock("../src/ExternalView", () => ({ ExternalView: ({ profile }: { profile: Profile }) => {
  const { run } = useRunner();
  return <><p>外网工作区：{profile.name}</p><input aria-label="工作区输入" defaultValue="" />
    <button onClick={() => void run("同步更新", operation.run)}>执行同步</button></>;
} }));
vi.mock("../src/InternalView", () => ({ InternalView: ({ profile }: { profile: Profile }) => <p>内网工作区：{profile.name}</p> }));

const profiles: Profile[] = [
  { id: "orders", name: "订单服务", role: "external", repoName: "order-service", baseBranch: "main", transferDir: "/transfer/orders", mirrorDir: "/mirrors/orders" },
  { id: "platform", name: "基础平台", role: "internal", repoName: "platform", baseBranch: "main", transferDir: "/transfer/platform", mirrorDir: "/mirrors/platform", workDir: "/work/platform" },
];

beforeEach(() => {
  operation.run.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(api, "loadConfig").mockResolvedValue({ profiles, lastProfileId: "orders" });
  vi.spyOn(api, "saveConfig").mockResolvedValue(null);
  vi.spyOn(api, "environment").mockResolvedValue({ os: "macos", git: { Ok: "git version 2.49.0" }, configPath: "/config.json", version: "2.0.1" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("Windows 顶栏可拖动，打开设置后仍可操作窗口按钮", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  render(<App />);
  expect(screen.getByRole("banner").getAttribute("data-tauri-drag-region")).toBe("deep");
  expect(document.querySelector(".titlebar-drag")).toBeNull();
  expect(screen.getByRole("group", { name: "窗口控制" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "打开设置" }));
  expect(await screen.findByRole("dialog", { name: "设置" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "最小化窗口" }));
  expect(nativeWindow.minimize).toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
});

it("macOS 保留原生控制区，不显示 Windows 窗口按钮", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
  render(<App />);
  await screen.findByRole("button", { name: "打开设置" });
  expect(document.querySelector(".titlebar-drag")).toBeTruthy();
  expect(screen.queryByRole("group", { name: "窗口控制" })).toBeNull();
});

it("项目菜单列出全部项目，当前项目可辨认", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "选择项目：订单服务" }));
  expect(await screen.findByRole("menuitem", { name: /订单服务/ })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: /基础平台/ })).toBeTruthy();
  expect(within(screen.getByRole("menuitem", { name: /订单服务/ })).getByText("当前")).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "新建内网端配置" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "新建外网端配置" })).toBeTruthy();
  expect(api.saveConfig).not.toHaveBeenCalled();
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

it("默认不展示侧栏、搜索和日志，记录按需打开并能用 Escape 收起", async () => {
  render(<App />);
  const records = await screen.findByRole("button", { name: "查看记录" });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "搜索同步配置" })).toBeNull();
  expect(screen.queryByRole("region", { name: "命令日志" })).toBeNull();
  fireEvent.click(records);
  expect(screen.getByRole("region", { name: "命令日志" })).toBeTruthy();
  const logToggle = screen.getByRole("button", { name: "命令日志" });
  logToggle.focus();
  fireEvent.keyDown(logToggle, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "命令日志" })).toBeNull();
  expect(document.activeElement).toBe(records);
});

it("从项目菜单切换项目会持久化选择并更新顶栏", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "选择项目：订单服务" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /基础平台/ }));
  expect(await screen.findByText("内网工作区：基础平台")).toBeTruthy();
  expect(api.saveConfig).toHaveBeenCalledWith({ profiles, lastProfileId: "platform" });
  expect(screen.getByRole("button", { name: "选择项目：基础平台" })).toBeTruthy();
  expect(screen.getByText("内网端")).toBeTruthy();
});

it("配置在模态中编辑，取消后返回原工作区并可打开设置", async () => {
  render(<App />);
  const input = await screen.findByRole("textbox", { name: "工作区输入" });
  fireEvent.change(input, { target: { value: "未完成的选择" } });
  const projectButton = screen.getByRole("button", { name: "选择项目：订单服务" });
  const settingsButton = screen.getByRole("button", { name: "打开设置" });
  fireEvent.click(projectButton);
  fireEvent.click(await screen.findByRole("menuitem", { name: "编辑当前项目" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑同步配置" });
  expect((projectButton as HTMLButtonElement).disabled).toBe(true);
  expect((settingsButton as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "取消", exact: true }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑同步配置" })).toBeNull());
  expect((screen.getByRole("textbox", { name: "工作区输入" }) as HTMLInputElement).value).toBe("未完成的选择");
  fireEvent.click(settingsButton);
  expect(await screen.findByRole("dialog", { name: "设置" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "保存并重新检测" })).toBeTruthy();
});

it("首次使用可以选择内外网角色创建配置", async () => {
  vi.mocked(api.loadConfig).mockResolvedValue({ profiles: [] });
  render(<App />);
  expect(await screen.findByText("选择当前电脑的角色，配置仓库和传输目录。")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "同步流程说明" })).toBeNull();
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
  act(() => tabs[0].focus());
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
  const discard = await screen.findByRole("alertdialog");
  fireEvent.click(within(discard).getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  expect((screen.getByRole("textbox", { name: "git 可执行文件" }) as HTMLInputElement).value).toBe("/original/git");
});

it("设置 Escape 关闭先确认未保存修改，继续编辑保留输入", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "打开设置" }));
  const input = screen.getByRole("textbox", { name: "git 可执行文件" });
  fireEvent.change(input, { target: { value: "/draft/git" } });
  act(() => input.focus());
  fireEvent.keyDown(input, { key: "Escape" });
  const discard = await screen.findByRole("alertdialog");
  fireEvent.click(within(discard).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "git 可执行文件" }).value).toBe("/draft/git");
  expect(api.saveConfig).not.toHaveBeenCalled();
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

it("项目切换保存失败时保留原项目，重新选择可以重试", async () => {
  vi.mocked(api.saveConfig).mockRejectedValueOnce(new Error("配置不可写"));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "选择项目：订单服务" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /基础平台/ }));
  expect(await screen.findByText("保存配置失败：Error: 配置不可写")).toBeTruthy();
  expect(screen.getByText("外网工作区：订单服务")).toBeTruthy();
  expect(screen.queryByText("内网工作区：基础平台")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "选择项目：订单服务" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /基础平台/ }));
  expect(await screen.findByText("内网工作区：基础平台")).toBeTruthy();
  expect(api.saveConfig).toHaveBeenCalledTimes(2);
});

it("配置保存失败时保留模态和填写内容，重试成功后返回工作区", async () => {
  vi.mocked(api.saveConfig).mockRejectedValueOnce(new Error("配置不可写"));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "选择项目：订单服务" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "编辑当前项目" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑同步配置" });
  const name = within(dialog).getByRole("textbox", { name: "名称" }) as HTMLInputElement;
  fireEvent.change(name, { target: { value: "订单新版" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存", exact: true }));
  expect(await screen.findByText("保存失败，请检查错误提示后重试。填写内容已保留。")).toBeTruthy();
  expect(name.value).toBe("订单新版");
  expect(screen.getByRole("dialog", { name: "编辑同步配置" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "保存", exact: true }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑同步配置" })).toBeNull());
  expect(screen.getByText("外网工作区：订单新版")).toBeTruthy();
  expect(api.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({
    profiles: [expect.objectContaining({ id: "orders", name: "订单新版" }), profiles[1]], lastProfileId: "orders",
  }));
});

it("配置模态 Escape 复用未保存修改确认，放弃后恢复项目入口焦点", async () => {
  render(<App />);
  const project = await screen.findByRole("button", { name: "选择项目：订单服务" });
  project.focus();
  fireEvent.click(project);
  fireEvent.click(await screen.findByRole("menuitem", { name: "编辑当前项目" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑同步配置" });
  const name = within(dialog).getByRole("textbox", { name: "名称" });
  fireEvent.change(name, { target: { value: "未保存名称" } });
  name.focus();
  fireEvent.keyDown(name, { key: "Escape" });
  const discard = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
  fireEvent.click(within(discard).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" })).toBeNull());
  expect((name as HTMLInputElement).value).toBe("未保存名称");
  fireEvent.keyDown(name, { key: "Escape" });
  fireEvent.click(await screen.findByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑同步配置" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(project));
  expect(api.saveConfig).not.toHaveBeenCalled();
});

it("项目删除仍需确认，取消保留配置，确认后返回剩余项目", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "选择项目：订单服务" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "编辑当前项目" }));
  const editor = await screen.findByRole("dialog", { name: "编辑同步配置" });
  fireEvent.click(within(editor).getByRole("button", { name: "删除配置" }));
  const confirm = await screen.findByRole("alertdialog", { name: "删除配置“订单服务”" });
  fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "删除配置“订单服务”" })).toBeNull());
  expect(api.saveConfig).not.toHaveBeenCalled();
  fireEvent.click(within(editor).getByRole("button", { name: "删除配置" }));
  fireEvent.click(await screen.findByRole("button", { name: "删除", exact: true }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑同步配置" })).toBeNull());
  expect(screen.getByText("内网工作区：基础平台")).toBeTruthy();
  expect(api.saveConfig).toHaveBeenCalledWith({ profiles: [profiles[1]], lastProfileId: "platform" });
});

it("操作中禁用项目和设置，失败由状态栏提示且不自动展开日志", async () => {
  let fail!: (error: Error) => void;
  operation.run.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "执行同步" }));
  const project = screen.getByRole("button", { name: "选择项目：订单服务" }) as HTMLButtonElement;
  const settings = screen.getByRole("button", { name: "打开设置" }) as HTMLButtonElement;
  expect(project.disabled).toBe(true);
  expect(settings.disabled).toBe(true);
  expect(screen.getByText("正在同步更新，请稍候…")).toBeTruthy();
  await act(async () => { fail(new Error("仓库不可读")); });
  expect(await screen.findByText("同步更新失败：Error: 仓库不可读")).toBeTruthy();
  expect(screen.getByText("同步更新 · 失败")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "命令日志" })).toBeNull();
  expect(project.disabled).toBe(false);
  expect(settings.disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "查看记录" }));
  expect(screen.getByRole("region", { name: "命令日志" })).toBeTruthy();
  expect(screen.getByText("有错误")).toBeTruthy();
});

it("配置读取失败可以重试，并保留 Git 不可用提示", async () => {
  vi.mocked(api.loadConfig).mockRejectedValueOnce(new Error("配置损坏"));
  vi.mocked(api.environment).mockResolvedValue({ os: "macos", git: { Err: "找不到 git" }, configPath: "/config.json", version: "2.0.1" });
  render(<App />);
  expect(await screen.findByText("无法读取同步配置")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新读取配置" }));
  expect(await screen.findByText("外网工作区：订单服务")).toBeTruthy();
  expect(screen.getByText("找不到可用的 git")).toBeTruthy();
});

it("项目菜单可直接新建外网配置，取消后回到原项目", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "选择项目：订单服务" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "新建外网端配置" }));
  const dialog = await screen.findByRole("dialog", { name: "新建同步配置" });
  expect((within(dialog).getByRole("radio", { name: /外网端/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建同步配置" })).toBeNull());
  expect(screen.getByText("外网工作区：订单服务")).toBeTruthy();
  expect(api.saveConfig).not.toHaveBeenCalled();
});

it("设置模态 Escape 关闭并恢复入口焦点", async () => {
  render(<App />);
  const settings = await screen.findByRole("button", { name: "打开设置" });
  await waitFor(() => expect((settings as HTMLButtonElement).disabled).toBe(false));
  settings.focus();
  fireEvent.click(settings);
  const dialog = await screen.findByRole("dialog", { name: "设置" });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(settings));
  expect(api.saveConfig).not.toHaveBeenCalled();
});

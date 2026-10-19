import { useMemo, useState, type ReactNode } from "react";
import { Button, EmptyState, Input, Label, ListBox, Pagination, Select, TextField } from "@heroui/react";
import { formatTime, type ReturnPackageInfo } from "./api";

const PAGE_SIZE = 20;
type PackageFilter = "pending" | "received" | "all";

function packageStatus(pkg: ReturnPackageInfo, issue: string | null) {
  if (!issue) return pkg.received ? "已接收" : "待接收";
  if (!pkg.payloadExists) return "文件缺失";
  return pkg.error ? "包内容异常" : "其他项目";
}

/** 只渲染当前页与一个详情区，大量历史包不会挤走后续的审查操作。 */
export function ReturnPackageInbox({ packages, disabled, getIssue, renderDetails }: {
  packages: ReturnPackageInfo[];
  disabled: boolean;
  getIssue: (pkg: ReturnPackageInfo) => string | null;
  renderDetails: (pkg: ReturnPackageInfo) => ReactNode;
}) {
  const [filter, setFilter] = useState<PackageFilter>("pending");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const rows = useMemo(() => packages.map((pkg) => {
    const name = pkg.payloadPath.split(/[\\/]/).pop() || pkg.payloadPath;
    const branches = pkg.manifest?.refs.map((ref) => ref.name.replace(/^refs\/heads\//, "")) ?? [];
    return { pkg, name, branches, search: [pkg.payloadPath, pkg.manifest?.seq, pkg.manifest?.repoName, ...branches].join(" ").toLowerCase() };
  }).sort((a, b) => (b.pkg.manifest?.createdAt ?? 0) - (a.pkg.manifest?.createdAt ?? 0)
    || (b.pkg.manifest?.seq ?? 0) - (a.pkg.manifest?.seq ?? 0)
    || a.pkg.payloadPath.localeCompare(b.pkg.payloadPath)), [packages]);
  const term = query.trim().toLowerCase();
  const filtered = useMemo(() => rows.filter(({ pkg, search }) =>
    (filter === "all" || pkg.received === (filter === "received")) && (!term || search.includes(term))), [rows, filter, term]);
  const pendingCount = packages.filter((pkg) => !pkg.received).length;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selected = visible.find(({ pkg }) => pkg.payloadPath === picked) ?? visible[0];
  function changeFilter(value: PackageFilter) { setFilter(value); setPage(0); setPicked(null); }

  return <section className="return-inbox" aria-label="回传包收件箱">
    <div className="return-inbox-tools">
      <div className="return-inbox-heading"><h2>回传包</h2><span>{pendingCount} 个待接收 · {packages.length - pendingCount} 个已接收</span></div>
      <TextField value={query} onChange={(value) => { setQuery(value); setPage(0); setPicked(null); }} isDisabled={disabled}>
        <Label className="sr-only">搜索回传包</Label><Input placeholder="搜索文件名、分支或序号" autoComplete="off" className="font-mono text-[13px]" />
      </TextField>
      <Select value={filter} isDisabled={disabled} onChange={(value) => {
        if (value === "pending" || value === "received" || value === "all") changeFilter(value);
      }}>
        <Label className="sr-only">接收状态</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover><ListBox>
          <ListBox.Item id="pending" textValue="待接收">待接收（{pendingCount}）<ListBox.ItemIndicator /></ListBox.Item>
          <ListBox.Item id="received" textValue="已接收">已接收（{packages.length - pendingCount}）<ListBox.ItemIndicator /></ListBox.Item>
          <ListBox.Item id="all" textValue="全部">全部（{packages.length}）<ListBox.ItemIndicator /></ListBox.Item>
        </ListBox></Select.Popover>
      </Select>
    </div>
    {selected ? <div className="return-inbox-body">
      <div className="return-inbox-list-pane">
        <ListBox className="return-inbox-list" aria-label="回传包列表" selectionMode="single" disallowEmptySelection
          selectedKeys={[selected.pkg.payloadPath]} disabledKeys={disabled ? visible.map(({ pkg }) => pkg.payloadPath) : []}
          onSelectionChange={(keys) => { if (keys !== "all") setPicked(String([...keys][0] ?? "")); }}>
          {visible.map(({ pkg, name, branches }) => {
            const issue = getIssue(pkg);
            return <ListBox.Item key={pkg.payloadPath} id={pkg.payloadPath} className="return-package-item"
              textValue={`${pkg.manifest?.seq ?? ""} ${name} ${branches.join(" ")}`}>
              <div className="return-package-copy">
                <div className="return-package-title"><span className="return-package-name" title={`${name}${pkg.manifest ? ` · ${formatTime(pkg.manifest.createdAt)}` : ""}`}>{name}</span>
                  <span className="return-package-seq">{pkg.manifest ? `#${pkg.manifest.seq}` : "无清单"}</span></div>
                <div className="return-package-meta"><span title={branches.join("、")}>{branches[0] || "未标注分支"}{branches.length > 1 ? ` 等 ${branches.length} 个分支` : ""}</span>
                  <span data-issue={!!issue}>{packageStatus(pkg, issue)}</span></div>
              </div><ListBox.ItemIndicator />
            </ListBox.Item>;
          })}
        </ListBox>
        <Pagination className="return-inbox-pagination" aria-label="回传包分页" size="sm">
          <Pagination.Summary role="status">{currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} / {filtered.length}</Pagination.Summary>
          <Pagination.Content>
            <Pagination.Item><Pagination.Previous aria-label="上一页" isDisabled={disabled || currentPage === 0} onPress={() => { setPage(currentPage - 1); setPicked(null); }}>上一页</Pagination.Previous></Pagination.Item>
            <Pagination.Item><Pagination.Next aria-label="下一页" isDisabled={disabled || currentPage + 1 >= pageCount} onPress={() => { setPage(currentPage + 1); setPicked(null); }}>下一页</Pagination.Next></Pagination.Item>
          </Pagination.Content>
        </Pagination>
      </div>
      <section className="return-inbox-detail" aria-label="选中的回传包">{renderDetails(selected.pkg)}</section>
    </div> : <EmptyState className="return-inbox-empty" role="status">
      <p>{term ? "没有匹配的回传包。" : filter === "received" ? "还没有已接收的包。" : "没有待接收的包。"}</p>
      {term ? <Button size="sm" variant="secondary" isDisabled={disabled} onPress={() => { setQuery(""); setPage(0); }}>清除搜索</Button>
        : filter === "pending" && packages.length > 0 ? <Button size="sm" variant="secondary" isDisabled={disabled} onPress={() => changeFilter("received")}>查看已接收的包</Button> : null}
    </EmptyState>}
  </section>;
}

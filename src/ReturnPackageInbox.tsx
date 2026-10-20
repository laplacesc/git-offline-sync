import { useMemo, useState, type ReactNode } from "react";
import { Button, EmptyState, Input, Label, Pagination, TextField } from "@heroui/react";
import { formatTime, type ReturnPackageInfo } from "./api";

const PAGE_SIZE = 20;

/** 每个回传包独立操作，搜索覆盖全部分页，导入后仍可重复使用。 */
export function ReturnPackageInbox({ packages, disabled, renderDetails }: {
  packages: ReturnPackageInfo[];
  disabled: boolean;
  renderDetails: (pkg: ReturnPackageInfo) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const rows = useMemo(() => packages.map((pkg) => {
    const name = pkg.payloadPath.split(/[\\/]/).pop() || pkg.payloadPath;
    const branches = pkg.manifest?.refs.map((ref) => ref.name.replace(/^refs\/heads\//, "")) ?? [];
    return { pkg, name, branches, search: [pkg.payloadPath, pkg.manifest?.seq, pkg.manifest?.repoName, ...branches].join(" ").toLowerCase() };
  }).sort((a, b) => (b.pkg.manifest?.createdAt ?? 0) - (a.pkg.manifest?.createdAt ?? 0)
    || (b.pkg.manifest?.seq ?? 0) - (a.pkg.manifest?.seq ?? 0)
    || a.pkg.payloadPath.localeCompare(b.pkg.payloadPath)), [packages]);
  const term = query.trim().toLowerCase();
  const filtered = useMemo(() => rows.filter(({ search }) => !term || search.includes(term)), [rows, term]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return <section className="return-inbox" aria-label="回传包收件箱">
    <div className="return-inbox-tools">
      <TextField value={query} onChange={(value) => { setQuery(value); setPage(0); }} isDisabled={disabled}>
        <Label className="sr-only">搜索回传包</Label><Input placeholder="搜索文件名、分支或序号" autoComplete="off" className="font-mono text-[13px]" />
      </TextField>
      <span className="return-inbox-count" role="status">{filtered.length} 个回传包</span>
    </div>
    {visible.length > 0 ? <>
      <ul className="return-inbox-list" aria-label="回传包列表">
        {visible.map(({ pkg, name, branches }) => <li key={pkg.payloadPath} className="return-package-item" aria-label={name}>
          <span className="return-package-seq">{pkg.manifest ? `#${pkg.manifest.seq}` : "—"}</span>
          <div className="return-package-copy">
            <div className="return-package-title"><span className="return-package-name" title={branches.join("、") || name}>{branches[0] || name}{branches.length > 1 ? ` 等 ${branches.length} 个分支` : ""}</span></div>
            <div className="return-package-meta"><span title={name}>{name}</span>{pkg.manifest && <time>{formatTime(pkg.manifest.createdAt)}</time>}</div>
          </div>
          {renderDetails(pkg)}
        </li>)}
      </ul>
      {pageCount > 1 && <Pagination className="return-inbox-pagination" aria-label="回传包分页" size="sm">
        <Pagination.Summary role="status">{currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} / {filtered.length}</Pagination.Summary>
        <Pagination.Content>
          <Pagination.Item><Pagination.Previous aria-label="上一页" isDisabled={disabled || currentPage === 0} onPress={() => setPage(currentPage - 1)}>上一页</Pagination.Previous></Pagination.Item>
          <Pagination.Item><Pagination.Next aria-label="下一页" isDisabled={disabled || currentPage + 1 >= pageCount} onPress={() => setPage(currentPage + 1)}>下一页</Pagination.Next></Pagination.Item>
        </Pagination.Content>
      </Pagination>}
    </> : <EmptyState className="return-inbox-empty" role="status">
      <p>{term ? "没有匹配的回传包。" : "没有回传包。"}</p>
      {term && <Button size="sm" variant="secondary" isDisabled={disabled} onPress={() => { setQuery(""); setPage(0); }}>清除搜索</Button>}
    </EmptyState>}
  </section>;
}

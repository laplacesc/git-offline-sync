import { useId, useMemo, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "./components/ui/button";
import { Empty } from "./components/ui/empty";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Pagination, PaginationContent, PaginationItem } from "./components/ui/pagination";
import { formatTime, type PackageInfo } from "./api";

const PAGE_SIZE = 20;
const COLLAPSED_SIZE = 5;

/** 默认显示最新五个包，展开后分页，搜索始终覆盖全部包。 */
export function PackageInbox<T extends PackageInfo>({ packages, disabled, renderDetails, packageLabel = "回传包" }: {
  packages: T[];
  disabled: boolean;
  renderDetails: (pkg: T) => ReactNode;
  packageLabel?: string;
}) {
  const searchId = useId();
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const rows = useMemo(() => packages.map((pkg) => {
    const name = pkg.payloadPath.split(/[\\/]/).pop() || pkg.payloadPath;
    const branches = pkg.manifest?.refs.map((ref) => ref.name.replace(/^refs\/heads\//, "")) ?? [];
    let title = branches[0] || name;
    if (branches.length > 1) title += ` 等 ${branches.length} 个分支`;
    if (pkg.manifest?.kind === "full") title = "全量更新";
    if (pkg.manifest?.kind === "incr") title = "增量更新";
    return { pkg, name, branches, title, search: [pkg.payloadPath, pkg.manifest?.seq, pkg.manifest?.repoName, ...branches].join(" ").toLowerCase() };
  }).sort((a, b) => (b.pkg.manifest?.createdAt ?? 0) - (a.pkg.manifest?.createdAt ?? 0)
    || (b.pkg.manifest?.seq ?? 0) - (a.pkg.manifest?.seq ?? 0)
    || a.pkg.payloadPath.localeCompare(b.pkg.payloadPath)), [packages]);
  const term = query.trim().toLowerCase();
  const filtered = useMemo(() => rows.filter(({ search }) => !term || search.includes(term)), [rows, term]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = expanded ? Math.min(page, pageCount - 1) : 0;
  const visible = expanded
    ? filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
    : filtered.slice(0, COLLAPSED_SIZE);

  return <section className="return-inbox" aria-label={`${packageLabel}收件箱`}>
    <div className="return-inbox-tools">
      <div>
        <Label htmlFor={searchId} className="sr-only">搜索{packageLabel}</Label>
        <Input id={searchId} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} disabled={disabled}
          placeholder="搜索文件名、分支或序号" autoComplete="off" />
      </div>
      <span className="return-inbox-count" role="status">{filtered.length} 个{packageLabel}</span>
    </div>
    {visible.length > 0 ? <>
      <ul id={listId} className="return-inbox-list" aria-label={`${packageLabel}列表`}>
        {visible.map(({ pkg, name, branches, title }) => <li key={pkg.payloadPath} className="return-package-item" aria-label={name}>
          <span className="return-package-seq">{pkg.manifest ? `#${pkg.manifest.seq}` : "—"}</span>
          <div className="return-package-copy">
            <div className="return-package-title"><span className="return-package-name" title={branches.join("、") || name}>
              {title}
            </span></div>
            <div className="return-package-meta"><span title={name}>{name}</span>{pkg.manifest && <time>{formatTime(pkg.manifest.createdAt)}</time>}</div>
          </div>
          {renderDetails(pkg)}
        </li>)}
      </ul>
      {expanded && pageCount > 1 && <Pagination className="return-inbox-pagination" aria-label={`${packageLabel}分页`}>
        <span role="status">{currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} / {filtered.length}</span>
        <PaginationContent>
          <PaginationItem><Button size="sm" variant="outline" aria-label="上一页" disabled={disabled || currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button></PaginationItem>
          <PaginationItem><Button size="sm" variant="outline" aria-label="下一页" disabled={disabled || currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</Button></PaginationItem>
        </PaginationContent>
      </Pagination>}
      {filtered.length > COLLAPSED_SIZE && <Button className="mt-3 w-full" size="sm" variant="ghost" disabled={disabled}
        aria-expanded={expanded} aria-controls={listId} onClick={() => { setExpanded(!expanded); setPage(0); }}>
        {expanded ? <ChevronUpIcon aria-hidden="true" /> : <ChevronDownIcon aria-hidden="true" />}
        {expanded ? "收起" : `展开其余 ${filtered.length - COLLAPSED_SIZE} 个${packageLabel}`}
      </Button>}
    </> : <Empty className="return-inbox-empty" role="status">
      <p>{term ? `没有匹配的${packageLabel}。` : `没有${packageLabel}。`}</p>
      {term && <Button size="sm" variant="secondary" disabled={disabled} onClick={() => { setQuery(""); setPage(0); }}>清除搜索</Button>}
    </Empty>}
  </section>;
}

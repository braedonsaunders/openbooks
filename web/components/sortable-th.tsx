import Link from 'next/link'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { cn, TableHead } from '@openbooks/ui'
import { mergeHref } from '@/lib/list-params'

type SortLinkProps = {
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  column: string
  active: boolean
  dir: 'asc' | 'desc'
  align?: 'left' | 'right'
  sortParamKey?: string
  dirParamKey?: string
  pageParamKey?: string
  children: React.ReactNode
}

/**
 * The clickable label shared by both header variants: renders the column name
 * plus a sort-direction caret and links to the toggled sort URL. Clicking an
 * inactive column sorts ascending; clicking the active column flips direction.
 * Page always resets to 1 so you don't land on an empty trailing page.
 */
function SortLink({
  basePath,
  currentParams,
  column,
  active,
  dir,
  align = 'left',
  sortParamKey = 'sort',
  dirParamKey = 'dir',
  pageParamKey = 'page',
  children,
}: SortLinkProps) {
  const nextDir: 'asc' | 'desc' = active && dir === 'asc' ? 'desc' : 'asc'
  const href = mergeHref(basePath, currentParams, {
    [sortParamKey]: column,
    [dirParamKey]: nextDir,
    [pageParamKey]: 1,
  })
  return (
    <Link
      href={(href)}
      className={cn(
        'inline-flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-slate-100',
        align === 'right' && 'flex-row-reverse',
      )}
    >
      {children}
      {active ? (
        dir === 'asc' ? (
          <ArrowUp size={12} className="text-slate-700 dark:text-slate-200" />
        ) : (
          <ArrowDown size={12} className="text-slate-700 dark:text-slate-200" />
        )
      ) : (
        <ArrowUpDown size={12} className="text-slate-300" />
      )}
    </Link>
  )
}

/**
 * The sortable column header.
 *
 * ONE component, deliberately. There used to be two — `SortableTh`, which
 * wrapped the shared `TableHead`, and `SortTh`, which emitted a bare
 * `<th className="px-3 py-2">`. Both were ported from another app together
 * with doc comments naming pages ("hazard assessments", "corrective actions")
 * that do not exist here, and the bare variant's stated justification — that
 * it sits beside plain `<th>` cells in raw tables — did not hold: its callers
 * were using the `@openbooks/ui` Table primitives, whose header cell IS
 * `TableHead`.
 *
 * The result was a measurable defect on twelve pages: within one header row,
 * sortable columns rendered 14px, sentence case and near-black while their
 * non-sortable neighbours rendered 12px, uppercase, tracked and muted. Not a
 * design choice — a header that forgot to be a header.
 *
 * `active` is derived from `sort` so callers thread the current sort through
 * once rather than computing it per column.
 */
export function SortTh({
  sort,
  className,
  ...props
}: Omit<SortLinkProps, 'active'> & { sort: string; className?: string }) {
  return (
    <TableHead className={className}>
      <SortLink {...props} active={sort === props.column} />
    </TableHead>
  )
}

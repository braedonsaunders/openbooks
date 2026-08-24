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
 * Sortable header for tables built from the @openbooks/ui <Table> primitives
 * (hazard assessments, inspections, kiosk history). Caller passes `active`.
 */
export function SortableTh({ className, ...props }: SortLinkProps & { className?: string }) {
  return (
    <TableHead className={className}>
      <SortLink {...props} />
    </TableHead>
  )
}

/**
 * Sortable header for the raw `<table>` record lists (corrective actions,
 * incidents, people, …). Renders a plain `<th className="px-3 py-2">` so it
 * drops in next to the existing non-sortable `<th>` cells, and derives `active`
 * from the current `sort` so callers only thread `sort`/`dir` through once.
 */
export function SortTh({
  sort,
  className,
  ...props
}: Omit<SortLinkProps, 'active'> & { sort: string; className?: string }) {
  return (
    <th className={cn('px-3 py-2', className)}>
      <SortLink {...props} active={sort === props.column} />
    </th>
  )
}

'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Plus, Search } from 'lucide-react'
import { Button, Input } from '@openbooks/ui'

/**
 * The single composition for a record-drawer tab that lists child records.
 *
 * Every child list in a drawer reads the same way: the heading on the left
 * with the one add action pinned top right (it never wraps under a long
 * description), a toolbar whose search stretches across the full drawer
 * width with any filters beside it, the full-width table, then the count and
 * pager. Add actions open a child drawer; lists never grow inline add rows.
 */
export function DrawerSublist({
  title,
  description,
  icon,
  action,
  alert,
  search,
  filters,
  footer,
  children,
}: {
  title: string
  description?: ReactNode
  icon?: ReactNode
  /** The one add action, rendered top right. */
  action?: ReactNode
  /** Refusals and notices that belong to the list as a whole. */
  alert?: ReactNode
  /** Full-width search over the list. */
  search?: { value: string; onChange: (value: string) => void; placeholder: string; label?: string }
  /** Filter controls rendered beside the search on the same toolbar row. */
  filters?: ReactNode
  /** Count and pager beneath the table. */
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-3" data-drawer-sublist="">
      <div className="flex items-start justify-between gap-3">
        <SublistHeading title={title} description={description} icon={icon} />
        {action ? <div className="shrink-0" data-sublist-action="">{action}</div> : null}
      </div>
      {alert}
      {search || filters ? (
        <div className="flex w-full flex-wrap gap-2" data-sublist-toolbar="">
          {search ? (
            <div className="relative min-w-56 flex-1" data-sublist-search="">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" size={15} />
              <Input
                value={search.value}
                onChange={(event) => search.onChange(event.target.value)}
                placeholder={search.placeholder}
                aria-label={search.label ?? search.placeholder}
                className="w-full pl-8"
              />
            </div>
          ) : null}
          {filters}
        </div>
      ) : null}
      {children}
      {footer}
    </section>
  )
}

export function SublistHeading({ title, description, icon }: { title: string; description?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{icon}{title}</h3>
      {description ? <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p> : null}
    </div>
  )
}

/** The top-right add action of a drawer sublist. */
export function SublistAddButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="outline" size="sm" disabled={disabled} onClick={onClick}>
      <Plus size={14} />{label}
    </Button>
  )
}

/**
 * The empty composition of a sublist. A remedy names what to do next and,
 * where the viewer can do it, carries the action that does it.
 */
export function SublistEmpty({ icon, text, hint, action }: { icon?: ReactNode; text: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-slate-400 dark:border-slate-700 dark:text-slate-500" data-sublist-empty="">
      {icon}
      <p className="text-sm">{text}</p>
      {hint ? <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  )
}

export function SublistLoading() {
  return <div className="h-48 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" aria-busy="true" />
}

/** A real load failure: the server's reason and a retry. */
export function SublistLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const tc = useTranslations('common')
  return (
    <div className="space-y-2 rounded-lg border border-rose-200 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950/30">
      <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>{tc('actions.retry')}</Button>
    </div>
  )
}

/** Count on the left, pager on the right. */
export function SublistPager({
  count,
  page,
  pages,
  onPage,
  disabled,
}: {
  count?: ReactNode
  page: number
  pages: number
  onPage: (page: number) => void
  disabled?: boolean
}) {
  const tc = useTranslations('common')
  if (pages <= 1 && count == null) return null
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-slate-500 dark:text-slate-400">{count}</span>
      {pages > 1 ? (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>{tc('actions.previous')}</Button>
          <span className="text-xs tabular-nums text-slate-500">{page} / {pages}</span>
          <Button variant="outline" size="sm" disabled={disabled || page >= pages} onClick={() => onPage(page + 1)}>{tc('actions.next')}</Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Client-side search and paging for a sublist whose rows are already loaded.
 * A new query restarts at the first page.
 */
export function useSublistRows<Row>(rows: readonly Row[], text: (row: Row) => string, perPage = 10) {
  const [query, setQueryState] = useState('')
  const [page, setPage] = useState(1)
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return [...rows]
    return rows.filter((row) => text(row).toLocaleLowerCase().includes(needle))
  }, [query, rows, text])
  const pages = Math.max(1, Math.ceil(filtered.length / perPage))
  const current = Math.min(page, pages)
  return {
    query,
    setQuery: (value: string) => {
      setQueryState(value)
      setPage(1)
    },
    filtered,
    shown: filtered.slice((current - 1) * perPage, current * perPage),
    page: current,
    pages,
    setPage,
  }
}

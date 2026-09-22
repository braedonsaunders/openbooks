import type { ReactNode } from 'react'
import { SearchInput } from './search-input'
import { DateParamFilter, FilterChips } from './filter-bar'

export type ListToolbarFilter = {
  paramKey: string
  label: string
  options: { value: string; label: string; count?: number }[]
  allLabel?: string
  defaultValue?: string
  hideAll?: boolean
}

/**
 * The list toolbar — one row, search first, then filters, in the order the
 * house list already uses (EntityListView renders exactly this shape:
 * `flex flex-wrap items-center gap-2`, SearchInput, then FilterChips).
 *
 * It exists because the registry-backed lists got that row for free and the
 * hand-built ones did not, so an HRM list page rendered a single unlabelled
 * dropdown floating above a bare table while /entities/employees a tab away
 * had search, filters and saved views. Same page archetype, two different
 * products. The rows those pages list are not document record types — the
 * org chart's loader says why — so they cannot join RecordListView; they can
 * share its toolbar, and now do.
 *
 * `extra` is for the one-off control a page genuinely owns (an as-of date
 * picker). It renders INSIDE the row, so a page still cannot start a second
 * toolbar underneath this one.
 */
export function ListToolbar({
  basePath,
  currentParams,
  search,
  filters = [],
  date,
  extra,
}: {
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  search?: { paramKey?: string; placeholder: string } | null
  filters?: ListToolbarFilter[]
  /** An as-of date the whole list is read at. Rendered with the filters. */
  date?: { paramKey: string; label: string; max?: string; resolved?: string } | null
  extra?: ReactNode
}) {
  if (!search && filters.length === 0 && !date && !extra) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {search ? (
        <SearchInput placeholder={search.placeholder} paramKey={search.paramKey ?? 'q'} />
      ) : null}
      {filters.map((filter) => (
        <FilterChips
          key={filter.paramKey}
          basePath={basePath}
          currentParams={currentParams}
          paramKey={filter.paramKey}
          label={filter.label}
          options={filter.options}
          allLabel={filter.allLabel}
          defaultValue={filter.defaultValue}
          hideAll={filter.hideAll}
        />
      ))}
      {date ? (
        <DateParamFilter
          paramKey={date.paramKey}
          label={date.label}
          max={date.max}
          resolved={date.resolved}
        />
      ) : null}
      {extra}
    </div>
  )
}

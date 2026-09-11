import Link from 'next/link'
import { Settings } from 'lucide-react'
import { Badge, Button, cn } from '@openbooks/ui'
import { SortTh } from '../../../components/sortable-th'
import { Pagination } from '../../../components/pagination'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { PageContainer } from '../../../components/page-layout'
import { TabContent } from '@openbooks/ui'
import { TaxFilingsView } from './TaxFilingsView'
import { FilingHistoryDrawer, type FilingHistoryRecord } from './FilingHistoryDrawer'

export type TaxFormOption = {
  code: string
  name: string
  country: string | null
  submission_channel: string
  government_format: string
  submission_url: string | null
  has_official: boolean
}

export interface TaxHistoryRow {
  id: string
  formName: string
  formCode: string
  filingHref: string
  period: string
  version: number
  status: 'prepared' | 'filed'
  statusVariant: 'warning' | 'success'
  statusLabel: string
  reference: string
  saved: string
}

/**
 * Pieces of the tax page that the page and the widget registry share.
 *
 * The prepare/history tab strip is a WIDGET rather than the shared `tab-nav`:
 * it carries a count badge inside one tab and `aria-current` instead of
 * `role="tab"` — a different component with a different contract, the same
 * reason the payments and receipts strips stayed separate. The prepare panel
 * is the client `TaxFilingsView` verbatim (compute/export/save are
 * interactive fetch flows a spec cannot name), and the history table stays a
 * component for the reason the admin-users one did: the native page
 * hand-rolls a plain `<table>` with its own classes, and the spec's table
 * block offers only the two real table variants the app has.
 *
 * The spec itself is coarse by necessity: the native page sits in
 * `PageContainer`, whose `FadeInBody` motion wrappers carry
 * `data-page-motion` attributes and post-animation inline styles that a spec
 * `grid` (a plain div) cannot reproduce — so the spec draws no chrome of its
 * own and places a single `tax-page` widget rendering the identical shell
 * components the widget registry uses. The pager likewise lives in the shared
 * history-table component (not in the spec) because this table is not a spec
 * table; the spec's `pagination` block would render a second one. The tab
 * presence flags still come from the loader; they are applied one level down,
 * inside `TaxTabPanels`, exactly as the native `{tab === ... ? ... : ...}`
 * does, because a `when` cannot cross a widget boundary.
 */

/** The native shell: PageContainer's centered container with its space-y-6 body. */
export function TaxPageShell({ children }: { children: React.ReactNode }) {
  return (
    <PageContainer>
      <div className="space-y-6">{children}</div>
    </PageContainer>
  )
}

/** The native header: hand-rolled h1 + description with the setup action —
 *  not the shared PageHeader, whose flex-row chrome is a different element. */
export function TaxPageHeader({
  title,
  description,
  setupHref,
  setupLabel,
  canManageSetup,
}: {
  title: string
  description: string
  setupHref: string
  setupLabel: string
  canManageSetup: boolean
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{description}</p>
      </div>
      {canManageSetup ? (
        <Button variant="outline" size="sm" asChild>
          <Link href={setupHref as never}>
            <Settings size={14} />
            {setupLabel}
          </Link>
        </Button>
      ) : null}
    </div>
  )
}

/** The prepare/history tab strip with the filing-count badge on History. */
export function TaxTabs({
  tabs,
}: {
  tabs: { key: string; href: string; label: string; active: boolean; count: number | null }[]
}) {
  return (
    <nav className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800">
      {tabs.map((item) => (
        <Link
          key={item.key}
          href={item.href as never}
          aria-current={item.active ? 'page' : undefined}
          className={cn(
            '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            item.active
              ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
              : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100',
          )}
        >
          {item.label}
          {item.count !== null && item.count > 0 ? (
            <span
              className={cn(
                'rounded-full px-1.5 text-xs tabular-nums',
                item.active
                  ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/60 dark:text-teal-300'
                  : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
              )}
            >
              {item.count}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  )
}

/** The interactive prepare panel: compute, export and save are client fetch flows. */
export function TaxPreparePanel({
  forms,
  canSave,
  canManageSetup,
}: {
  forms: TaxFormOption[]
  canSave: boolean
  canManageSetup: boolean
}) {
  return <TaxFilingsView forms={forms} canSave={canSave} canManageSetup={canManageSetup} />
}

/** The hand-rolled filing-history table with its search/filter toolbar and pager. */
export function TaxHistoryTable({
  searchPlaceholder,
  statusLabel,
  statusOptions,
  formLabel,
  formOptions,
  basePath,
  currentParams,
  total,
  page,
  perPage,
  sort,
  dir,
  columnForm,
  columnPeriod,
  columnVersion,
  columnStatus,
  columnReference,
  columnSaved,
  empty,
  rows,
}: {
  searchPlaceholder: string
  statusLabel: string
  statusOptions: { value: string; label: string }[]
  formLabel: string
  formOptions: { value: string; label: string }[]
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  total: number
  page: number
  perPage: number
  sort: string
  dir: 'asc' | 'desc'
  columnForm: string
  columnPeriod: string
  columnVersion: string
  columnStatus: string
  columnReference: string
  columnSaved: string
  empty: string
  rows: TaxHistoryRow[]
}) {
  const sortProps = { basePath, currentParams, sort, dir }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={searchPlaceholder} />
        <FilterChips
          basePath={basePath}
          currentParams={currentParams}
          paramKey="status"
          label={statusLabel}
          options={statusOptions}
        />
        <FilterChips
          basePath={basePath}
          currentParams={currentParams}
          paramKey="form"
          label={formLabel}
          options={formOptions}
        />
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
              <tr>
                <SortTh basePath={basePath} currentParams={currentParams} column="form" sort={sortProps.sort} dir={sortProps.dir}>{columnForm}</SortTh>
                <SortTh basePath={basePath} currentParams={currentParams} column="period" sort={sortProps.sort} dir={sortProps.dir}>{columnPeriod}</SortTh>
                <th className="px-3 py-2">{columnVersion}</th>
                <SortTh basePath={basePath} currentParams={currentParams} column="status" sort={sortProps.sort} dir={sortProps.dir}>{columnStatus}</SortTh>
                <th className="px-3 py-2">{columnReference}</th>
                <SortTh basePath={basePath} currentParams={currentParams} column="created" sort={sortProps.sort} dir={sortProps.dir}>{columnSaved}</SortTh>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">{empty}</td></tr>
              ) : rows.map((filing) => (
                <tr key={filing.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                  <td className="px-3 py-2"><Link href={(filing.filingHref) as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{filing.formName}</Link><div className="font-mono text-xs text-slate-400">{filing.formCode}</div></td>
                  <td className="whitespace-nowrap px-3 py-2">{filing.period}</td>
                  <td className="px-3 py-2 tabular-nums">{filing.version}</td>
                  <td className="px-3 py-2"><Badge variant={filing.statusVariant}>{filing.statusLabel}</Badge></td>
                  <td className="px-3 py-2">{filing.reference}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500 dark:text-slate-400">{filing.saved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination basePath={basePath} currentParams={currentParams} total={total} page={page} perPage={perPage} />
      </div>
    </div>
  )
}

/** The tab panels, wrapped in the same crossfade the native page uses. */
export function TaxTabPanels({
  tabKey,
  onPrepare,
  onHistory,
  prepare,
  history,
}: {
  tabKey: string
  onPrepare: boolean
  onHistory: boolean
  prepare?: React.ReactNode
  history?: React.ReactNode
}) {
  return (
    <TabContent tabKey={tabKey}>
      {onPrepare ? prepare : null}
      {onHistory ? history : null}
    </TabContent>
  )
}

/** The filing flyout. The remount key rides along as a prop: opening a different
 *  filing must reset the drawer's client state, and a widget at a fixed
 *  position would otherwise be reused (same pattern as `account-drawer`). */
export function TaxFilingDrawer({
  drawer,
}: {
  drawer: { remountKey: string; filing: FilingHistoryRecord; closeHref: string; canFile: boolean } | null
}) {
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <FilingHistoryDrawer key={remountKey} {...rest} />
}

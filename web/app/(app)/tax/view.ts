import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { db } from '@openbooks/engine/src/db.ts'
import { page, ref, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../lib/list-params'
import type { FilingHistoryRecord } from './FilingHistoryDrawer'
import type { TaxFormOption, TaxHistoryRow } from './sections'

/**
 * Tax filings, split into a loader and a spec.
 *
 * Two mutually exclusive bodies behind a tab, chosen by presence flags the
 * LOADER computes — the same "presence, not branching" treatment the
 * accounts page gave its three bodies and continuous-close gave its two
 * lists. Both bodies stay shared components rather than becoming spec
 * blocks, for the two reasons the brief already names: the prepare panel is
 * a client component whose compute/export/save flows are interactive fetch
 * calls a spec cannot name, and the history table is hand-rolled markup (the
 * admin-users precedent) — the spec's table block offers only the two real
 * table variants the app has, and this plain `<table>` is neither.
 *
 * The spec is coarse by necessity rather than by taste: the native page sits
 * in `PageContainer`, whose motion wrappers a spec `grid` cannot reproduce,
 * so the spec places a single `tax-page` widget rendering the identical
 * shell components the native branch uses. The loader-computed tab flags
 * travel as data and are applied inside `TaxTabPanels`, exactly as the
 * native `{tab === ... ? ... : ...}` does — a `when` cannot cross a widget
 * boundary. Authz stays server-side: the page 404s entity-restricted
 * callers, and the drawer carries a `canFile` flag the LOADER derives —
 * never a capability object.
 */

type FormRow = {
  code: string
  name: string
  country: string | null
  submission_channel: string
  government_format: string
  submission_url: string | null
  has_official: boolean
}

type FilingRow = FilingHistoryRecord & { created_at: string }

export interface TaxHistoryTableData {
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
}

export interface TaxData {
  title: string
  description: string
  setupHref: string
  setupLabel: string
  canManageSetup: boolean
  tabKey: string
  onPrepare: boolean
  onHistory: boolean
  tabs: { key: string; href: string; label: string; active: boolean; count: number | null }[]
  forms: TaxFormOption[]
  canSave: boolean
  history: TaxHistoryTableData
  drawerOpen: boolean
  drawer: {
    remountKey: string
    filing: FilingHistoryRecord
    closeHref: string
    canFile: boolean
  } | null
}

export async function loadTax(
  sp: Record<string, string | string[] | undefined>,
): Promise<TaxData> {
  const authz = await requirePermission('reports.read')
  // Returns and filings have no subsidiary dimension: every tax REST path
  // refuses an entity-restricted caller (guardSubsidiaryScope(gate, null) → 404),
  // and this page applies the identical fence rather than rendering the
  // org-wide filing history to them.
  if (authz.allowedSubsidiaryIds !== null) notFound()
  const { orgId } = authz.user
  const t = await getTranslations('tax')
  const tab = pickString(sp.tab) === 'history' ? 'history' : 'prepare'
  const list = parseListParams(sp, { sort: 'period', dir: 'desc', perPage: 20, allowedSorts: ['period', 'form', 'status', 'created'] as const })
  const status = pickString(sp.status)
  const formCode = pickString(sp.form)
  const filingId = pickString(sp.filing)
  const canManageSetup = can(authz, 'admin.setup.manage')

  const formsResult = (await db.execute<FormRow>(sql`
    select code, name, country, submission_channel, government_format, submission_url,
           official_pdf_file_id is not null as has_official
      from tax_return_forms
     where org_id = ${orgId} and is_active
     order by country nulls last, name`))
  const forms = formsResult.rows

  const filters = sql`where org_id = ${orgId}
    ${status === 'prepared' || status === 'filed' ? sql`and status = ${status}` : sql``}
    ${formCode && forms.some((form) => form.code === formCode) ? sql`and form_code = ${formCode}` : sql``}
    ${list.q ? sql`and (
      form_name ilike ${`%${list.q}%`} or form_code ilike ${`%${list.q}%`} or
      coalesce(filing_reference, '') ilike ${`%${list.q}%`} or
      cast(period_from as text) ilike ${`%${list.q}%`} or cast(period_to as text) ilike ${`%${list.q}%`}
    )` : sql``}`
  const order = list.sort === 'form'
    ? sql`form_name ${list.dir === 'asc' ? sql`asc` : sql`desc`}, period_to desc`
    : list.sort === 'status'
      ? sql`status ${list.dir === 'asc' ? sql`asc` : sql`desc`}, period_to desc`
      : list.sort === 'created'
        ? sql`created_at ${list.dir === 'asc' ? sql`asc` : sql`desc`}`
        : sql`period_to ${list.dir === 'asc' ? sql`asc` : sql`desc`}, version desc`

  // Total filings drives the History tab's count badge (always cheap); the full
  // history rows are only queried when that tab is open.
  const [badgeResult, historyResult, countResult, selectedResult] = await Promise.all([
    db.execute<{ count: number }>(sql`select count(*)::int as count from tax_filings where org_id = ${orgId}`),
    tab === 'history'
      ? db.execute<FilingRow>(sql`
          select id, form_name, form_code, country, period_from::text, period_to::text,
                 version, status, filing_reference, filed_at::text, snapshot_hash, boxes, created_at::text
            from tax_filings ${filters}
           order by ${order}
           limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`)
      : Promise.resolve({ rows: [] as FilingRow[] }),
    tab === 'history'
      ? db.execute<{ count: number }>(sql`select count(*)::int as count from tax_filings ${filters}`)
      : Promise.resolve({ rows: [{ count: 0 }] }),
    filingId && isUuid(filingId)
      ? db.execute<FilingHistoryRecord>(sql`
          select id, form_name, form_code, country, period_from::text, period_to::text,
                 version, status, filing_reference, filed_at::text, snapshot_hash, boxes
            from tax_filings where id = ${filingId} and org_id = ${orgId} limit 1`)
      : Promise.resolve({ rows: [] as FilingHistoryRecord[] }),
  ])
  const badgeCount = Number(badgeResult.rows[0]?.count ?? 0)
  const history = historyResult.rows
  const total = Number(countResult.rows[0]?.count ?? 0)
  const selected = selectedResult.rows[0]
  const closeHref = mergeHref('/tax', sp, { filing: undefined })

  return {
    title: t('title'),
    description: t('description'),
    setupHref: '/admin/setup/tax-return-forms',
    setupLabel: t('setup'),
    canManageSetup,
    tabKey: tab,
    onPrepare: tab === 'prepare',
    onHistory: tab === 'history',
    tabs: [
      { key: 'prepare', label: t('tabs.prepare'), href: '/tax', active: tab === 'prepare', count: null },
      { key: 'history', label: t('tabs.history'), href: '/tax?tab=history', active: tab === 'history', count: badgeCount },
    ],
    forms: forms.map((form) => ({ ...form })),
    canSave: can(authz, 'reports.create'),
    history: {
      searchPlaceholder: t('history.search'),
      statusLabel: t('history.statusLabel'),
      statusOptions: [
        { value: 'prepared', label: t('history.status.prepared') },
        { value: 'filed', label: t('history.status.filed') },
      ],
      formLabel: t('form'),
      formOptions: forms.map((form) => ({ value: form.code, label: form.name })),
      basePath: '/tax',
      currentParams: sp,
      total,
      page: list.page,
      perPage: list.perPage,
      sort: list.sort,
      dir: list.dir,
      columnForm: t('history.columns.form'),
      columnPeriod: t('history.columns.period'),
      columnVersion: t('history.columns.version'),
      columnStatus: t('history.columns.status'),
      columnReference: t('history.columns.reference'),
      columnSaved: t('history.columns.saved'),
      empty: t('history.empty'),
      rows: history.map((filing) => ({
        id: String(filing.id),
        formName: filing.form_name,
        formCode: filing.form_code,
        filingHref: mergeHref('/tax', sp, { filing: filing.id }),
        period: t('period', { from: filing.period_from, to: filing.period_to }),
        version: filing.version,
        status: filing.status,
        statusVariant: (filing.status === 'filed' ? 'success' : 'warning') as 'success' | 'warning',
        statusLabel: t(`history.status.${filing.status}`),
        reference: filing.filing_reference ?? '—',
        saved: filing.created_at.slice(0, 10),
      })),
    },
    drawerOpen: Boolean(selected),
    drawer: selected
      ? {
          remountKey: String(selected.id),
          filing: selected,
          closeHref,
          canFile: can(authz, 'reports.create'),
        }
      : null,
  }
}

const f = ref<TaxData>()

export function taxSpec(data: TaxData): PageSpec {
  return page({
    // The native page owns its PageContainer shell, which no spec layout
    // reproduces — so the spec draws no chrome of its own and places the
    // whole page through one widget that renders the identical shared
    // components the native branch uses.
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('tax-page', {
        title: data.title,
        description: data.description,
        setupHref: data.setupHref,
        setupLabel: data.setupLabel,
        canManageSetup: data.canManageSetup,
        tabKey: data.tabKey,
        onPrepare: data.onPrepare,
        onHistory: data.onHistory,
        tabs: data.tabs,
        forms: data.forms,
        canSave: data.canSave,
        history: data.history,
      }),
      { ...widgetBlock('tax-filing-drawer', { drawer: data.drawer }), when: f('drawerOpen') },
    ],
  })
}

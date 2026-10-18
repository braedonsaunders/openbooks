import 'server-only'

import { getLocale, getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import {
  EquityError,
  listCompensationRuns,
  listEquityEntities,
  listInterestRuns,
  listSecurities,
  listStakeholders,
  loadCapTableView,
  loadSecurityDetail,
  loadStructure,
  previewCompensationRun,
  previewInterestRun,
  type CapTable,
  type CompensationPreview,
  type CompensationRunRow,
  type InterestPreview,
  type InterestRunRow,
  type SecurityDetail,
  type SecurityKind,
  type SecurityRow,
  type StructureView,
} from '@openbooks/engine/equity'
import { db } from '@openbooks/engine/platform/database'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isUuid, mergeHref, pickString } from '../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../lib/subsidiaries'
import { builtInReportDefinitionId } from '../../../lib/custom-reports'

/**
 * Equity & cap table, one legal entity at a time.
 *
 * Seven peer views behind URL tabs, one body at a time: the cap table (by
 * class or by holder), the securities register with its drawer, the
 * stakeholders, plans and pools, rounds and convertibles with the round
 * modeller, the exit waterfall, and stock compensation. The legal entity
 * and the as-of date travel in the URL. Every read checks equity.read and
 * the reader's reach to the legal entity in the engine; every command does
 * the same for its own duty.
 */

export const EQUITY_BASE = '/equity'
const VIEWS = ['captable', 'securities', 'stakeholders', 'plans', 'rounds', 'waterfall', 'compensation'] as const
export type EquityView = (typeof VIEWS)[number]
const KINDS: readonly SecurityKind[] = ['share', 'option', 'rsu', 'warrant', 'safe', 'note']

export interface Option {
  value: string
  label: string
}

export interface EquityContext {
  subsidiaryId: string
  currency: string
  asOf: string
  canManage: boolean
  canApprove: boolean
  /** The current URL parameters, so in-page links keep the entity and date. */
  params: Record<string, string | string[] | undefined>
}

export interface CapTableViewData {
  context: EquityContext
  by: 'class' | 'holder'
  byTabs: { href: string; label: string; active: boolean }[]
  table: CapTable
  parties: Record<string, string>
  hasAccountPolicy: boolean
  accountsSetupHref: string
  reportHref: string | null
}

export interface SecuritiesViewData {
  context: EquityContext
  kind: SecurityKind | null
  holderPartyId: string | null
  holderName: string | null
  kindTabs: { href: string; label: string; active: boolean }[]
  rows: (SecurityRow & { href: string })[]
}

export interface StakeholdersViewData {
  context: EquityContext
  table: CapTable
  parties: Record<string, { name: string; kind: string; email: string | null }>
}

export interface StructureViewData {
  context: EquityContext
  structure: StructureView
  convertibles: CapTable['convertibles']
  parties: Record<string, string>
  /**
   * Note interest through the as-of date and the runs already posted
   * (rounds view). A named refusal of the preview (a missing exchange rate,
   * say) is shown with its remedy instead of the schedule.
   */
  interest: { preview: InterestPreview | null; refusal: { message: string; remedy: string } | null; runs: InterestRunRow[] } | null
}

export interface CompensationViewData {
  context: EquityContext
  preview: CompensationPreview
  runs: CompensationRunRow[]
  parties: Record<string, string>
  reportHref: string | null
}

export interface SecurityDrawerData {
  context: EquityContext
  detail: SecurityDetail
  closeHref: string
  holders: Option[]
  rounds: Option[]
  commonClasses: Option[]
  considerationAccounts: Option[]
}

export interface NewRecordData {
  context: EquityContext
  holders: Option[]
  classes: (Option & { kind: string })[]
  /** Common classes a preferred class can convert into. */
  commonClasses: Option[]
  plans: (Option & { shareClassId: string })[]
  rounds: (Option & { shareClassId: string; pricePerShare: string; currency: string })[]
  considerationAccounts: Option[]
  currencies: Option[]
}

export interface EquityPageData {
  title: string
  description: string
  view: EquityView
  tabs: { href: string; label: string; active?: boolean }[]
  entityPicker: { id: string; label: string }[]
  entityLabel: string
  subsidiaryId: string
  asOf: string
  asOfLabel: string
  hasEntity: boolean
  noEntity: boolean
  emptyTitle: string
  emptyDescription: string
  kpis: { label: string; value: string }[]
  onCapTable: boolean
  onSecurities: boolean
  onStakeholders: boolean
  onPlans: boolean
  onRounds: boolean
  onWaterfall: boolean
  onCompensation: boolean
  capTable: CapTableViewData | null
  securities: SecuritiesViewData | null
  stakeholders: StakeholdersViewData | null
  structure: StructureViewData | null
  waterfall: { context: EquityContext } | null
  compensation: CompensationViewData | null
  drawerOpen: boolean
  drawer: SecurityDrawerData | null
  newRecord: NewRecordData | null
}

const integer = (value: string, locale: string): string => new Intl.NumberFormat(locale).format(BigInt(value))

async function holderOptions(orgId: string, allowed: ReadonlySet<string> | null): Promise<Option[]> {
  // The org-wide party rule: parties without an entity are eligible to every
  // caller; entity-bound parties stay inside their entity.
  return (await db.execute<{ id: string; name: string }>(sql`
    select id, display_name as name from parties
     where org_id = ${orgId} and is_active
     ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })}
     order by display_name limit 2000`)).rows.map((row) => ({ value: row.id, label: row.name }))
}

async function currencyOptions(): Promise<Option[]> {
  return (await db.execute<{ code: string; name: string }>(sql`
    select code, name from currencies order by code`)).rows.map((row) => ({ value: row.code, label: `${row.code} · ${row.name}` }))
}

async function considerationAccounts(orgId: string): Promise<Option[]> {
  return (await db.execute<{ id: string; label: string }>(sql`
    select id, concat_ws(' · ', number, name) as label from accounts
     where org_id = ${orgId} and is_active and not is_summary and type in ('asset_bank', 'asset_current_other')
     order by number nulls last, name`)).rows.map((row) => ({ value: row.id, label: row.label }))
}

export async function loadEquity(sp: Record<string, string | string[] | undefined>): Promise<EquityPageData> {
  const t = await getTranslations('equity')
  const authz = await requirePermission('equity.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'equity')
  const actor = { orgId, actorId: authz.user.id }
  const canManage = can(authz, 'equity.manage')
  const canApprove = can(authz, 'equity.approve')
  const localeTag = await getLocale()

  const entities = await listEquityEntities(actor)
  const requestedSub = pickString(sp.sub)
  const entity = entities.find((row) => row.id === requestedSub) ?? entities[0] ?? null
  const today = await businessToday(orgId)
  const requestedAsOf = pickString(sp.asOf)
  const asOf = requestedAsOf && /^\d{4}-\d{2}-\d{2}$/.test(requestedAsOf) ? requestedAsOf : today
  const securityParam = pickString(sp.security)
  const requestedView = pickString(sp.view)
  const view: EquityView = securityParam ? 'securities' : (VIEWS as readonly string[]).includes(requestedView ?? '') ? (requestedView as EquityView) : 'captable'

  const keep = (overrides: Record<string, string | undefined>) => mergeHref(EQUITY_BASE, { sub: entity?.id, asOf: requestedAsOf }, overrides)
  const tabs = VIEWS.map((key) => ({ href: keep({ view: key === 'captable' ? undefined : key }), label: t(`tabs.${key}`), active: view === key }))
  const base = {
    title: t('home.title'),
    description: t('home.description'),
    view,
    tabs,
    entityPicker: entities.map((row) => ({ id: row.id, label: row.name })),
    entityLabel: t('entity.label'),
    subsidiaryId: entity?.id ?? '',
    asOf,
    asOfLabel: t('entity.asOf'),
    hasEntity: entity !== null,
    noEntity: entity === null,
    emptyTitle: t('empty.noEntities'),
    emptyDescription: t('empty.noEntitiesDescription'),
    onCapTable: entity !== null && view === 'captable',
    onSecurities: entity !== null && view === 'securities',
    onStakeholders: entity !== null && view === 'stakeholders',
    onPlans: entity !== null && view === 'plans',
    onRounds: entity !== null && view === 'rounds',
    onWaterfall: entity !== null && view === 'waterfall',
    onCompensation: entity !== null && view === 'compensation',
  }
  if (!entity) {
    return {
      ...base, kpis: [], capTable: null, securities: null, stakeholders: null, structure: null, waterfall: null,
      compensation: null, drawerOpen: false, drawer: null, newRecord: null,
    }
  }
  const context: EquityContext = { subsidiaryId: entity.id, currency: entity.currency, asOf, canManage, canApprove, params: { sub: entity.id, asOf: requestedAsOf } }
  const scope = { ...actor, subsidiaryId: entity.id, asOf }

  // The vitals row reads the cap table on every view, so the tabs share one frame of reference.
  const capView = await loadCapTableView(scope)
  const totals = capView.table.totals
  const outstandingConvertibles = capView.table.convertibles.filter((row) => row.status === 'outstanding').length
  const kpis = [
    { label: t('kpi.fullyDiluted'), value: integer(totals.fullyDiluted, localeTag) },
    { label: t('kpi.outstanding'), value: integer(totals.outstanding, localeTag) },
    { label: t('kpi.poolAvailable'), value: integer(totals.poolAvailable, localeTag) },
    { label: t('kpi.holders'), value: integer(String(capView.table.holders.length), localeTag) },
    { label: t('kpi.convertibles'), value: integer(String(outstandingConvertibles), localeTag) },
  ]

  let capTable: CapTableViewData | null = null
  let securities: SecuritiesViewData | null = null
  let stakeholders: StakeholdersViewData | null = null
  let structure: StructureViewData | null = null
  let compensation: CompensationViewData | null = null

  if (view === 'captable') {
    const by = pickString(sp.by) === 'holder' ? 'holder' : 'class'
    capTable = {
      context,
      by,
      byTabs: (['class', 'holder'] as const).map((key) => ({ href: keep({ by: key === 'class' ? undefined : key }), label: t(`capTable.by.${key}`), active: by === key })),
      table: capView.table,
      parties: capView.parties,
      hasAccountPolicy: capView.hasAccountPolicy,
      accountsSetupHref: '/admin/setup/equity-account-policies',
      reportHref: await reportHref(orgId, 'equity-securities-register'),
    }
  }
  if (view === 'securities') {
    const requestedKind = pickString(sp.kind)
    const kind = KINDS.find((value) => value === requestedKind) ?? null
    const holder = pickString(sp.holder)
    const holderPartyId = holder && isUuid(holder) ? holder : null
    const listed = await listSecurities({ ...scope, kind, holderPartyId })
    securities = {
      context,
      kind,
      holderPartyId,
      holderName: holderPartyId ? listed.rows.find((row) => row.holderPartyId === holderPartyId)?.holderName ?? null : null,
      kindTabs: [null, ...KINDS].map((key) => ({
        href: keep({ view: 'securities', kind: key ?? undefined, holder: holderPartyId ?? undefined }),
        label: key ? t(`kindPlural.${key}`) : t('securities.allKinds'),
        active: key === kind,
      })),
      rows: listed.rows.map((row) => ({ ...row, href: keep({ view: 'securities', kind: kind ?? undefined, holder: holderPartyId ?? undefined, security: row.id }) })),
    }
  }
  if (view === 'stakeholders') {
    const listed = await listStakeholders(scope)
    stakeholders = { context, table: listed.table, parties: listed.parties }
  }
  if (view === 'plans' || view === 'rounds') {
    let interest: StructureViewData['interest'] = null
    if (view === 'rounds') {
      const runs = await listInterestRuns({ ...actor, subsidiaryId: entity.id })
      try {
        interest = { preview: await previewInterestRun({ ...actor, subsidiaryId: entity.id, throughDate: asOf }), refusal: null, runs }
      } catch (error) {
        if (!(error instanceof EquityError)) throw error
        interest = { preview: null, refusal: { message: error.message, remedy: error.remedy }, runs }
      }
    }
    structure = { context, structure: await loadStructure(scope), convertibles: capView.table.convertibles, parties: capView.parties, interest }
  }
  if (view === 'compensation') {
    const preview = await previewCompensationRun({ ...actor, subsidiaryId: entity.id, throughDate: asOf })
    const runs = await listCompensationRuns({ ...actor, subsidiaryId: entity.id })
    const ids = preview.lines.map((line) => line.holderPartyId)
    const names = ids.length === 0 ? [] : (await db.execute<{ id: string; display_name: string }>(sql`
      select id, display_name from parties where org_id = ${orgId} and id = any(${`{${[...new Set(ids)].join(',')}}`}::uuid[])`)).rows
    compensation = {
      context, preview, runs,
      parties: Object.fromEntries(names.map((row) => [row.id, row.display_name])),
      reportHref: await reportHref(orgId, 'equity-stock-compensation-schedule'),
    }
  }

  let drawer: SecurityDrawerData | null = null
  if (securityParam && isUuid(securityParam)) {
    try {
      const detail = await loadSecurityDetail({ ...actor, securityId: securityParam, asOf })
      if (detail.entity.id === entity.id) {
        const structureView = canManage || canApprove ? await loadStructure(scope) : null
        drawer = {
          context,
          detail,
          closeHref: keep({ view: 'securities', kind: pickString(sp.kind), holder: pickString(sp.holder) }),
          holders: canManage ? await holderOptions(orgId, authz.allowedSubsidiaryIds) : [],
          rounds: structureView?.rounds.map((row) => ({ value: row.id, label: `${row.name} · ${row.closedOn}` })) ?? [],
          commonClasses: structureView?.classes.filter((row) => row.kind === 'common').map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` })) ?? [],
          considerationAccounts: canManage || canApprove ? await considerationAccounts(orgId) : [],
        }
      }
    } catch (error) {
      if (!(error instanceof EquityError) || error.status !== 404) throw error
    }
  }

  let newRecord: NewRecordData | null = null
  if (canManage) {
    const structureView = await loadStructure(scope)
    newRecord = {
      context,
      holders: await holderOptions(orgId, authz.allowedSubsidiaryIds),
      classes: structureView.classes.map((row) => ({ value: row.id, label: `${row.code} · ${row.name}`, kind: row.kind })),
      commonClasses: structureView.classes.filter((row) => row.kind === 'common').map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` })),
      plans: structureView.plans.map((row) => ({ value: row.id, label: `${row.code} · ${row.name}`, shareClassId: row.shareClassId })),
      rounds: structureView.rounds.map((row) => ({ value: row.id, label: `${row.name} · ${row.closedOn}`, shareClassId: row.shareClassId, pricePerShare: row.pricePerShare, currency: row.currency })),
      considerationAccounts: await considerationAccounts(orgId),
      currencies: await currencyOptions(),
    }
  }

  return {
    ...base,
    kpis,
    capTable,
    securities,
    stakeholders,
    structure,
    waterfall: view === 'waterfall' ? { context } : null,
    compensation,
    drawerOpen: drawer !== null,
    drawer,
    newRecord,
  }
}

async function reportHref(orgId: string, key: string): Promise<string | null> {
  const id = await builtInReportDefinitionId(orgId, key)
  return id ? `/reports/custom/run/${id}` : null
}

const f = ref<EquityPageData>()

export function equitySpec(data: EquityPageData): PageSpec {
  return page({
    route: '/equity',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center justify-end gap-2',
        actions: [
          widget('subsidiary-switcher', { picker: data.entityPicker, value: data.subsidiaryId, label: data.entityLabel }, f('hasEntity')),
          widget('equity-as-of', { value: data.asOf, label: data.asOfLabel }, f('hasEntity')),
          widget('equity-new', { data: data.newRecord }),
          widget('module-home-tabs', { tabs: data.tabs }, f('hasEntity')),
        ],
      }),
    ],
    body: [
      { ...widgetBlock('empty-state', { title: data.emptyTitle, description: data.emptyDescription }), when: f('noEntity') },
      { ...widgetBlock('kpi-strip', { items: data.kpis }), when: f('hasEntity') },
      { ...widgetBlock('equity-cap-table', { view: data.capTable }), when: f('onCapTable') },
      { ...widgetBlock('equity-securities', { view: data.securities }), when: f('onSecurities') },
      { ...widgetBlock('equity-stakeholders', { view: data.stakeholders }), when: f('onStakeholders') },
      { ...widgetBlock('equity-plans', { view: data.structure }), when: f('onPlans') },
      { ...widgetBlock('equity-rounds', { view: data.structure }), when: f('onRounds') },
      { ...widgetBlock('equity-waterfall', { view: data.waterfall }), when: f('onWaterfall') },
      { ...widgetBlock('equity-compensation', { view: data.compensation }), when: f('onCompensation') },
      { ...widgetBlock('equity-security-drawer', { drawer: data.drawer }), when: f('drawerOpen') },
    ],
  })
}

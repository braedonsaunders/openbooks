import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { grid, page, pageHeader, ref, statTile, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { ResourcingRefusal } from '@openbooks/engine/src/resourcing/errors.ts'
import { balanceOf } from '@openbooks/engine/src/resourcing/retainers.ts'
import { syncRetainerActivation } from '@openbooks/engine/src/resourcing/retainer-billing.ts'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { getMoneyFormatter } from '@/lib/money-server'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import { isUuid, mergeHref, pickString } from '../../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'
import type { FormLayoutConfig } from '@openbooks/customization'
import type { CustomFieldDefClient } from '../../../../components/custom-field-inputs'
import { loadRetainerKpis } from '../../../../lib/resourcing/retainer-kpis'
import { isRetainerItemEligible, type RetainerItemRule } from '../../../../lib/resourcing/retainer-items'

export type RetainerRecord = {
  id: string
  projectId: string
  customerPartyId: string
  kind: 'hours' | 'fees'
  totalAmount: string
  currency: string
  totalHours: string | null
  unitRate: string | null
  startsOn: string
  endsOn: string
  retainerItemId: string
  invoiceDocumentId: string | null
  obligationId: string | null
  state: string
  balance: string
  custom: Record<string, unknown>
}

export type RetainerDrawdownRow = {
  id: string
  weekStart: string
  hours: string
  amount: string
  state: string
}

export type RetainerEvidenceRow = {
  timeEntryId: string
  workedOn: string
  hours: string
  personName: string | null
  weekStart: string
  drawdownId: string
}

export type RetainerRecognitionRow = {
  periodMonth: string
  amount: string
  posted: boolean
  reversed: boolean
}

export type RetainerItemOption = {
  id: string
  name: string
  code: string | null
  rule: RetainerItemRule | null
  eligibleHours: boolean
  eligibleFees: boolean
}

export type RetainerDrawerData = {
  remountKey: string
  contractId: string | null
  retainer: RetainerRecord | null
  projectName: string | null
  customerName: string | null
  itemName: string | null
  invoice: { id: string; number: string; status: string } | null
  activationRefusal: { message: string; remedy?: string } | null
  projects: { id: string; name: string }[]
  customers: { id: string; name: string }[]
  items: RetainerItemOption[]
  drawdowns: RetainerDrawdownRow[]
  evidence: RetainerEvidenceRow[]
  recognition: RetainerRecognitionRow[]
  headerDefs: CustomFieldDefClient[]
  canManage: boolean
  createMode: boolean
  closeHref: string
  layout: FormLayoutConfig
}

export type RetainerKpiTile = {
  icon: string
  accent: string
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'positive' | 'warning' | 'negative'
}

export type RetainersData = {
  title: string
  description: string
  newLabel: string
  currentParams: Record<string, string | string[] | undefined>
  canManage: boolean
  tiles: RetainerKpiTile[]
  drawer: RetainerDrawerData | null
}

type RetainerReadRow = {
  id: string
  projectId: string
  customerPartyId: string
  kind: 'hours' | 'fees'
  totalAmount: string
  currency: string
  totalHours: string | null
  unitRate: string | null
  startsOn: string
  endsOn: string
  retainerItemId: string
  invoiceDocumentId: string | null
  obligationId: string | null
  state: string
  custom: unknown
}

type DrawdownReadRow = { id: string; weekStart: string; hours: string; amount: string; state: string }
type EvidenceReadRow = {
  timeEntryId: string
  workedOn: string
  hours: string
  personName: string | null
  weekStart: string
  drawdownId: string
}
type RecognitionReadRow = { periodMonth: string; amount: string; posted: boolean; reversed: boolean }
type ItemReadRow = { id: string; name: string; code: string | null; method: string | null; isForecast: boolean | null }

function customRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

const RECOGNITION_PREFIX = 'resourcing:retainer-drawdown:'

export async function loadRetainersPage(
  sp: Record<string, string | string[] | undefined>,
): Promise<RetainersData> {
  const t = await getTranslations('resourcing.retainers')
  const authz = await requirePermission('retainers.read')
  await requireFeatureEnabled(authz.user.orgId, 'retainerBilling')
  const canManage = can(authz, 'retainers.manage')
  const { money } = await getMoneyFormatter()
  const today = await businessToday(authz.user.orgId)
  const kpis = await loadRetainerKpis(authz.user.orgId, authz.allowedSubsidiaryIds, today)

  const tiles: RetainerKpiTile[] = [
    ...kpis.perCurrency.flatMap((entry) => ([
      {
        icon: 'wallet',
        accent: 'teal',
        label: t('kpi.balance', { currency: entry.currency }),
        value: money(entry.balance, { currency: entry.currency }),
      },
      {
        icon: 'trending-up',
        accent: 'sky',
        label: t('kpi.drawn', { currency: entry.currency }),
        value: money(entry.drawn, { currency: entry.currency }),
      },
    ])),
    {
      icon: 'triangle-alert',
      accent: 'amber',
      label: t('kpi.expiring'),
      value: String(kpis.expiringCount),
      sub: t('kpi.expiringSub'),
      tone: kpis.expiringCount > 0 ? 'warning' : undefined,
    },
  ]

  const requested = pickString(sp.retainer)
  const createMode = requested === 'new'
  if (createMode && !canManage) notFound()
  if (requested && !createMode && !isUuid(requested)) notFound()

  let drawer: RetainerDrawerData | null = null
  if (requested) {
    const loaded = !createMode
      ? (await db.execute<RetainerReadRow & { projectName: string; customerName: string | null; itemName: string | null }>(sql`
          select r.id, r.project_id as "projectId", r.customer_party_id as "customerPartyId", r.kind,
                 r.total_amount::text as "totalAmount", r.currency,
                 r.total_hours::text as "totalHours", r.unit_rate::text as "unitRate",
                 r.starts_on::text as "startsOn", r.ends_on::text as "endsOn",
                 r.retainer_item_id as "retainerItemId",
                 r.invoice_document_id as "invoiceDocumentId", r.obligation_id as "obligationId",
                 r.state, r.custom,
                 p.name as "projectName", c.display_name as "customerName", i.name as "itemName"
            from res_retainers r
            join projects p on p.org_id = r.org_id and p.id = r.project_id
            left join parties c on c.org_id = r.org_id and c.id = r.customer_party_id
            left join items i on i.org_id = r.org_id and i.id = r.retainer_item_id
           where r.org_id = ${authz.user.orgId} and r.id = ${requested}
           ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds)}
           limit 1
        `)).rows[0] ?? null
      : null
    if (requested && !createMode && !loaded) notFound()

    // The loader syncs activation first, so the state shown is current: once
    // the linked invoice posts, the retainer is active. A refused activation
    // surfaces its reason instead of the drawdown controls.
    let activationRefusal: RetainerDrawerData['activationRefusal'] = null
    let state = loaded?.state ?? 'draft'
    let obligationId = loaded?.obligationId ?? null
    if (loaded) {
      try {
        const synced = await withOrgTransaction(authz.user.orgId, () =>
          syncRetainerActivation(db, authz.user.orgId, loaded.id, authz.user.id))
        if (synced) {
          state = synced.state
          obligationId = synced.obligationId
        }
      } catch (error) {
        if (error instanceof ResourcingRefusal) {
          activationRefusal = { message: error.message, remedy: error.remedy }
        } else {
          throw error
        }
      }
    }

    const retainerId = loaded?.id ?? null
    const drawdownRows = retainerId
      ? (await db.execute<DrawdownReadRow>(sql`
          select id, week_start::text as "weekStart", hours::text as hours,
                 amount::text as amount, state
            from res_retainer_drawdowns
           where org_id = ${authz.user.orgId} and retainer_id = ${retainerId}
           order by week_start
        `)).rows
      : []
    // The displayed balance is the landed engine policy, never a local
    // formula: total minus posted drawdowns for this retainer.
    const balance = loaded
      ? balanceOf(
          { totalAmount: loaded.totalAmount, currency: loaded.currency },
          drawdownRows.filter((row) => row.state === 'posted'),
        ).amount
      : '0'

    // The recognition rows link into the existing Revenue contract drawer,
    // resolved from the retainer's performance obligation.
    const contractId = obligationId
      ? (await db.execute<{ contractId: string }>(sql`
          select contract_id as "contractId"
            from performance_obligations
           where org_id = ${authz.user.orgId} and id = ${obligationId}
           limit 1
        `)).rows[0]?.contractId ?? null
      : null

    const evidence = retainerId
      ? (await db.execute<EvidenceReadRow>(sql`
          select e.time_entry_id as "timeEntryId", te.worked_on::text as "workedOn",
                 te.hours::text as hours, p.display_name as "personName",
                 d.week_start::text as "weekStart", d.id as "drawdownId"
            from res_retainer_drawdown_entries e
            join res_retainer_drawdowns d on d.org_id = e.org_id and d.id = e.drawdown_id
            join time_entries te on te.org_id = e.org_id and te.id = e.time_entry_id
            left join parties p on p.org_id = e.org_id and p.id = te.employee_party_id
           where e.org_id = ${authz.user.orgId} and d.retainer_id = ${retainerId}
           order by te.worked_on, p.display_name
        `)).rows
      : []

    // Recognition events carry the deterministic source reference
    // resourcing:retainer-drawdown:<drawdownId>:<YYYY-MM>. Posted means a
    // recognition journal for the obligation's period is posted or reversed;
    // a reversed recognition shows as reversed, never as missing.
    const recognition = obligationId
      ? (await db.execute<RecognitionReadRow>(sql`
          select ev.period_month as "periodMonth", ev.amount::text as amount,
                 exists(select 1
                          from recognition_schedules s
                          join recognition_schedule_lines l on l.org_id = s.org_id and l.schedule_id = s.id
                          join accounting_periods ap on ap.org_id = l.org_id and ap.id = l.period_id
                          join journal_entries j on j.org_id = l.org_id and j.id = l.journal_entry_id
                         where s.org_id = ev.org_id and s.obligation_id = ev.obligation_id
                           and ap.starts_on <= ev.period_month::date and ev.period_month::date <= ap.ends_on
                           and j.status in ('posted', 'reversed')) as posted,
                 exists(select 1
                          from recognition_schedules s
                          join recognition_schedule_lines l on l.org_id = s.org_id and l.schedule_id = s.id
                          join accounting_periods ap on ap.org_id = l.org_id and ap.id = l.period_id
                         where s.org_id = ev.org_id and s.obligation_id = ev.obligation_id
                           and ap.starts_on <= ev.period_month::date and ev.period_month::date <= ap.ends_on
                           and l.reversal_journal_entry_id is not null) as reversed
            from recognition_events ev
           where ev.org_id = ${authz.user.orgId} and ev.obligation_id = ${obligationId}
             and ev.source_reference like ${`${RECOGNITION_PREFIX}%`}
           order by ev.period_month
        `)).rows
      : []

    const invoice = loaded?.invoiceDocumentId
      ? (await db.execute<{ id: string; number: string; status: string }>(sql`
          select id, document_number as number, status
            from documents
           where org_id = ${authz.user.orgId} and id = ${loaded.invoiceDocumentId}
           limit 1
        `)).rows[0] ?? null
      : null

    const editable = canManage && (createMode || (state === 'draft' && loaded?.invoiceDocumentId === null))
    const [projectRows, customerRows, itemRows] = editable
      ? await Promise.all([
          db.execute<{ id: string; name: string }>(sql`
            select p.id, p.name from projects p
             where p.org_id = ${authz.user.orgId} and p.is_active
             ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds)}
             order by p.name`),
          db.execute<{ id: string; name: string }>(sql`
            select c.id, c.display_name as name from parties c
             where c.org_id = ${authz.user.orgId} and c.is_active
               and c.kind in ('customer', 'company')
             ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
             order by c.display_name`),
          db.execute<ItemReadRow>(sql`
            select i.id, i.name, i.code,
                   r.method as method, r.is_forecast as "isForecast"
              from items i
              left join recognition_rules r on r.org_id = i.org_id and r.id = i.recognition_rule_id
             where i.org_id = ${authz.user.orgId} and i.is_active and i.kind = 'service'
             order by i.name`),
        ])
      : [{ rows: [] }, { rows: [] }, { rows: [] }]

    const headerDefs = await loadFieldDefs('res_retainers', 'retainer')
    const resolved = await resolveFormLayout({
      orgId: authz.user.orgId,
      userId: authz.user.id,
      recordType: 'retainer',
      userRoles: authz.user.roles.map(({ key }) => key),
      headerDefs,
      lineDefs: [],
      explicitLayoutId: pickString(sp.form),
    })

    drawer = {
      remountKey: loaded?.id ?? 'new-retainer',
      contractId,
      retainer: loaded
        ? {
            id: loaded.id,
            projectId: loaded.projectId,
            customerPartyId: loaded.customerPartyId,
            kind: loaded.kind,
            totalAmount: loaded.totalAmount,
            currency: loaded.currency,
            totalHours: loaded.totalHours,
            unitRate: loaded.unitRate,
            startsOn: loaded.startsOn,
            endsOn: loaded.endsOn,
            retainerItemId: loaded.retainerItemId,
            invoiceDocumentId: loaded.invoiceDocumentId,
            obligationId,
            state,
            balance,
            custom: customRecord(loaded.custom),
          }
        : null,
      projectName: loaded?.projectName ?? null,
      customerName: loaded?.customerName ?? null,
      itemName: loaded?.itemName ?? null,
      invoice,
      activationRefusal,
      projects: projectRows.rows,
      customers: customerRows.rows,
      items: itemRows.rows.map((item) => {
        const rule = item.method === null && item.isForecast === null
          ? null
          : { method: item.method, isForecast: item.isForecast }
        return {
          id: item.id,
          name: item.name,
          code: item.code,
          rule,
          eligibleHours: isRetainerItemEligible('hours', rule),
          eligibleFees: isRetainerItemEligible('fees', rule),
        }
      }),
      drawdowns: drawdownRows,
      evidence,
      recognition,
      headerDefs: headerDefs as unknown as CustomFieldDefClient[],
      canManage,
      createMode,
      closeHref: mergeHref('/resourcing/retainers', sp, { retainer: undefined, form: undefined }),
      layout: resolved.layout,
    }
  }

  return {
    title: t('title'),
    description: t('description'),
    newLabel: t('newRetainer'),
    currentParams: sp,
    canManage,
    tiles,
    drawer,
  }
}

const f = ref<RetainersData>()

export function retainersSpec(data: RetainersData): PageSpec {
  const newRetainer = {
    widget: 'link-button',
    props: { href: '/resourcing/retainers?retainer=new', label: data.newLabel },
  }
  return page({
    route: '/resourcing/retainers',
    layout: 'list',
    header: [pageHeader({ title: f('title'), description: f('description'), actions: [widget(newRetainer.widget, newRetainer.props, f('canManage'))] })],
    body: [
      grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5', data.tiles.map((tile) =>
        statTile({
          iconKey: tile.icon,
          accent: tile.accent,
          label: tile.label,
          value: tile.value,
          ...(tile.sub ? { sub: tile.sub } : {}),
          ...(tile.tone ? { tone: tile.tone } : {}),
        }))),
      widgetBlock('entity-list-view', {
        recordType: 'retainer',
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'resourcing-retainer-drawer', props: { drawer: data.drawer } } : null,
        emptyAction: data.canManage ? newRetainer : null,
      }),
    ],
  })
}

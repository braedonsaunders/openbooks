import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import {
  column,
  drill,
  field,
  filterBar,
  money,
  page,
  pageHeader,
  paper,
  ref,
  rootRef,
  table,
  text,
  textBlock,
  widget,
  type PageSpec,
} from '@openbooks/viewspec'
import { getMoneyFormatter } from '@/lib/money-server'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { orgInfo } from '../../../../lib/data'
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'
import type { ReportDrillTarget } from '../../../../lib/report-drill'

/**
 * The order pipeline report, split into a loader and a spec.
 *
 * A flat table, so it needed no new vocabulary — the first conversion since
 * the first one that didn't. Its only wrinkle is the five drilled metric
 * columns, which the native page builds with an inline array-of-tuples and a
 * nested ternary to pick each column's label. All of that collapses into named
 * per-row fields here, which is the point: the spec binds `openCount` and
 * `openCountDrill`, and never reconstructs how they were derived.
 */

const KINDS = ['quote', 'sales_order', 'purchase_order'] as const

/** A non-voided order remains open while any line has unconverted quantity. */
const openOrderPredicate = sql`
  d.status <> 'voided'
  and exists (
    select 1
      from document_lines line
     where line.org_id = d.org_id
       and line.document_id = d.id
       and line.quantity_billed < line.quantity
  )`

export interface OrderRow {
  kind: string
  typeLabel: string
  openCount: string
  openCountDrill: ReportDrillTarget
  openValue: string
  openValueDrill: ReportDrillTarget
  converted: string
  convertedDrill: ReportDrillTarget
  convRate: string
  convRateDrill: ReportDrillTarget
  voided: string
  voidedDrill: ReportDrillTarget
}

export interface OrdersData {
  title: string
  description: string
  backHref: string
  backLabel: string
  company: string
  note: string
  columnType: string
  columnOpen: string
  columnOpenValue: string
  columnConverted: string
  columnConvRate: string
  columnVoided: string
  rows: OrderRow[]
}

export async function loadOrders(): Promise<OrdersData> {
  const { money: formatMoney } = await getMoneyFormatter()
  const authz = await requirePermission('reports.read')
  await requireFeatureEnabled(authz.user.orgId, 'orders')
  const t = await getTranslations('reports.orders')
  const tr = await getTranslations('reports')
  const orgId = authz.user.orgId
  const subsidiaryFilter = subsidiaryVisibleFilter(sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)

  const [pipeline, converted, org] = await Promise.all([
    db.execute(sql`
      select d.kind, d.status, count(*)::int as n, coalesce(sum(d.total), 0) as value,
             count(*) filter (where ${openOrderPredicate})::int as open_n,
             coalesce(sum(d.total) filter (where ${openOrderPredicate}), 0) as open_value
        from documents d
       where d.org_id = ${orgId}
         and d.kind in (${sql.join(KINDS.map((k) => sql`${k}`), sql`, `)})
         ${subsidiaryFilter}
       group by d.kind, d.status`),
    db.execute(sql`
      select d.kind, count(distinct d.id)::int as converted
        from documents d
        join document_links dl on dl.from_document_id = d.id and dl.org_id = d.org_id
       where d.org_id = ${orgId} and d.kind in (${sql.join(KINDS.map((k) => sql`${k}`), sql`, `)})
         ${subsidiaryFilter}
       group by d.kind`),
    orgInfo(orgId),
  ])

  const convByKind = new Map<string, number>(
    converted.rows.map((r) => [String(r.kind), Number(r.converted)]),
  )

  const columnLabel = {
    open: t('columns.open'),
    openValue: t('columns.openValue'),
    converted: t('columns.converted'),
    convRate: t('columns.convRate'),
    voided: t('columns.voided'),
  }

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/reports',
    backLabel: tr('hub.title'),
    company: org?.name ?? '',
    note: t('note'),
    columnType: t('columns.type'),
    columnOpen: columnLabel.open,
    columnOpenValue: columnLabel.openValue,
    columnConverted: columnLabel.converted,
    columnConvRate: columnLabel.convRate,
    columnVoided: columnLabel.voided,
    rows: KINDS.map((kind) => {
      const forKind = pipeline.rows.filter((r) => r.kind === kind)
      const open = forKind.reduce((a: number, r) => a + Number(r.open_n ?? 0), 0)
      const openValue = forKind.reduce((a: number, r) => a + Number(r.open_value ?? 0), 0)
      const voided = forKind
        .filter((r) => r.status === 'voided')
        .reduce((a: number, r) => a + Number(r.n), 0)
      const conv = convByKind.get(kind) ?? 0
      const denom = open + conv
      const rate = denom > 0 ? Math.round((conv / denom) * 100) : 0
      const typeLabel = t(`kinds.${kind}`)
      const target = (
        scope: 'open' | 'converted' | 'conversion' | 'voided',
        label: string,
      ): ReportDrillTarget => ({ kind: 'orders', orderKind: kind, scope, label: `${typeLabel} · ${label}` })
      return {
        kind,
        typeLabel,
        openCount: open.toLocaleString('en-CA'),
        openCountDrill: target('open', columnLabel.open),
        openValue: formatMoney(openValue),
        openValueDrill: target('open', columnLabel.openValue),
        converted: conv.toLocaleString('en-CA'),
        convertedDrill: target('converted', columnLabel.converted),
        convRate: `${rate}%`,
        convRateDrill: target('conversion', columnLabel.convRate),
        voided: voided.toLocaleString('en-CA'),
        voidedDrill: target('voided', columnLabel.voided),
      }
    }),
  }
}

const f = ref<OrdersData>()
const item = field
const rootF = rootRef<OrdersData>()

export function ordersSpec(): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
      }),
      filterBar({ period: false }, { actions: [widget('save-view')] }),
    ],
    body: [
      paper({
        company: f('company'),
        title: f('title'),
        periodPhrase: f('description'),
        wide: true,
        blocks: [
          table({
            variant: 'report',
            rows: f('rows'),
            rowKey: item('kind'),
            columns: [
              column(rootF('columnType'), text(item('typeLabel')), { className: 'font-medium' }),
              column(rootF('columnOpen'), drill(item('openCountDrill'), text(item('openCount'))), {
                align: 'right',
                className: 'tabular-nums',
              }),
              column(rootF('columnOpenValue'), drill(item('openValueDrill'), money(item('openValue'))), {
                align: 'right',
              }),
              column(rootF('columnConverted'), drill(item('convertedDrill'), text(item('converted'))), {
                align: 'right',
                className: 'tabular-nums',
              }),
              column(rootF('columnConvRate'), drill(item('convRateDrill'), text(item('convRate'))), {
                align: 'right',
                className: 'tabular-nums',
              }),
              column(rootF('columnVoided'), drill(item('voidedDrill'), text(item('voided'))), {
                align: 'right',
                className: 'tabular-nums',
              }),
            ],
          }),
          textBlock(f('note'), { tone: 'muted', className: 'mt-3' }),
        ],
      }),
    ],
  })
}

import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  badge,
  column,
  field,
  grid,
  page,
  pageHeader,
  ref,
  rootRef,
  table,
  text,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@openbooks/viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import {
  complianceSubsidiaryFilter,
  loadLienWaivers,
  requireLienWaiverFeature,
  type LienWaiverRow,
} from '../../../../lib/compliance'
import { pickString } from '../../../../lib/list-params'
import { getMoneyFormatter } from '@/lib/money-server'
import { complianceTabs } from '../tabs'

/**
 * Lien waivers, split into a loader and a spec.
 *
 * The list leads with THROUGH-DATE and AMOUNT because those two fields are what
 * the payment control reads — everything else on the row is context. A waiver
 * that reads "signed" here is a waiver that will release a blocked bill.
 *
 * No new vocabulary. The table sits inside a bordered wrapper, which is a grid
 * block with a class, and the toolbar and drawer are widgets.
 */

const STATUS_TONE: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'> = {
  signed: 'success',
  received: 'warning',
  requested: 'warning',
  draft: 'outline',
  rejected: 'destructive',
  void: 'secondary',
}

export interface WaiverListRow {
  id: string
  waiverNumber: string
  href: string
  directionLabel: string
  partyName: string
  projectName: string
  typeLabel: string
  throughDate: string
  amount: string
  statusLabel: string
  statusVariant: 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'
}

export interface LienWaiversData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof complianceTabs>>
  toolbar: Record<string, unknown>
  emptyTitle: string
  emptyDescription: string
  isEmpty: boolean
  hasRows: boolean
  columnNumber: string
  columnParty: string
  columnProject: string
  columnType: string
  columnThrough: string
  columnAmount: string
  columnStatus: string
  rows: WaiverListRow[]
  drawerOpen: boolean
  drawerProps: Record<string, unknown> | null
}

export async function loadLienWaiversPage(
  sp: Record<string, string | string[] | undefined>,
): Promise<LienWaiversData> {
  const authz = await requirePermission('compliance.read')
  await requireFeatureEnabled(authz.user.orgId, 'subcontractorCompliance')
  const orgId = authz.user.orgId
  await requireLienWaiverFeature(orgId)
  const t = await getTranslations('compliance')
  const { money } = await getMoneyFormatter()
  const direction = pickString(sp.direction)
  const status = pickString(sp.status) ?? null
  const openId = pickString(sp.waiver) ?? null

  const [waivers, projects, vendors, tabs] = await Promise.all([
    loadLienWaivers({
      orgId,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      direction: direction === 'issued' ? 'issued' : direction === 'received' ? 'received' : null,
      status,
    }),
    db.execute<{ id: string; label: string }>(sql`
      select id, coalesce(code || ' · ' || name, name) as label from projects
       where org_id = ${orgId} and is_active
         ${complianceSubsidiaryFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds)}
       order by code nulls last, name limit 500`),
    db.execute<{ id: string; label: string; defaultType: string }>(sql`
      select p.id, p.display_name as label,
             coalesce(cls.default_lien_waiver_type, '') as "defaultType"
       from parties p
       join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id and vr.is_active
       left join compliance_classes cls on cls.id = vr.compliance_class_id and cls.org_id = p.org_id
       where p.org_id = ${orgId} and p.is_active
         ${complianceSubsidiaryFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
       order by p.display_name limit 2000`),
    complianceTabs('/compliance/lien-waivers', { projectsEnabled: true }),
  ])

  const open: LienWaiverRow | null = openId ? (waivers.find((w) => w.id === openId) ?? null) : null
  // Open bills the vendor could release, so a waiver's amount comes from the
  // money it is exchanged for rather than from retyping.
  const openBills = open
    ? (
        await db.execute<{ id: string; label: string; amount: string; currency: string }>(sql`
        select id, document_number as label, coalesce(open_balance, total) as amount, currency
          from documents
         where org_id = ${orgId} and party_id = ${open.partyId} and project_id = ${open.projectId}
           and kind in ('vendor_bill', 'expense_report') and status = 'posted'
           ${complianceSubsidiaryFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds)}
         order by document_date desc limit 50`)
      ).rows
    : []

  const query = new URLSearchParams({
    ...(direction ? { direction } : {}),
    ...(status ? { status } : {}),
  })
  const canManage = can(authz, 'compliance.manage')

  return {
    title: t('lienWaivers.title'),
    description: t('lienWaivers.description'),
    tabs,
    toolbar: {
      direction: direction ?? '',
      status: status ?? '',
      projects: projects.rows,
      vendors: vendors.rows,
      canManage,
    },
    emptyTitle: t('lienWaivers.empty.title'),
    emptyDescription: t('lienWaivers.empty.description'),
    isEmpty: waivers.length === 0,
    hasRows: waivers.length > 0,
    columnNumber: t('lienWaivers.columns.number'),
    columnParty: t('lienWaivers.columns.party'),
    columnProject: t('lienWaivers.columns.project'),
    columnType: t('lienWaivers.columns.type'),
    columnThrough: t('lienWaivers.columns.through'),
    columnAmount: t('lienWaivers.columns.amount'),
    columnStatus: t('lienWaivers.columns.status'),
    rows: waivers.map((waiver) => {
      const rowQuery = new URLSearchParams(query)
      rowQuery.set('waiver', waiver.id)
      return {
        id: waiver.id,
        waiverNumber: waiver.waiverNumber,
        href: `/compliance/lien-waivers?${rowQuery}`,
        directionLabel: t(`direction.${waiver.direction}`),
        partyName: waiver.partyName,
        projectName: waiver.projectName,
        typeLabel: t(`waiverType.${waiver.waiverType}`),
        throughDate: waiver.throughDate,
        amount: money(waiver.amount, { currency: waiver.currency }),
        statusLabel: t(`waiverStatus.${waiver.status}`),
        statusVariant: STATUS_TONE[waiver.status] ?? 'secondary',
      }
    }),
    drawerOpen: Boolean(open),
    drawerProps: open
      ? {
          waiver: open,
          openBills,
          closeHref: `/compliance/lien-waivers${query.toString() ? `?${query}` : ''}`,
          canManage,
        }
      : null,
  }
}

const f = ref<LienWaiversData>()
const item = field
const rootF = rootRef<LienWaiversData>()

const MUTED = 'text-slate-500 dark:text-slate-400'

export function lienWaiversSpec(data: LienWaiversData): PageSpec {
  return page({
    route: '/compliance/lien-waivers',
    layout: 'list',
    header: [
      pageHeader({ title: f('title'), description: f('description') }),
      widgetBlock('module-home-tabs', { tabs: data.tabs }),
    ],
    body: [
      widgetBlock('lien-waiver-toolbar', data.toolbar),
      {
        ...widgetBlock('empty-state', {
          title: data.emptyTitle,
          description: data.emptyDescription,
        }),
        when: f('isEmpty'),
      },
      {
        ...grid(
          'mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
          [
            table({
              variant: 'app',
              rows: f('rows'),
              rowKey: item('id'),
              columns: [
                column(
                  rootF('columnNumber'),
                  widgetCell('waiver-number-cell', {
                    waiverNumber: item('waiverNumber'),
                    href: item('href'),
                    directionLabel: item('directionLabel'),
                  }),
                  { className: 'font-medium' },
                ),
                column(rootF('columnParty'), text(item('partyName'))),
                column(rootF('columnProject'), text(item('projectName')), { className: MUTED }),
                column(rootF('columnType'), text(item('typeLabel')), { className: 'text-xs' }),
                column(rootF('columnThrough'), text(item('throughDate')), { className: 'tabular-nums' }),
                column(rootF('columnAmount'), text(item('amount')), {
                  align: 'right',
                  className: 'tabular-nums',
                }),
                column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
              ],
            }),
          ],
        ),
        when: f('hasRows'),
      },
      widgetBlock('lien-waiver-drawer', { drawer: data.drawerProps }, f('drawerOpen')),
    ],
  })
}

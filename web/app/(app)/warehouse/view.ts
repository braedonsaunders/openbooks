import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import {
  grid,
  page,
  pageHeader,
  panel,
  ref,
  statTile,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { isZero } from '@openbooks/engine/src/money/money.ts'
import { listStagedStock } from '@openbooks/engine/src/inventory/putaway.ts'
import { warehouseStockTieOut } from '@openbooks/engine/src/inventory/warehouses.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { pickString } from '../../../lib/list-params'
import { getMoneyFormatter } from '@/lib/money-server'
import type { ReportDrillTarget } from '@/lib/report-drill'
import { groupTabs } from '../../../components/module-home/group-tabs'
import type { StagedStockRowView } from './PutawayQueue'
import type { WarehouseTieOutRowView } from './WarehousesPanel'

/**
 * The warehouse cockpit, split into a loader and a spec like the purchasing
 * home. The hero ties on-hand value by warehouse out against the inventory
 * control accounts; beside it sit the stock awaiting putaway and the
 * warehouse and putaway-rule setup sections re-homed from Setup.
 *
 * Every figure is read through the engine for the caller's visible legal
 * entities, so a subsidiary-restricted reader sees their own stock and the
 * control balance of their own entities, never another's.
 */

type Tabs = Awaited<ReturnType<typeof groupTabs>>

export interface WarehouseData {
  title: string
  description: string
  tabs: Tabs
  currentParams: Record<string, string | string[] | undefined>
  canManage: boolean
  canPost: boolean
  canSetup: boolean
  newLabel: string
  activeLabel: string
  activeValue: string
  suspendedLabel: string
  suspendedValue: string
  stagedLabel: string
  stagedValue: string
  stagedTone: 'warning' | 'positive'
  tieOutTitle: string
  tieOutHint: string
  rows: WarehouseTieOutRowView[]
  layerTotalLabel: string
  controlLabel: string
  controlDrill: ReportDrillTarget | null
  differenceLabel: string
  differenceIsZero: boolean
  queueTitle: string
  queueHint: string
  staged: StagedStockRowView[]
  setupTitle: string
  rulesTitle: string
  newDrawer: { locations: { id: string; name: string }[]; closeHref: string } | null
  showNewDrawer: boolean
}

export async function loadWarehouse(
  sp: Record<string, string | string[] | undefined>,
): Promise<WarehouseData> {
  const authz = await requirePermission('items.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'warehousing')
  const t = await getTranslations('warehouse')
  const { money } = await getMoneyFormatter()
  const subsidiaryIds = authz.allowedSubsidiaryIds ? [...authz.allowedSubsidiaryIds] : null
  const canManage = can(authz, 'items.warehouses')

  const tieOut = await warehouseStockTieOut(db, orgId, subsidiaryIds)
  const staged = await listStagedStock(db, orgId, subsidiaryIds)
  const tabs = await groupTabs('warehouse', '/warehouse', { orgId })
  const showNew = canManage && pickString(sp.warehouseNew) === '1'
  const locations = showNew
    ? (await db.execute<{ id: string; name: string }>(sql`
        select id, name from locations where org_id = ${orgId} and is_active order by name`)).rows
    : []

  const warehouses = tieOut.rows.filter((row) => row.warehouseId !== null)
  const today = await businessToday(orgId)
  return {
    title: t('home.title'),
    description: t('home.description'),
    tabs,
    currentParams: sp,
    canManage,
    canPost: can(authz, 'items.post'),
    canSetup: can(authz, 'admin.setup.manage'),
    newLabel: t('create.new'),
    activeLabel: t('home.vitals.active'),
    activeValue: String(warehouses.filter((row) => row.status === 'active').length),
    suspendedLabel: t('home.vitals.suspended'),
    suspendedValue: String(warehouses.filter((row) => row.status === 'suspended').length),
    stagedLabel: t('home.vitals.staged'),
    stagedValue: String(staged.length),
    stagedTone: staged.length > 0 ? 'warning' : 'positive',
    tieOutTitle: t('tieOut.title'),
    tieOutHint: t('tieOut.hint'),
    rows: tieOut.rows.map((row) => ({
      warehouseId: row.warehouseId,
      code: row.code,
      name: row.name,
      status: row.status,
      valueLabel: money(row.value),
    })),
    layerTotalLabel: money(tieOut.layerTotal),
    controlLabel: money(tieOut.controlBalance),
    controlDrill: tieOut.controlAccountIds.length > 0
      ? { kind: 'ledger', label: t('tieOut.control'), accountIds: tieOut.controlAccountIds, to: today, mode: 'balance' }
      : null,
    differenceLabel: money(tieOut.difference),
    differenceIsZero: isZero(tieOut.difference),
    queueTitle: t('putaway.title'),
    queueHint: t('putaway.hint'),
    staged,
    setupTitle: t('setup.warehouses'),
    rulesTitle: t('setup.rules'),
    newDrawer: showNew ? { locations, closeHref: '/warehouse' } : null,
    showNewDrawer: showNew,
  }
}

const f = ref<WarehouseData>()

export function warehouseSpec(data: WarehouseData): PageSpec {
  return page({
    route: '/warehouse',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [
          widget('new-warehouse-button', { label: data.newLabel }, f('canManage')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      grid('flex flex-col gap-4', [
        grid('grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-3', [
          statTile({ iconKey: 'package', accent: 'emerald', label: f('activeLabel'), value: f('activeValue') }),
          statTile({ iconKey: 'triangle-alert', accent: 'amber', label: f('suspendedLabel'), value: f('suspendedValue') }),
          statTile({ iconKey: 'clipboard', accent: 'sky', label: f('stagedLabel'), value: f('stagedValue'), tone: f('stagedTone') }),
        ]),
        grid('grid grid-cols-1 gap-5 lg:grid-cols-3', [
          panel({
            title: f('tieOutTitle'),
            iconKey: 'building',
            hint: f('tieOutHint'),
            className: 'self-start lg:col-span-2',
            blocks: [
              widgetBlock('warehouses-panel', {
                rows: data.rows,
                canManage: data.canManage,
                currentParams: data.currentParams,
                layerTotalLabel: data.layerTotalLabel,
                controlLabel: data.controlLabel,
                controlDrill: data.controlDrill,
                differenceLabel: data.differenceLabel,
                differenceIsZero: data.differenceIsZero,
              }),
            ],
          }),
          panel({
            title: f('queueTitle'),
            iconKey: 'clipboard',
            hint: f('queueHint'),
            className: 'self-start',
            blocks: [widgetBlock('putaway-queue', { rows: data.staged, canPost: data.canPost })],
          }),
        ]),
        panel({
          title: f('setupTitle'),
          iconKey: 'settings',
          when: f('canSetup'),
          blocks: [widgetBlock('setup-section', { entityKey: 'warehouses', basePath: '/warehouse', rowParam: 'warehouse', sp: data.currentParams })],
        }),
        panel({
          title: f('rulesTitle'),
          iconKey: 'settings',
          when: f('canSetup'),
          blocks: [widgetBlock('setup-section', { entityKey: 'putaway-rules', basePath: '/warehouse', rowParam: 'rule', sp: data.currentParams })],
        }),
      ]),
      {
        ...widgetBlock('new-warehouse-drawer', {
          locations: data.newDrawer?.locations ?? [],
          closeHref: data.newDrawer?.closeHref ?? '/warehouse',
        }),
        when: f('showNewDrawer'),
      },
    ],
  })
}

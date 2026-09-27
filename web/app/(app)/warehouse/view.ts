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
import { cmp, isZero } from '@openbooks/engine/src/money/money.ts'
import { AvailabilityRefusal, releasableBackorders } from '@openbooks/engine/src/inventory/availability.ts'
import { listStagedStock } from '@openbooks/engine/src/inventory/putaway.ts'
import { replenishmentProposals } from '@openbooks/engine/src/inventory/replenishment.ts'
import { warehouseStockTieOut } from '@openbooks/engine/src/inventory/warehouses.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../lib/features'
import { availabilityEntityScope, availabilityRefusalText } from '../../../lib/availability-report'
import { fulfillmentQueueCounts } from '../../../lib/fulfillment'
import { pickString } from '../../../lib/list-params'
import { getMoneyFormatter } from '@/lib/money-server'
import type { ReportDrillTarget } from '@/lib/report-drill'
import { warehouseGroupTabs } from '../../../components/module-home/group-tabs'
import type { DirectoryItem } from '../../../components/module-home/ui'
import type { StagedStockRowView } from './PutawayQueue'
import type { WarehouseTieOutRowView } from './WarehousesPanel'
import type { AttentionItem } from '../purchasing/sections'

/**
 * The warehouse cockpit, split into a loader and a spec like the purchasing
 * home. The hero ties on-hand value by warehouse out against the inventory
 * control accounts; beside it sit the stock awaiting putaway and the
 * warehouse and putaway-rule setup sections re-homed from Setup. Below them,
 * the availability and replenishment sections summarise the reader's default
 * legal entity and drill into the two reports. With Fulfillment on, a
 * fulfilment queue drills to the open pick lists and the shipments still to
 * complete, and the carrier setup section joins the re-homed setup.
 *
 * Every figure is read through the engine for the caller's visible legal
 * entities, so a subsidiary-restricted reader sees their own stock and the
 * control balance of their own entities, never another's.
 */

type Tabs = Awaited<ReturnType<typeof warehouseGroupTabs>>

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
  supplyHint: string
  availabilityTitle: string
  availabilityPulse: SupplyPulse
  replenishmentTitle: string
  replenishmentPulse: SupplyPulse
  supplyReady: boolean
  supplyRefusal: AttentionItem[]
  showSupplyRefusal: boolean
  setupTitle: string
  rulesTitle: string
  /** Fulfillment on and the viewer can fulfil orders. */
  showFulfillment: boolean
  /** Fulfillment on and the viewer manages setup: carriers are re-homed here. */
  showCarriers: boolean
  fulfillmentTitle: string
  fulfillmentHint: string
  fulfillmentQueue: DirectoryItem[]
  carriersTitle: string
  newDrawer: { locations: { id: string; name: string }[]; closeHref: string } | null
  showNewDrawer: boolean
}

/** The purchasing cockpit's three-figure pulse with its report link. */
type SupplyPulse = {
  outstanding: string
  overdue: string
  dueNext7: string
  overdueIsNegative: boolean
  labels: { open: string; overdue: string; due7: string; cta: string }
  href: string
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
  const tabs = await warehouseGroupTabs(authz, '/warehouse')
  const fulfillmentOn = await isFeatureEnabled(orgId, 'fulfillment')
  const showFulfillment = fulfillmentOn && can(authz, 'orders.fulfill')
  const queue = showFulfillment ? await fulfillmentQueueCounts(orgId, authz.allowedSubsidiaryIds) : null
  const showNew = canManage && pickString(sp.warehouseNew) === '1'
  const locations = showNew
    ? (await db.execute<{ id: string; name: string }>(sql`
        select id, name from locations where org_id = ${orgId} and is_active order by name`)).rows
    : []

  const warehouses = tieOut.rows.filter((row) => row.warehouseId !== null)
  const today = await businessToday(orgId)

  // Supply figures for the reader's default legal entity. A refusal (an order
  // line in a unit the item cannot convert) is shown in place of the figures,
  // naming its remedy, and links to the report that refuses the same way.
  const entity = await availabilityEntityScope(authz, undefined)
  const fulfillmentOn = await isFeatureEnabled(orgId, 'fulfillment')
  let supply: { stocked: number; short: number; releasable: number | null; reorder: number; unset: number; onOrder: number } | null = null
  let supplyRefusal: string | null = null
  if (entity.selectedId) {
    try {
      const lines = await replenishmentProposals(db, orgId, { subsidiaryId: entity.selectedId })
      const releasable = fulfillmentOn ? await releasableBackorders(db, orgId, { subsidiaryId: entity.selectedId }) : null
      supply = {
        stocked: lines.filter((line) => !isZero(line.onHand)).length,
        short: lines.filter((line) => cmp(line.onHand, line.committed) < 0).length,
        releasable: releasable ? new Set(releasable.map((line) => line.lineId)).size : null,
        reorder: lines.filter((line) => line.status === 'reorder').length,
        unset: lines.filter((line) => line.status === 'no_reorder_point' || line.status === 'points_inverted').length,
        onOrder: lines.filter((line) => !isZero(line.onOrder)).length,
      }
    } catch (error) {
      if (!(error instanceof AvailabilityRefusal)) throw error
      supplyRefusal = availabilityRefusalText(error)
    }
  }
  const entityLabel = entity.picker.find((option) => option.id === entity.selectedId)?.label ?? ''
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
    supplyHint: t('supply.hint', { entity: entityLabel }),
    availabilityTitle: t('availability.title'),
    availabilityPulse: {
      outstanding: String(supply?.stocked ?? 0),
      overdue: String(supply?.short ?? 0),
      dueNext7: supply?.releasable === null || supply === null ? '—' : String(supply.releasable),
      overdueIsNegative: (supply?.short ?? 0) > 0,
      labels: {
        open: t('supply.stocked'),
        overdue: t('supply.short'),
        due7: t('supply.releasable'),
        cta: t('supply.openAvailability'),
      },
      href: '/reports/availability',
    },
    replenishmentTitle: t('replenishment.title'),
    replenishmentPulse: {
      outstanding: String(supply?.reorder ?? 0),
      overdue: String(supply?.unset ?? 0),
      dueNext7: String(supply?.onOrder ?? 0),
      overdueIsNegative: (supply?.unset ?? 0) > 0,
      labels: {
        open: t('supply.toReorder'),
        overdue: t('supply.noPoints'),
        due7: t('supply.onOrder'),
        cta: t('supply.openReplenishment'),
      },
      href: '/reports/replenishment',
    },
    supplyReady: supply !== null,
    supplyRefusal: supplyRefusal ? [{ tone: 'negative', text: supplyRefusal, href: '/reports/availability' }] : [],
    showSupplyRefusal: supplyRefusal !== null,
    setupTitle: t('setup.warehouses'),
    rulesTitle: t('setup.rules'),
    showFulfillment,
    showCarriers: fulfillmentOn && can(authz, 'admin.setup.manage'),
    fulfillmentTitle: t('fulfillment.title'),
    fulfillmentHint: t('fulfillment.hint'),
    fulfillmentQueue: queue
      ? [
          {
            href: '/picks?stage=open',
            label: t('fulfillment.openPickLists'),
            iconKey: 'list-checks',
            badge: {
              value: String(queue.openPickLists),
              hint: t('fulfillment.openPickListsHint'),
              tone: queue.openPickLists > 0 ? 'warning' : 'positive',
            },
          },
          {
            href: '/shipments?stage=open',
            label: t('fulfillment.shipmentsToComplete'),
            iconKey: 'truck',
            badge: {
              value: String(queue.shipmentsToComplete),
              hint: t('fulfillment.shipmentsToCompleteHint'),
              tone: queue.shipmentsToComplete > 0 ? 'warning' : 'positive',
            },
          },
        ]
      : [],
    carriersTitle: t('setup.carriers'),
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
        grid('grid grid-cols-1 gap-5 lg:grid-cols-2', [
          panel({
            title: f('availabilityTitle'),
            iconKey: 'package',
            hint: f('supplyHint'),
            className: 'self-start',
            when: f('supplyReady'),
            blocks: [widgetBlock('ap-pulse', data.availabilityPulse)],
          }),
          panel({
            title: f('replenishmentTitle'),
            iconKey: 'clipboard',
            hint: f('supplyHint'),
            className: 'self-start',
            when: f('supplyReady'),
            blocks: [widgetBlock('ap-pulse', data.replenishmentPulse)],
          }),
          panel({
            title: f('availabilityTitle'),
            iconKey: 'triangle-alert',
            hint: f('supplyHint'),
            className: 'self-start lg:col-span-2',
            when: f('showSupplyRefusal'),
            blocks: [widgetBlock('attention-list', { items: data.supplyRefusal, allClear: '' })],
          }),
        ]),
        panel({
          title: f('fulfillmentTitle'),
          iconKey: 'list-checks',
          hint: f('fulfillmentHint'),
          when: f('showFulfillment'),
          blocks: [widgetBlock('live-directory', { items: data.fulfillmentQueue })],
        }),
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
        panel({
          title: f('carriersTitle'),
          iconKey: 'settings',
          when: f('showCarriers'),
          blocks: [widgetBlock('setup-section', { entityKey: 'carriers', basePath: '/warehouse', rowParam: 'carrier', sp: data.currentParams })],
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

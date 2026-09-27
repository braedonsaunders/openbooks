import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  ref,
  textBlock,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { AvailabilityRefusal } from '@openbooks/engine/src/inventory/availability.ts'
import { replenishmentProposals, type ReplenishmentLine } from '@openbooks/engine/src/inventory/replenishment.ts'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isFeatureEnabled, subsidiaryFeatureEnabled } from '../../../../lib/features'
import { orgInfo } from '../../../../lib/data'
import { pickString } from '../../../../lib/list-params'
import { statementReportSpec } from '@/lib/reports/statement-report-spec'
import { availabilityEntityScope, availabilityRefusalText } from '../../../../lib/availability-report'
import type { ReplenishmentRowView } from './ReplenishmentProposals'

/**
 * Replenishment, split into a loader and a spec like the balance sheet: the
 * loader calls the replenishment engine for the chosen legal entity, and
 * every line carries its evidence — on hand, committed, unallocated demand,
 * on order, projected supply, both points, the proposed quantity and the
 * vendor of the last receipt. Creating purchase orders is offered only to a
 * reader who may create them while Orders is on; it goes through the
 * ordinary purchase-order create, which re-checks both.
 */

export interface ReplenishmentData {
  title: string
  description: string
  backHref: string
  backLabel: string
  company: string
  scopePhrase: string
  note: string
  searchPlaceholder: string
  /** A refusal the engine raised instead of proposals, with its remedy. */
  refusal: string | null
  subsidiaries: { id: string; label: string }[]
  exportParams: Record<string, string | undefined>
  /** The entity purchase orders are created for; null leaves the order's
   *  subsidiary unset, which posts to the root entity, as a single-entity
   *  organization's purchase-order create requires. */
  orderSubsidiaryId: string | null
  canOrder: boolean
  rows: ReplenishmentRowView[]
}

export async function loadReplenishment(sp: Record<string, string | undefined>): Promise<ReplenishmentData> {
  const authz = await requirePermission('items.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'warehousing')
  const t = await getTranslations('warehouse.replenishment')
  const tr = await getTranslations('reports')

  const entity = await availabilityEntityScope(authz, pickString(sp.sub))
  const search = (pickString(sp.q) ?? '').trim().toLocaleLowerCase()
  let lines: ReplenishmentLine[] = []
  let refusal: string | null = null
  if (entity.selectedId) {
    try {
      lines = await replenishmentProposals(db, orgId, { subsidiaryId: entity.selectedId })
    } catch (error) {
      if (!(error instanceof AvailabilityRefusal)) throw error
      refusal = availabilityRefusalText(error)
    }
  }
  const rows = lines
    .filter((line) => !search || line.itemLabel.toLocaleLowerCase().includes(search))
    .map((line) => ({
      itemId: line.itemId,
      item: line.itemLabel,
      unit: line.baseUnit,
      onHand: line.onHand,
      committed: line.committed,
      unallocated: line.unallocated,
      onOrder: line.onOrder,
      projected: line.projected,
      reorderPoint: line.reorderPoint,
      preferredStockLevel: line.preferredStockLevel,
      proposed: line.proposed,
      status: line.status,
      vendorId: line.vendorId,
      vendor: line.vendorName,
    }))
  const org = await orgInfo(orgId)
  return {
    title: t('title'),
    description: t('description'),
    backHref: '/reports',
    backLabel: tr('hub.title'),
    company: org?.name ?? '',
    scopePhrase: entity.picker.find((option) => option.id === entity.selectedId)?.label ?? '',
    note: t('note'),
    searchPlaceholder: t('search'),
    refusal,
    subsidiaries: entity.picker,
    exportParams: sp,
    orderSubsidiaryId: (await subsidiaryFeatureEnabled(orgId)) ? entity.selectedId : null,
    canOrder: can(authz, 'ap.create') && (await isFeatureEnabled(orgId, 'orders')),
    rows,
  }
}

const f = ref<ReplenishmentData>()

export function replenishmentSpec(data: ReplenishmentData): PageSpec {
  return statementReportSpec({
    route: '/reports/replenishment',
    header: {
      title: f('title'),
      description: f('description'),
      back: { href: f('backHref'), label: f('backLabel') },
    },
    headerBeforeFilters: [textBlock(f('refusal'), { tone: 'warning', when: f('refusal') })],
    filters: [{
      controls: { search: true, subsidiary: true },
      options: { searchPlaceholder: f('searchPlaceholder'), subsidiaries: f('subsidiaries') },
    }],
    exportMenu: { kind: 'replenishment', params: data.exportParams },
    paper: {
      company: f('company'),
      title: f('title'),
      periodPhrase: f('scopePhrase'),
      wide: true,
    },
    blocks: [
      widgetBlock('replenishment-proposals', {
        rows: data.rows,
        orderSubsidiaryId: data.orderSubsidiaryId,
        canOrder: data.canOrder,
      }),
      textBlock(f('note'), { tone: 'muted', className: 'mt-3' }),
    ],
  })
}

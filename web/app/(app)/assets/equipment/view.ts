import 'server-only'

import { getMoneyFormatter } from '@/lib/money-server'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { grid, page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid, pickString } from '../../../../lib/list-params'
import { loadEquipment } from '../../../api/equipment/_lib'
import { isFeatureEnabled, subsidiaryFeatureEnabled } from '../../../../lib/features'
import type { EquipmentDrawer } from './EquipmentDrawer'

/**
 * The equipment register, split into a loader and a spec.
 *
 * Loader logic is copied verbatim from page.tsx: the assets.read gate, the
 * equipment feature gate, the visibility-filtered KPI summary (the subsidiary
 * filter applies to the counts AND the money totals — a total is a
 * disclosure), the ?equipment= flyout resolution (uuid guard, org guard,
 * subsidiary guard), the drawer pickers, and the three feature decisions that
 * hide whole drawer pickers. Every money value is formatted with the same
 * `getMoneyFormatter` formatter the native page uses.
 *
 * The body is the universal EntityListView (`equipment_unit`), so the list
 * itself arrives through the slot that re-derives Authz server-side. The spec
 * carries only the record type, the current params, and widget refs for the
 * drawer and the empty-state action — never an org id.
 *
 * Two wrappers the spec cannot re-express: the header link row (exact classes
 * the native page uses) and the KPI strip (KpiStrip markup is not stat-tile).
 */

type EquipmentDrawerProps = Parameters<typeof EquipmentDrawer>[0]
type LoadedEquipment = NonNullable<Awaited<ReturnType<typeof loadEquipment>>>

export interface EquipmentDrawerData {
  /** Remount key: switching units must reset the drawer's client state. */
  remountKey: string
  payload: LoadedEquipment
  items: EquipmentDrawerProps['items']
  assets: EquipmentDrawerProps['assets']
  books: EquipmentDrawerProps['books']
  subsidiaries: EquipmentDrawerProps['subsidiaries']
  canManage: boolean
  closeHref: string
  fixedAssetsEnabled: boolean
  projectsEnabled: boolean
}

export interface EquipmentData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  canManage: boolean
  kpis: { label: string; value: string }[]
  fixedAssetsLabel: string
  taxDepreciationLabel: string
  documentationLabel: string
  showFixedAssetsLinks: boolean
  drawer: EquipmentDrawerData | null
}

export async function loadEquipmentPage(
  sp: Record<string, string | string[] | undefined>,
): Promise<EquipmentData> {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('assets.equipment')
  const authz = await requirePermission('assets.read')
  await requireFeatureEnabled(authz.user.orgId, 'equipment')
  const canManage = can(authz, 'assets.manage')
  const equipmentId = typeof sp.equipment === 'string' ? sp.equipment : undefined
  const allowed = authz.allowedSubsidiaryIds ? sql`and e.subsidiary_id = any(${`{${[...authz.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``
  const [summary, open, pickers, subsidiaryUiEnabled, fixedAssetsEnabled, projectsEnabled] = await Promise.all([
    db.execute(sql`
      select coalesce(sum(e.purchase_price),0) purchase,
             count(*) filter(where e.status='active') active,
             coalesce(sum((select sum(dl.cost_amount) from document_lines dl join documents d on d.id=dl.document_id and d.org_id=dl.org_id
               where dl.equipment_unit_id=e.id and dl.org_id=e.org_id and d.kind='project_charge' and d.status in ('approved','posted'))),0) recovery,
             coalesce(sum((select sum(dl.bill_amount) from document_lines dl join documents d on d.id=dl.document_id and d.org_id=dl.org_id
               where dl.equipment_unit_id=e.id and dl.org_id=e.org_id and d.kind='project_charge' and d.status in ('approved','posted'))),0) billable
        from equipment_units e where e.org_id=${authz.user.orgId} ${allowed}
    `) as any,
    equipmentId && isUuid(equipmentId) ? loadEquipment(equipmentId, authz.user.orgId) : null,
    equipmentId ? Promise.all([
      db.execute(sql`select id,code,name from items where org_id=${authz.user.orgId} and kind='equipment_charge' and is_active order by name`) as any,
      db.execute(sql`select id,asset_number as number,name from fixed_assets where org_id=${authz.user.orgId} ${authz.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${[...authz.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``} order by asset_number`) as any,
      db.execute(sql`select id,code,name from item_rate_books where org_id=${authz.user.orgId} and is_active order by name`) as any,
      db.execute(sql`select id,name from subsidiaries where org_id=${authz.user.orgId} and is_active and not is_elimination ${authz.allowedSubsidiaryIds ? sql`and id = any(${`{${[...authz.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``} order by name`) as any,
    ]) : null,
    subsidiaryFeatureEnabled(authz.user.orgId),
    isFeatureEnabled(authz.user.orgId, 'fixedAssets'),
    isFeatureEnabled(authz.user.orgId, 'projects'),
  ])
  const requestedReturn = pickString(sp.drawerReturn)
  // Subsidiary guard, verbatim: a unit outside the reader's scope never opens.
  const drawer: EquipmentData['drawer'] =
    open && pickers && (!authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(String(open.unit.subsidiary_id)))
      ? {
          remountKey: String(open.unit.id),
          payload: open,
          items: pickers[0].rows,
          assets: fixedAssetsEnabled ? pickers[1].rows : [],
          books: projectsEnabled ? pickers[2].rows : [],
          subsidiaries: subsidiaryUiEnabled ? pickers[3].rows : [],
          canManage,
          closeHref: requestedReturn?.startsWith('/assets/equipment') ? requestedReturn : '/assets/equipment',
          fixedAssetsEnabled,
          projectsEnabled,
        }
      : null
  return {
    title: t('title'),
    description: t('pageDescription'),
    currentParams: sp,
    canManage,
    kpis: [
      { label: t('metrics.active'), value: String(summary.rows[0]?.active ?? 0) },
      { label: t('metrics.purchaseBasis'), value: money(summary.rows[0]?.purchase) },
      { label: t('metrics.recovery'), value: money(summary.rows[0]?.recovery) },
      { label: t('metrics.billable'), value: money(summary.rows[0]?.billable) },
    ],
    fixedAssetsLabel: t('fixedAssets'),
    taxDepreciationLabel: t('taxDepreciation'),
    documentationLabel: t('documentation'),
    showFixedAssetsLinks: fixedAssetsEnabled,
    drawer,
  }
}

const f = ref<EquipmentData>()

export function equipmentSpec(data: EquipmentData): PageSpec {
  const newEquipment = {
    widget: 'new-equipment',
    props: {},
  }
  return page({
    route: '/assets/equipment',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newEquipment.widget, newEquipment.props, f('canManage'))],
      }),
      // One composite, not three conditional links: the native row is a single
      // flex div whose first two anchors appear only while Fixed Assets is on.
      // Two presence-gated blocks would emit two divs when the feature is on.
      widgetBlock('equipment-header-links', {
        fixedAssetsLabel: data.fixedAssetsLabel,
        taxDepreciationLabel: data.taxDepreciationLabel,
        documentationLabel: data.documentationLabel,
        showFixedAssetsLinks: data.showFixedAssetsLinks,
      }),
    ],
    // The native body wraps the KPI strip and the list in a `space-y-5` div;
    // the ListPageLayout body has no such spacing, so the spec owns it.
    body: [
      grid('space-y-5', [
        widgetBlock('equipment-kpi-strip', { items: data.kpis }),
        widgetBlock('entity-list-view', {
          recordType: 'equipment_unit',
          sp: data.currentParams,
          drawer: data.drawer ? { widget: 'equipment-drawer', props: { drawer: data.drawer } } : null,
          emptyAction: data.canManage ? newEquipment : null,
        }),
      ]),
    ],
  })
}

import { uuidString } from '@openbooks/engine/platform/identifiers'
import { getLocale, getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/platform/db'
import { withScopeSnapshot } from '@openbooks/engine/organization/scope'
import { listManufacturingInspections } from '@openbooks/engine/manufacturing/quality-workspace'
import { manufacturingFeatureEnabled } from '@openbooks/engine/manufacturing/gate'
import { manufacturingOptions } from '@openbooks/engine/manufacturing/workspace'
import { lockManufacturingReadAuthority } from '@openbooks/engine/manufacturing/authority'
import { can, requirePermission } from '@/lib/authz'
import { requireFeatureEnabled } from '@/lib/feature-gates'
import { timeCommandGrants } from '@/lib/time-workspace'
import { ModuleView } from '@/components/viewspec/module-view'
import { formatDecimal } from '@/lib/money-format'
import { manufacturingModuleTabs, type ManufacturingTabLabels } from '@/lib/module-home/manufacturing-tabs'
import { manufacturingQualitySpec, type ManufacturingQualityData } from './view'
import { InspectionHost } from './InspectionHost'

export const dynamic = 'force-dynamic'
type SearchParams = Record<string, string | string[] | undefined>
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value

export async function generateMetadata() {
  const t = await getTranslations('manufacturing.quality')
  return { title: t('title') }
}

export default async function Quality({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const authz = await requirePermission('manufacturing.read')
  await requirePermission('items.read')
  await requireFeatureEnabled(authz.user.orgId, 'manufacturing')
  const [sp, t, mfg, nav, genealogyT, locale] = await Promise.all([
    searchParams,
    getTranslations('manufacturing.quality'),
    getTranslations('manufacturing'),
    getTranslations('nav'),
    getTranslations('manufacturing.genealogy'),
    getLocale(),
  ])
  const statusValues = ['pending', 'pass', 'fail'] as const
  const rawStatus = first(sp.status)
  const status = rawStatus === 'all' ? undefined : statusValues.includes(rawStatus as typeof statusValues[number]) ? rawStatus as typeof statusValues[number] : 'pending'
  const workOrderId = uuidString().safeParse(first(sp.workOrderId))
  const rawSubsidiary = first(sp.sub) ?? first(sp.subsidiaryId)

  const loaded = await withScopeSnapshot(authz.user.orgId, async () => {
    const scope = await lockManufacturingReadAuthority(db, authz.user.orgId, authz.user.id, authz.allowedSubsidiaryIds, ['manufacturing.read', 'items.read'])
    const options = await manufacturingOptions(db, authz.user.orgId, scope, false, authz.user.id)
    const subsidiaryId = options.subsidiaries.some((option) => option.value === rawSubsidiary) ? rawSubsidiary : undefined
    const queue = await listManufacturingInspections(db, authz.user.orgId, authz.user.id, {
      status,
      workOrderId: workOrderId.success ? workOrderId.data : undefined,
      subsidiaryId,
      q: first(sp.q)?.slice(0, 200),
      page: Number.parseInt(first(sp.page) ?? '1', 10) || 1,
    })
    return { queue, options, subsidiaryId }
  })

  const labels: ManufacturingTabLabels = {
    home: nav('manufacturing'),
    'work-orders': nav('manufacturing-work-orders'),
    'work-centers': nav('manufacturing-work-centers'),
    routings: nav('manufacturing-routings'),
    mrp: nav('manufacturing-mrp'),
    quality: t('title'),
    genealogy: genealogyT('title'),
    time: nav('manufacturing-time'),
  }
  const [mrpEnabled, timeGrants] = await Promise.all([
    manufacturingFeatureEnabled(authz.user.orgId, 'manufacturingMrp'),
    Promise.resolve(timeCommandGrants('time.read')),
  ])
  const tabs = manufacturingModuleTabs('quality', labels, {
    mrp: mrpEnabled,
    quality: true,
    genealogy: true,
    time: [...timeGrants.all, ...timeGrants.own].some((permission) => can(authz, permission)),
    subsidiaryId: loaded.subsidiaryId,
  })
  const currentParams = { ...sp, ...(loaded.subsidiaryId ? { sub: loaded.subsidiaryId } : {}) }
  const params = new URLSearchParams()
  for (const key of ['status', 'workOrderId', 'page', 'q', 'sub']) {
    const value = first(sp[key])
    if (value) params.set(key, value)
  }
  if (loaded.subsidiaryId) params.set('sub', loaded.subsidiaryId)
  const closeHref = '/manufacturing/quality' + (params.size ? `?${params}` : '')
  const selected = uuidString().safeParse(first(sp.inspection))
  const filters: ManufacturingQualityData['filters'] = [
    {
      paramKey: 'status', label: t('outcome'), allLabel: mfg('allStatuses'), defaultValue: 'pending',
      options: statusValues.map((value) => ({ value, label: t(`status.${value}`) })),
    },
    {
      paramKey: 'sub', label: mfg('fields.subsidiaryId'), allLabel: mfg('allEntities'),
      options: loaded.options.subsidiaries.map((option) => ({ value: option.value, label: option.label })),
    },
  ]
  const data: ManufacturingQualityData = {
    title: t('title'),
    description: t('description'),
    plansLabel: t('plans'),
    plansHref: '/admin/setup/manufacturing?tab=inspection-plans',
    canManagePlans: can(authz, 'admin.setup.manage') && authz.allowedSubsidiaryIds === null,
    tabs,
    currentParams,
    basePath: '/manufacturing/quality',
    filters,
    searchPlaceholder: mfg('searchPlaceholder'),
    queue: {
      ...loaded.queue,
      rows: loaded.queue.rows.map((inspection) => ({
        id: inspection.id,
        name: inspection.name,
        itemName: inspection.itemName,
        outcome: inspection.sourceActive ? t(`status.${inspection.status}`) : t('sourceReversed'),
        quantity: formatDecimal(locale, inspection.quantity, { maximumFractionDigits: 4 }),
        lotNumber: inspection.lotNumber ?? '—',
        serialNumber: inspection.serialNumber ?? '—',
        disposition: inspection.disposition ? t(`dispositions.${inspection.disposition}`) : '—',
        href: closeHref + (closeHref.includes('?') ? '&' : '?') + `inspection=${encodeURIComponent(inspection.id)}`,
      })),
    },
    emptyTitle: t('empty'),
    emptyDescription: t('emptyNote'),
    columns: {
      name: t('plan'), item: t('item'), outcome: t('outcome'), quantity: t('quantity'),
      lot: t('lot'), serial: t('serial'), disposition: t('disposition'),
    },
  }

  return <>
    <ModuleView spec={manufacturingQualitySpec(data)} data={data} searchParams={sp} trusted/>
    <InspectionHost
      recordId={selected.success ? selected.data : undefined}
      closeHref={closeHref}
      canInspect={can(authz, 'manufacturing.manage') && can(authz, 'items.manage')}
      canPost={can(authz, 'items.post')}
      scrapReasons={loaded.options.reasons.filter((option) => option.parentId === 'normal')}
    />
  </>
}

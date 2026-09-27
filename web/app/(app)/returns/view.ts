import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { loadDocument } from '@openbooks/engine/src/ledger/document-service.ts'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isUuid, pickString } from '../../../lib/list-params'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../lib/subsidiaries'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { accountOptions, createDocumentSeed, dimensionOptions, taxCodeOptions, taxGroupOptions } from '../../../lib/documents'
import { listScopedPartyOptionsWithCurrent } from '../../../lib/scoped-options'
import { findReturnAuthorization } from '../../../lib/returns'
import { DOC_KINDS } from '../../../lib/document-kinds'
import { warehouseGroupTabs } from '../../../components/module-home/group-tabs'
import type { DocumentDrawer } from '../../../components/document-drawer'
import type { ReturnAuthorization } from '@openbooks/engine/src/sales/returns.ts'

type DrawerProps = Parameters<typeof DocumentDrawer>[0]
type LoadedDocument = NonNullable<Awaited<ReturnType<typeof loadDocument>>>

export type ReturnsDrawer = DrawerProps & {
  remountKey: string
  workflow: ReturnAuthorization | null
  workflowCanInspect: boolean
  workflowCanManage: boolean
  vendors: { id: string; display_name: string }[]
}

export type ReturnsData = {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  canCreate: boolean
  drawer: ReturnsDrawer | null
  newButton: { items: { kind: string; label: string }[]; basePath: string; triggerLabel: string }
  tabs: Awaited<ReturnType<typeof warehouseGroupTabs>>
}

export async function loadReturns(sp: Record<string, string | string[] | undefined>): Promise<ReturnsData> {
  const authz = await requirePermission('orders.fulfill')
  await requireFeatureEnabled(authz.user.orgId, 'returnAuthorizations')
  const t = await getTranslations('returns')
  const rawId = pickString(sp.doc)
  const id = rawId && rawId !== 'new' && isUuid(rawId) ? rawId : null
  const creating = rawId === 'new' && sp.kind === 'rma'
  const canCreate = can(authz, 'orders.fulfill')
  const workflow = id
    ? await findReturnAuthorization(authz.user.orgId, id, authz.allowedSubsidiaryIds)
    : null
  const loaded = id && workflow ? await loadDocument(id, authz.user.orgId) : null
  const openDocument = loaded?.doc.kind === 'rma' ? loaded as LoadedDocument : null
  const drawerOpen = Boolean(openDocument || (creating && canCreate))
  const [headerDefs, lineDefs] = drawerOpen
    ? await Promise.all([loadFieldDefs('documents', 'rma'), loadFieldDefs('document_lines', 'rma')])
    : [[], []]
  const [parties, vendors, accounts, taxCodes, taxGroups, dimensions, items, stockLocations, subsidiaries, form] = drawerOpen
    ? await Promise.all([
        listScopedPartyOptionsWithCurrent(authz.user.orgId, authz.allowedSubsidiaryIds, 'customer', openDocument?.doc.party_id ? String(openDocument.doc.party_id) : undefined),
        listScopedPartyOptionsWithCurrent(authz.user.orgId, authz.allowedSubsidiaryIds, 'vendor'),
        accountOptions(DOC_KINDS.rma!, authz.user.orgId, authz.allowedSubsidiaryIds),
        taxCodeOptions(authz.user.orgId),
        taxGroupOptions(authz.user.orgId),
        dimensionOptions(authz.user.orgId, undefined, authz.allowedSubsidiaryIds),
        db.execute<{ id: string; code: string | null; name: string; unit: string | null; has_inventory_profile: boolean }>(sql`
          select it.id, it.code, it.name, it.unit,
                 exists (select 1 from item_inventory_profiles p where p.org_id = it.org_id and p.item_id = it.id) as has_inventory_profile
            from items it where it.org_id = ${authz.user.orgId} and it.is_active
            order by coalesce(it.code, it.name), it.name limit 2000`).then((result) => result.rows.map((row) => ({ ...row, code: row.code ?? undefined }))),
        db.execute<{ id: string; code: string | null }>(sql`select id, code from stock_locations where org_id = ${authz.user.orgId} and is_active order by code`).then((result) => result.rows),
        isMultiSubsidiary(authz.user.orgId).then(async (multi) => {
          if (!multi) return null
          const options = await subsidiaryOptions()
          return authz.allowedSubsidiaryIds ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id)) : options
        }),
        resolveFormLayout({
          orgId: authz.user.orgId,
          userId: authz.user.id,
          recordType: 'rma',
          userRoles: authz.user.roles.map(({ key }) => key),
          headerDefs,
          lineDefs,
          explicitLayoutId: pickString(sp.form),
        }),
      ])
    : [null, null, null, null, null, null, null, null, null, null]
  const seed = creating && canCreate ? await createDocumentSeed(authz.user.orgId, 'rma') : null
  const payload = (openDocument ?? seed) as DrawerProps['payload'] | null
  const selectedSubsidiary = (subsidiaries as { id: string }[] | null)?.[0]?.id
  if (seed && selectedSubsidiary) (seed.doc as Record<string, unknown>).subsidiary_id = selectedSubsidiary
  const drawer = payload && accounts && taxCodes && taxGroups && dimensions && items && stockLocations && form
    ? {
        remountKey: openDocument ? String(openDocument.doc.id) : 'new:rma',
        payload,
        config: DOC_KINDS.rma!,
        basePath: '/returns',
        parties: parties ?? [],
        accounts,
        taxCodes,
        taxGroups,
        departments: dimensions.departments,
        projects: dimensions.projects,
        locations: dimensions.locations,
        classes: dimensions.classes,
        segments: dimensions.segments,
        builtinSegments: dimensions.builtinSegments,
        items,
        stockLocations,
        subsidiaries: subsidiaries ?? undefined,
        headerDefs: headerDefs as unknown as DrawerProps['headerDefs'],
        lineDefs: lineDefs as unknown as DrawerProps['lineDefs'],
        canCreate,
        canPost: false,
        createMode: creating,
        initialMode: creating || pickString(sp.mode) === 'edit' ? 'edit' : 'view',
        layout: form.layout,
        availableLayouts: form.available,
        currentLayoutId: form.row?.id ?? null,
        recordType: 'rma',
        canCustomize: can(authz, 'admin.customization.manage'),
        workflow,
        workflowCanInspect: can(authz, 'ar.create') && can(authz, 'items.post'),
        workflowCanManage: canCreate,
        vendors,
      } satisfies ReturnsDrawer
    : null
  return {
    title: t('list.title'),
    description: t('list.description'),
    currentParams: sp,
    canCreate,
    drawer,
    newButton: { items: [{ kind: 'rma', label: t('actions.new') }], basePath: '/returns', triggerLabel: t('actions.new') },
    tabs: await warehouseGroupTabs(authz, '/returns'),
  }
}

const f = ref<ReturnsData>()

export function returnsSpec(data: ReturnsData): PageSpec {
  return page({
    route: '/returns',
    layout: 'list',
    header: [pageHeader({
      title: f('title'),
      description: f('description'),
      actions: [widget('module-home-tabs', { tabs: data.tabs }), widget('new-document', data.newButton, f('canCreate'))],
    })],
    body: [widgetBlock('record-list-view', {
      recordType: 'rma',
      basePath: '/returns',
      sp: data.currentParams,
      drawer: data.drawer ? { widget: 'rma-document-drawer', props: { drawer: data.drawer } } : null,
      emptyAction: null,
    })],
  })
}

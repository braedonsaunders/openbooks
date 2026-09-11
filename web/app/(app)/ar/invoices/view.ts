import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { pickString } from '../../../../lib/list-params'
import { can, requirePermission } from '../../../../lib/authz'
import {
  AR_KINDS,
  DOC_KINDS,
  accountOptions,
  dimensionOptions,
  loadDocument,
  partyOptions,
  taxCodeOptions,
  taxGroupOptions,
} from '../../../../lib/documents'
import type { DocKindConfig } from '../../../../lib/document-kinds'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import { featureEnabled, isFeatureEnabled, resolvedFeatureState } from '../../../../lib/features'
import type { DocumentDrawer } from '../../../../components/document-drawer'

/**
 * Customer invoices + credits, split into a loader and a spec.
 *
 * The list itself is the universal RecordListView, so the spec places a slot
 * instead of a table: the slot re-derives org/user/permissions from the
 * session. A spec that could name an org id is a cross-tenant read — the same
 * rule that put EntityListView behind `entity-list-view` when the accounts
 * page was converted. No such RecordListView slot exists yet, so the spec
 * below names the `record-list-view` widget and the registry entry
 * carries the exact registry entry and slot the coordinator needs to add.
 *
 * Everything else here is loader work copied verbatim from page.tsx: the
 * permission gates, the ?doc= flyout resolution (org guard, subsidiary
 * guard, AR-kind guard), the drawer pickers, and the form-layout resolution.
 * The drawer payload, the form layout, and the New-button labels are data,
 * so they travel through the loader result and the widgets render them.
 */

type DocumentDrawerProps = Parameters<typeof DocumentDrawer>[0]
type LoadedDocument = NonNullable<Awaited<ReturnType<typeof loadDocument>>>

export interface ArInvoicesDrawer {
  /** Remount key: switching documents must reset the drawer's client state. */
  remountKey: string
  payload: LoadedDocument
  config: DocKindConfig
  initialMode: 'edit' | 'view'
  parties: DocumentDrawerProps['parties']
  accounts: DocumentDrawerProps['accounts']
  taxCodes: DocumentDrawerProps['taxCodes']
  taxGroups: DocumentDrawerProps['taxGroups']
  departments: DocumentDrawerProps['departments']
  projects: DocumentDrawerProps['projects']
  locations: DocumentDrawerProps['locations']
  classes: DocumentDrawerProps['classes']
  segments: DocumentDrawerProps['segments']
  builtinSegments: DocumentDrawerProps['builtinSegments']
  items: Record<string, unknown>[]
  subsidiaries: DocumentDrawerProps['subsidiaries']
  headerDefs: DocumentDrawerProps['headerDefs']
  lineDefs: DocumentDrawerProps['lineDefs']
  canCreate: boolean
  canPost: boolean
  layout: DocumentDrawerProps['layout']
  availableLayouts: DocumentDrawerProps['availableLayouts']
  currentLayoutId: DocumentDrawerProps['currentLayoutId']
  recordType: string
  canCustomize: boolean
  paymentLinks: { documentId: string; canManage: boolean } | null
}

export interface ArInvoicesData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  canCreate: boolean
  newButton: {
    items: { kind: string; label: string }[]
    basePath: string
    triggerLabel: string
    creatingLabel: string
    failedLabel: string
  }
  drawerOpen: boolean
  drawer: ArInvoicesDrawer | null
}

export async function loadArInvoices(
  sp: Record<string, string | string[] | undefined>,
): Promise<ArInvoicesData> {
  const authz = await requirePermission('ar.read')
  const canCreate = can(authz, 'ar.create')
  const [featureState, inventoryEnabled, equipmentEnabled] = await Promise.all([
    resolvedFeatureState(authz.user.orgId),
    isFeatureEnabled(authz.user.orgId, 'inventory'),
    isFeatureEnabled(authz.user.orgId, 'equipment'),
  ])
  const onlinePaymentsEnabled = featureEnabled(featureState, 'onlinePayments')
  const t = await getTranslations('ar')
  const tCommon = await getTranslations('common')
  const docId = typeof sp.doc === 'string' ? sp.doc : undefined

  const newButton = {
    items: [
      { kind: 'customer_invoice', label: t('actions.newInvoice') },
      { kind: 'customer_credit', label: t('actions.newCredit') },
    ],
    basePath: '/ar/invoices',
    triggerLabel: t('actions.new'),
    creatingLabel: tCommon('actions.creating'),
    failedLabel: t('toasts.createDraftFailed'),
  }

  // Drawer + form layout resolve only when a flyout is open.
  // Org guard: never render another tenant's document in the drawer.
  const loadedDoc = docId ? await loadDocument(docId, authz.user.orgId) : null
  const openDoc = loadedDoc && loadedDoc.doc.org_id === authz.user.orgId
    && (!authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(String(loadedDoc.doc.subsidiary_id)))
    ? loadedDoc : null
  const openKind = openDoc?.doc.kind as string | undefined
  const drawerOpen = !!(openDoc && openKind && (AR_KINDS as readonly string[]).includes(openKind))
  const [headerDefs, lineDefs] = drawerOpen
    ? await Promise.all([loadFieldDefs('documents', openKind!), loadFieldDefs('document_lines', openKind!)])
    : [[], []]
  const [pickers, resolvedForm] = await Promise.all([
    drawerOpen
      ? Promise.all([
          partyOptions('customer'),
          accountOptions(DOC_KINDS[openKind! as 'customer_invoice']!),
          taxCodeOptions(),
          taxGroupOptions(),
          dimensionOptions(),
          db.execute(sql`
            select id, code, name from items
             where org_id = ${authz.user.orgId} and is_active
               and (
                 ${inventoryEnabled ? sql`true` : sql`kind not in ('inventory', 'assembly', 'kit')`}
                 ${equipmentEnabled ? sql`` : sql`and kind <> 'equipment_charge'`}
                 or id in (
                   select item_id from document_lines
                    where org_id = ${authz.user.orgId} and document_id = ${docId} and item_id is not null
                 )
               )
             order by coalesce(code, name), name limit 2000`).then((r) => r.rows),
          // Multi-subsidiary orgs only — null keeps ALL subsidiary UI hidden.
          isMultiSubsidiary(authz.user.orgId).then(async (multi) => {
            if (!multi) return null
            const options = await subsidiaryOptions()
            return authz.allowedSubsidiaryIds
              ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id))
              : options
          }),
        ])
      : null,
    drawerOpen
      ? resolveFormLayout({
          orgId: authz.user.orgId,
          userId: authz.user.id,
          recordType: openKind!,
          userRoles: authz.user.roles.map(({ key }) => key),
          headerDefs,
          lineDefs,
          explicitLayoutId: pickString(sp.form),
        })
      : null,
  ])

  const drawer =
    openDoc && pickers && resolvedForm && openKind
      ? {
          remountKey: String(openDoc.doc.id),
          payload: openDoc,
          config: DOC_KINDS[openKind]!,
          initialMode: (pickString(sp.mode) === 'edit' ? 'edit' : 'view') as 'edit' | 'view',
          parties: pickers[0],
          accounts: pickers[1],
          taxCodes: pickers[2],
          taxGroups: pickers[3],
          departments: pickers[4].departments,
          projects: pickers[4].projects,
          locations: pickers[4].locations,
          classes: pickers[4].classes,
          segments: pickers[4].segments,
          builtinSegments: pickers[4].builtinSegments,
          items: pickers[5],
          subsidiaries: pickers[6] ?? undefined,
          headerDefs: headerDefs as DocumentDrawerProps['headerDefs'],
          lineDefs: lineDefs as DocumentDrawerProps['lineDefs'],
          canCreate,
          canPost: can(authz, 'ar.post'),
          layout: resolvedForm.layout,
          availableLayouts: resolvedForm.available,
          currentLayoutId: resolvedForm.row?.id ?? null,
          recordType: openKind,
          canCustomize: can(authz, 'admin.customization.manage'),
          paymentLinks:
            openKind === 'customer_invoice' && onlinePaymentsEnabled
              ? { documentId: String(openDoc.doc.id), canManage: canCreate }
              : null,
        }
      : null

  return {
    title: t('list.title'),
    description: t('list.description'),
    currentParams: sp,
    canCreate,
    newButton,
    drawerOpen: Boolean(drawer),
    drawer,
  }
}

const f = ref<ArInvoicesData>()

export function arInvoicesSpec(data: ArInvoicesData): PageSpec {
  const newDocument = {
    widget: 'new-document',
    props: {
      items: data.newButton.items,
      basePath: data.newButton.basePath,
      triggerLabel: data.newButton.triggerLabel,
      creatingLabel: data.newButton.creatingLabel,
      failedLabel: data.newButton.failedLabel,
    },
  }
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newDocument.widget, newDocument.props, f('canCreate'))],
      }),
    ],
    body: [
      // The universal record list, placed through a slot: it needs an org id,
      // a user id and a permission decision, none of which may travel through
      // a spec. The spec supplies only the record type and the URL it was
      // already rendering with; `rowActions` names the per-row actions widget
      // (defined in the registry entry) and the slot resolves it per row.
      widgetBlock('record-list-view', {
        recordType: 'customer_invoice',
        basePath: '/ar/invoices',
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'document-drawer', props: { drawer: data.drawer } } : null,
        emptyAction: data.canCreate ? newDocument : null,
        rowActions: { widget: 'document-row-actions', props: { basePath: '/ar/invoices' } },
      }),
    ],
  })
}

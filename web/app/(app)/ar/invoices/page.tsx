import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { RecordListView } from '../../../../components/record-list-view'
import { DocumentDrawer } from '../../../../components/document-drawer'
import { DocumentRowActions } from '../../../../components/document-row-actions'
import { NewDocumentButton } from '../../../../components/new-document-button'
import { pickString } from '../../../../lib/list-params'
import { requirePermission, can } from '../../../../lib/authz'
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
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import { featureEnabled, isFeatureEnabled, resolvedFeatureState } from '../../../../lib/features'
import { PaymentLinksPanel } from '../../../../components/payment-links-panel'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('ar')
  return { title: t('list.title') }
}

/**
 * Customer invoices + credits — the AR document list, a first-class route
 * beside the /ar cockpit (both are one tab-click apart). The list is the
 * universal RecordListView; this page owns the header, the New button, and
 * the ?doc= flyout with its form-layout resolution.
 */
export default async function ArInvoices({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
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
  const sp = await searchParams
  const docId = typeof sp.doc === 'string' ? sp.doc : undefined

  const newItems = [
    { kind: 'customer_invoice', label: t('actions.newInvoice') },
    { kind: 'customer_credit', label: t('actions.newCredit') },
  ]
  const newButton = canCreate ? (
    <NewDocumentButton
      items={newItems}
      basePath="/ar/invoices"
      triggerLabel={t('actions.new')}
      creatingLabel={tCommon('actions.creating')}
      failedLabel={t('toasts.createDraftFailed')}
    />
  ) : undefined


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
    openDoc && pickers && resolvedForm && openKind ? (
      <DocumentDrawer
        payload={openDoc as any}
        key={(openDoc as any).doc.id}
        config={DOC_KINDS[openKind]!}
        basePath="/ar/invoices"
        initialMode={pickString(sp.mode) === 'edit' ? 'edit' : 'view'}
        parties={pickers[0] as any}
        accounts={pickers[1] as any}
        taxCodes={pickers[2] as any}
        taxGroups={pickers[3] as any}
        departments={(pickers[4] as any).departments}
        projects={(pickers[4] as any).projects}
        locations={(pickers[4] as any).locations}
        classes={(pickers[4] as any).classes}
        segments={(pickers[4] as any).segments}
        builtinSegments={(pickers[4] as any).builtinSegments}
        items={pickers[5] as any}
        subsidiaries={(pickers[6] as any) ?? undefined}
        headerDefs={headerDefs as any}
        lineDefs={lineDefs as any}
        canCreate={canCreate}
        canPost={can(authz, 'ar.post')}
        layout={resolvedForm.layout}
        availableLayouts={resolvedForm.available}
        currentLayoutId={resolvedForm.row?.id ?? null}
        recordType={openKind}
        canCustomize={can(authz, 'admin.customization.manage')}
        afterContent={
          openKind === 'customer_invoice' && onlinePaymentsEnabled ? (
            <PaymentLinksPanel documentId={String(openDoc.doc.id)} canManage={canCreate} />
          ) : null
        }
      />
    ) : null

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('list.title')}
          description={t('list.description')}
          actions={newButton}
        />
      }
    >
      <RecordListView
        recordType="customer_invoice"
        basePath="/ar/invoices"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={drawer}
        emptyAction={newButton}
        renderRowActions={(row) => <DocumentRowActions id={row.id} status={row.status} config={DOC_KINDS[row.kind]!} openHref={`/ar/invoices?doc=${row.id}`} />}
      />
    </ListPageLayout>
  )
}

import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { RecordListView } from '../../../components/record-list-view'
import { DocumentDrawer } from '../../../components/document-drawer'
import { DocumentRowActions } from '../../../components/document-row-actions'
import { NewDocumentButton } from '../../../components/new-document-button'
import { pickString } from '../../../lib/list-params'
import { requirePermission, can } from '../../../lib/authz'
import {
  AR_KINDS,
  DOC_KINDS,
  accountOptions,
  dimensionOptions,
  itemOptions,
  loadDocument,
  partyOptions,
  taxCodeOptions,
} from '../../../lib/documents'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { resolveFormLayout } from '../../../lib/customization/resolve'

export const dynamic = 'force-dynamic'

/**
 * Customer invoices + credits — a plain record list (the AP mirror). Per-invoice
 * outstanding balance and open/paid aging live in the AR aging report
 * (/reports/aging), not here. The list is the universal RecordListView; this
 * page owns the header, the New button, and the ?doc= flyout.
 */
export default async function AR({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('ar.read')
  const canCreate = can(authz, 'ar.create')
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
      basePath="/ar"
      triggerLabel={t('actions.new')}
      creatingLabel={tCommon('actions.creating')}
      failedLabel={t('toasts.createDraftFailed')}
    />
  ) : undefined

  // Drawer + form layout resolve only when a flyout is open.
  // Org guard: never render another tenant's document in the drawer.
  const loadedDoc = docId ? await loadDocument(docId) : null
  const openDoc = loadedDoc && loadedDoc.doc.org_id === authz.user.orgId ? loadedDoc : null
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
          dimensionOptions(),
          itemOptions(),
        ])
      : null,
    drawerOpen
      ? resolveFormLayout({
          orgId: authz.user.orgId,
          userId: authz.user.id,
          recordType: openKind!,
          userRoles: [authz.user.role],
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
        config={DOC_KINDS[openKind]!}
        basePath="/ar"
        parties={pickers[0] as any}
        accounts={pickers[1] as any}
        taxCodes={pickers[2] as any}
        departments={(pickers[3] as any).departments}
        projects={(pickers[3] as any).projects}
        locations={(pickers[3] as any).locations}
        classes={(pickers[3] as any).classes}
        items={pickers[4] as any}
        headerDefs={headerDefs as any}
        lineDefs={lineDefs as any}
        canCreate={canCreate}
        canPost={can(authz, 'ar.post')}
        layout={resolvedForm.layout}
        availableLayouts={resolvedForm.available}
        currentLayoutId={resolvedForm.row?.id ?? null}
        recordType={openKind}
        canCustomize={can(authz, 'admin.customization.manage')}
      />
    ) : null

  return (
    <ListPageLayout header={<PageHeader title={t('list.title')} description={t('list.description')} actions={newButton} />}>
      <RecordListView
        recordType="customer_invoice"
        basePath="/ar"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={drawer}
        emptyAction={newButton}
        renderRowActions={(row) => <DocumentRowActions id={row.id} status={row.status} config={DOC_KINDS[row.kind]} />}
      />
    </ListPageLayout>
  )
}

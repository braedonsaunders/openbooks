import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { ScanLine } from 'lucide-react'
import { Button, cn, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { RecordListView } from '../../../../components/record-list-view'
import { DocumentDrawer } from '../../../../components/document-drawer'
import { DocumentRowActions } from '../../../../components/document-row-actions'
import { NewDocumentButton } from '../../../../components/new-document-button'
import { pickString } from '../../../../lib/list-params'
import { requirePermission, can } from '../../../../lib/authz'
import {
  AP_KINDS,
  DOC_KINDS,
  accountOptions,
  dimensionOptions,
  itemOptions,
  loadDocument,
  partyOptions,
  taxCodeOptions,
} from '../../../../lib/documents'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../../lib/customization/resolve'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('ap')
  return { title: t('list.title') }
}

/**
 * Vendor bills + credits — the AP document list, a first-class route beside
 * the /ap cockpit (both are one tab-click apart). The list (search, filters,
 * saved views, sortable typed table, drill-through, pagination) is the
 * universal RecordListView; this page owns the header, the New button, and
 * the ?doc= document flyout with its form-layout resolution.
 */
export default async function ApBills({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('ap.read')
  const canCreate = can(authz, 'ap.create')
  const t = await getTranslations('ap')
  const tCommon = await getTranslations('common')
  const sp = await searchParams
  const docId = typeof sp.doc === 'string' ? sp.doc : undefined

  const newItems = [
    { kind: 'vendor_bill', label: t('actions.newBill') },
    { kind: 'vendor_credit', label: t('actions.newCredit') ?? t('actions.newBill') },
  ]
  const newButton = canCreate ? (
    <NewDocumentButton
      items={newItems}
      basePath="/ap/bills"
      triggerLabel={t('actions.newBill')}
      creatingLabel={tCommon('actions.creating')}
      failedLabel={t('toasts.createDraftFailed')}
    />
  ) : undefined
  const headerActions = (
    <div className="flex items-center gap-2">
      <Button variant="outline" asChild>
        <Link href="/ap/capture"><ScanLine size={14} />{t('actions.capture')}</Link>
      </Button>
      {newButton}
    </div>
  )

  const tHome = await getTranslations('purchasing')
  const tabs = (
    <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
      <Link href={'/purchasing' as any} className={tabCls(false)}>{tHome('home.title')}</Link>
      <Link href="/ap" className={tabCls(false)}>{t('cockpit.tabs.overview')}</Link>
      <Link href={'/ap/bills' as any} className={tabCls(true)}>{t('cockpit.tabs.bills')}</Link>
    </div>
  )

  // Drawer + form layout resolve only when a flyout is open.
  // Org guard: never render another tenant's document in the drawer.
  const loadedDoc = docId ? await loadDocument(docId, authz.user.orgId) : null
  const openDoc = loadedDoc && loadedDoc.doc.org_id === authz.user.orgId
    && (!authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(String(loadedDoc.doc.subsidiary_id)))
    ? loadedDoc : null
  const openKind = openDoc?.doc.kind as string | undefined
  const drawerOpen = !!(openDoc && openKind && (AP_KINDS as readonly string[]).includes(openKind))
  const [headerDefs, lineDefs] = drawerOpen
    ? await Promise.all([loadFieldDefs('documents', openKind!), loadFieldDefs('document_lines', openKind!)])
    : [[], []]
  const [pickers, resolvedForm] = await Promise.all([
    drawerOpen
      ? Promise.all([
          partyOptions('vendor'),
          accountOptions(DOC_KINDS[openKind as 'vendor_bill']!),
          taxCodeOptions(),
          dimensionOptions(),
          itemOptions(),
          // Multi-subsidiary orgs only — null keeps ALL subsidiary UI hidden.
          isMultiSubsidiary().then(async (multi) => {
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
        basePath="/ap/bills"
        parties={pickers[0] as any}
        accounts={pickers[1] as any}
        taxCodes={pickers[2] as any}
        departments={(pickers[3] as any).departments}
        projects={(pickers[3] as any).projects}
        locations={(pickers[3] as any).locations}
        classes={(pickers[3] as any).classes}
        segments={(pickers[3] as any).segments}
        builtinSegments={(pickers[3] as any).builtinSegments}
        items={pickers[4] as any}
        subsidiaries={(pickers[5] as any) ?? undefined}
        headerDefs={headerDefs as any}
        lineDefs={lineDefs as any}
        canCreate={canCreate}
        canPost={can(authz, 'ap.post')}
        layout={resolvedForm.layout}
        availableLayouts={resolvedForm.available}
        currentLayoutId={resolvedForm.row?.id ?? null}
        recordType={openKind}
        canCustomize={can(authz, 'admin.customization.manage')}
      />
    ) : null

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('list.title')}
          description={t('list.description')}
          actions={<div className="flex items-center gap-3">{tabs}{headerActions}</div>}
        />
      }
    >
      <RecordListView
        recordType="vendor_bill"
        basePath="/ap/bills"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={drawer}
        emptyAction={newButton}
        renderRowActions={(row) => <DocumentRowActions id={row.id} status={row.status} config={DOC_KINDS[row.kind]} openHref={`/ap/bills?doc=${row.id}`} />}
      />
    </ListPageLayout>
  )
}

function tabCls(active: boolean) {
  return cn(
    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
    active
      ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
      : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100',
  )
}

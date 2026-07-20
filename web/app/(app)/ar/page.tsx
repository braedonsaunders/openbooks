import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { cn, PageHeader } from '@openbooks/ui'
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
import { isMultiSubsidiary, subsidiaryOptions } from '../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { analyticsConfig } from '../../../lib/analytics/config'
import { arPosition } from '../../../lib/cash/ar-position'
import { ArCockpit } from './cockpit/ArCockpit'

export const dynamic = 'force-dynamic'

/**
 * Accounts Receivable — a workflow cockpit, the AP page's mirror. The default
 * view is the control center (vitals + collections worklist + aging); the
 * Invoices tab holds the universal RecordListView with the ?doc= flyout.
 * Opening a document forces the Invoices view so the list + drawer are in
 * context.
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
  // A document flyout belongs to the Invoices view.
  const view = docId || pickString(sp.view) === 'invoices' ? 'invoices' : 'overview'

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

  const tabs = (
    <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
      <Link href="/ar" className={tabCls(view === 'overview')}>{t('cockpit.tabs.overview')}</Link>
      <Link href={'/ar?view=invoices' as any} className={tabCls(view === 'invoices')}>{t('cockpit.tabs.invoices')}</Link>
    </div>
  )

  // -------------------------------------------------------------- Overview
  if (view === 'overview') {
    const cfg = await analyticsConfig(authz.user.orgId, 'cashflow')
    const apSettings = { weeklyCap: cfg.weeklyApCap ?? 0, restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
    const data = await arPosition(authz.user.orgId, 4, apSettings)
    return (
      <ListPageLayout
        className="flex h-full min-h-0 flex-col"
        header={
          <PageHeader
            title={t('cockpit.title')}
            description={t('cockpit.description')}
            actions={<div className="flex items-center gap-3">{tabs}{newButton}</div>}
          />
        }
      >
        <ArCockpit data={data} canCollect={can(authz, 'ar.pay')} />
      </ListPageLayout>
    )
  }

  // -------------------------------------------------------------- Invoices
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
        basePath="/ar"
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
        canPost={can(authz, 'ar.post')}
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
          actions={<div className="flex items-center gap-3">{tabs}{newButton}</div>}
        />
      }
    >
      <RecordListView
        recordType="customer_invoice"
        basePath="/ar"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={drawer}
        emptyAction={newButton}
        renderRowActions={(row) => <DocumentRowActions id={row.id} status={row.status} config={DOC_KINDS[row.kind]} openHref={`/ar?view=invoices&doc=${row.id}`} />}
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

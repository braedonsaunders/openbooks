import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { ScanLine } from 'lucide-react'
import { Button, cn, PageHeader } from '@openbooks/ui'
import { ListPageLayout, PageContainer } from '../../../components/page-layout'
import { RecordListView } from '../../../components/record-list-view'
import { DocumentDrawer } from '../../../components/document-drawer'
import { DocumentRowActions } from '../../../components/document-row-actions'
import { NewDocumentButton } from '../../../components/new-document-button'
import { pickString } from '../../../lib/list-params'
import { requirePermission, can } from '../../../lib/authz'
import {
  AP_KINDS,
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
import { apPosition } from '../../../lib/cash/ap-position'
import { ApCockpit } from './cockpit/ApCockpit'

export const dynamic = 'force-dynamic'

/**
 * Accounts Payable — a workflow cockpit. The default view is the control
 * center (vitals + pay-run planner + aging); the Bills tab holds the universal
 * RecordListView with the ?doc= document flyout. Opening a document forces the
 * Bills view so the list + drawer are in context.
 */
export default async function AP({
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
  // A document flyout belongs to the Bills view.
  const view = docId || pickString(sp.view) === 'bills' ? 'bills' : 'overview'

  const newItems = [
    { kind: 'vendor_bill', label: t('actions.newBill') },
    { kind: 'vendor_credit', label: t('actions.newCredit') ?? t('actions.newBill') },
  ]
  const newButton = canCreate ? (
    <NewDocumentButton
      items={newItems}
      basePath="/ap"
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

  const tabs = (
    <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
      <Link href="/ap" className={tabCls(view === 'overview')}>{t('cockpit.tabs.overview')}</Link>
      <Link href={'/ap?view=bills' as any} className={tabCls(view === 'bills')}>{t('cockpit.tabs.bills')}</Link>
    </div>
  )

  // -------------------------------------------------------------- Overview
  if (view === 'overview') {
    const cfg = await analyticsConfig(authz.user.orgId, 'cashflow')
    const apSettings = { weeklyCap: cfg.weeklyApCap ?? 0, restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
    const data = await apPosition(authz.user.orgId, 4, apSettings)
    return (
      <PageContainer>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.title')}</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('cockpit.description')}</p>
          </div>
          <div className="flex items-center gap-3">{tabs}{headerActions}</div>
        </div>
        <ApCockpit data={data} />
      </PageContainer>
    )
  }

  // ----------------------------------------------------------------- Bills
  // Drawer + form layout resolve only when a flyout is open.
  // Org guard: never render another tenant's document in the drawer.
  const loadedDoc = docId ? await loadDocument(docId) : null
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
        basePath="/ap"
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
        basePath="/ap"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={drawer}
        emptyAction={newButton}
        renderRowActions={(row) => <DocumentRowActions id={row.id} status={row.status} config={DOC_KINDS[row.kind]} openHref={`/ap?view=bills&doc=${row.id}`} />}
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

import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { RecordListView } from '../../../../components/record-list-view'
import { requirePermission, can } from '../../../../lib/authz'
import { buildListDrawerHref, pickString } from '../../../../lib/list-params'
import {
  BANK_KINDS,
  DOC_KINDS,
  accountOptions,
  bankAccountOptions,
  cardOptions,
  dimensionOptions,
  itemOptions,
  loadDocument,
  taxCodeOptions,
  taxGroupOptions,
} from '../../../../lib/documents'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import { DocumentDrawer } from '../../../../components/document-drawer'
import { DocumentRowActions } from '../../../../components/document-row-actions'
import { NewDocumentButton } from '../../../../components/new-document-button'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('transactionsPage.title') }
}

// The banking transaction kinds that can be created from this page — the
// source platform "Write Checks / Make Deposits / Transfer Funds / Issue Credit Card"
// shortcuts, surfaced as one New menu.
const NEW_KINDS = ['check', 'deposit', 'card_charge', 'card_refund', 'transfer'] as const

// Kinds that keep a bespoke drawer form (no customizable form layout): transfers
// (to/from legs) and deposits (destination bank + source lines).

export default async function BankingTransactions({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('banking.read')
  const canCreate = can(authz, 'ap.create') || can(authz, 'gl.post')
  const t = await getTranslations('banking')
  const tCommon = await getTranslations('common')
  const sp = await searchParams
  const basePath = '/banking/transactions'

  // -- open document drawer (?doc=<id>) -------------------------------------
  const docId = typeof sp.doc === 'string' ? sp.doc : undefined
  // Org guard: never render another tenant's document in the drawer.
  const loadedDoc = docId ? await loadDocument(docId, authz.user.orgId) : null
  const openDoc = loadedDoc && loadedDoc.doc.org_id === authz.user.orgId
    && (!authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(String(loadedDoc.doc.subsidiary_id)))
    ? loadedDoc : null
  const openKind = openDoc?.doc.kind as string | undefined
  const drawerOpen = !!(openDoc && openKind && (BANK_KINDS as readonly string[]).includes(openKind))
  const pickers = drawerOpen
    ? await Promise.all([
        accountOptions(DOC_KINDS[openKind! as 'card_charge']!),
        taxCodeOptions(),
        taxGroupOptions(),
        dimensionOptions(),
        itemOptions(),
        cardOptions(),
        bankAccountOptions(),
        loadFieldDefs('documents', openKind!),
        loadFieldDefs('document_lines', openKind!),
        // Multi-subsidiary orgs only — null keeps ALL subsidiary UI hidden.
        isMultiSubsidiary(authz.user.orgId).then(async (multi) => {
          if (!multi) return null
          const options = await subsidiaryOptions()
          return authz.allowedSubsidiaryIds
            ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id))
            : options
        }),
      ])
    : null
  const resolvedForm = drawerOpen && pickers
    ? await resolveFormLayout({
        orgId: authz.user.orgId,
        userId: authz.user.id,
        recordType: openKind!,
        userRoles: (authz.user as any).roles?.map(({ key }: { key: string }) => key) ?? [authz.user.role],
        headerDefs: pickers[7] as any,
        lineDefs: pickers[8] as any,
        explicitLayoutId: pickString(sp.form),
      })
    : null

  const newItems = NEW_KINDS.map((kind) => ({ kind, label: t(`txKinds.${kind}`) }))

  const cfg = openKind ? DOC_KINDS[openKind] : undefined

  return (
    <ListPageLayout
      header={
        <PageHeader
          back={{ href: '/banking', label: t('home.title') }}
          title={t('transactionsPage.title')}
          description={t('transactionsPage.description')}
          actions={
            canCreate ? (
              <NewDocumentButton
                items={newItems}
                basePath={basePath}
                triggerLabel={t('actions.new')}
                creatingLabel={tCommon('actions.creating')}
                failedLabel={t('toasts.createDraftFailed')}
              />
            ) : undefined
          }
        />
      }
    >
      <RecordListView
        recordType="bank_transaction"
        basePath={basePath}
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        renderRowActions={(row) => (
          <DocumentRowActions
            id={String(row.id)}
            status={String(row.status)}
            config={DOC_KINDS[row.kind]}
            openHref={buildListDrawerHref(basePath, sp, 'doc', String(row.id))}
          />
        )}
        drawer={openDoc && pickers && cfg ? (
          <DocumentDrawer
            payload={openDoc as any}
            config={cfg}
            basePath={basePath}
            initialMode={pickString(sp.mode) === 'edit' ? 'edit' : 'view'}
            accounts={pickers[0] as any}
            taxCodes={pickers[1] as any}
            taxGroups={pickers[2] as any}
            departments={(pickers[3] as any).departments}
            projects={(pickers[3] as any).projects}
            locations={(pickers[3] as any).locations}
            classes={(pickers[3] as any).classes}
            segments={(pickers[3] as any).segments}
            builtinSegments={(pickers[3] as any).builtinSegments}
            items={pickers[4] as any}
            cards={pickers[5] as any}
            bankAccounts={pickers[6] as any}
            subsidiaries={(pickers[9] as any) ?? undefined}
            headerDefs={pickers[7] as any}
            lineDefs={pickers[8] as any}
            canCreate={canCreate}
            canPost={can(authz, 'ap.post') || can(authz, 'gl.post')}
            layout={resolvedForm?.layout}
            availableLayouts={resolvedForm?.available}
            currentLayoutId={resolvedForm?.row?.id ?? null}
            recordType={openKind}
            canCustomize={can(authz, 'admin.customization.manage')}
          />
        ) : null}
      />
    </ListPageLayout>
  )
}

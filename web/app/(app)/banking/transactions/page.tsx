import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { SortTh } from '../../../../components/sortable-th'
import { requirePermission, can } from '../../../../lib/authz'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { money } from '../../../../lib/format'
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
} from '../../../../lib/documents'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import { DocumentDrawer } from '../../../../components/document-drawer'
import { DocumentRowActions } from '../../../../components/document-row-actions'
import { NewDocumentButton } from '../../../../components/new-document-button'
import { DocTypeBadge } from '../../../../components/doc-type-badge'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('transactionsPage.title') }
}

const TX_SORTS = {
  date: sql`d.document_date`,
  number: sql`d.document_number`,
  total: sql`d.total`,
  status: sql`d.status`,
} as const

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  posted: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

// The banking transaction kinds that can be created from this page — the
// NetSuite "Write Checks / Make Deposits / Transfer Funds / Issue Credit Card"
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

  const txParams = parseListParams(sp, {
    sort: 'date',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['date', 'number', 'total', 'status'] as const,
  })
  const txKind = pickString(sp.txKind)
  const txList = sql`(${sql.join(BANK_KINDS.map((kind) => sql`${kind}`), sql`, `)})`
  const allowedIds = authz.allowedSubsidiaryIds ? [...authz.allowedSubsidiaryIds] : []
  const subsidiaryWhere = authz.allowedSubsidiaryIds
    ? allowedIds.length
      ? sql`and d.subsidiary_id = any(${`{${allowedIds.join(',')}}`}::uuid[])`
      : sql`and false`
    : sql``
  const txWhere = sql`d.org_id = ${authz.user.orgId} and d.kind in ${txList}
    ${subsidiaryWhere}
    ${txKind ? sql` and d.kind = ${txKind}` : sql``}
    ${txParams.q ? sql` and (d.document_number ilike ${'%' + txParams.q + '%'} or d.memo ilike ${'%' + txParams.q + '%'} or d.reference_number ilike ${'%' + txParams.q + '%'})` : sql``}`
  const [txRows, txCount, txKindCounts] = (await Promise.all([
    db.execute(sql`
      select d.id, d.kind, d.document_number, d.document_date, d.status, d.total,
             d.reference_number, d.memo, e.id as entry_id
        from documents d
        left join journal_entries e on e.id = d.posted_entry_id
       where ${txWhere}
       order by ${TX_SORTS[txParams.sort]} ${txParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${txParams.perPage} offset ${(txParams.page - 1) * txParams.perPage}
    `),
    db.execute(sql`select count(*) as n from documents d where ${txWhere}`),
    db.execute(sql`select kind, count(*) as n from documents d where d.org_id = ${authz.user.orgId} and d.kind in ${txList} ${subsidiaryWhere} group by kind`),
  ])) as unknown as [{ rows: any[] }, { rows: any[] }, { rows: any[] }]
  const txTotal = Number(txCount.rows[0].n)
  const txKindOptions = txKindCounts.rows.map((r: any) => ({
    value: r.kind,
    label: t(`txKinds.${r.kind}`),
    count: Number(r.n),
  }))

  // -- open document drawer (?doc=<id>) -------------------------------------
  const docId = typeof sp.doc === 'string' ? sp.doc : undefined
  // Org guard: never render another tenant's document in the drawer.
  const loadedDoc = docId ? await loadDocument(docId) : null
  const openDoc = loadedDoc && loadedDoc.doc.org_id === authz.user.orgId
    && (!authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(String(loadedDoc.doc.subsidiary_id)))
    ? loadedDoc : null
  const openKind = openDoc?.doc.kind as string | undefined
  const drawerOpen = !!(openDoc && openKind && (BANK_KINDS as readonly string[]).includes(openKind))
  const pickers = drawerOpen
    ? await Promise.all([
        accountOptions(DOC_KINDS[openKind! as 'card_charge']!),
        taxCodeOptions(),
        dimensionOptions(),
        itemOptions(),
        cardOptions(),
        bankAccountOptions(),
        loadFieldDefs('documents', openKind!),
        loadFieldDefs('document_lines', openKind!),
        // Multi-subsidiary orgs only — null keeps ALL subsidiary UI hidden.
        isMultiSubsidiary().then(async (multi) => {
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
        userRoles: [authz.user.role],
        headerDefs: pickers[6] as any,
        lineDefs: pickers[7] as any,
        explicitLayoutId: pickString(sp.form),
      })
    : null

  const newItems = NEW_KINDS.map((kind) => ({ kind, label: t(`txKinds.${kind}`) }))

  const cfg = openKind ? DOC_KINDS[openKind] : undefined

  return (
    <ListPageLayout
      header={
        <PageHeader
          back={{ href: '/banking', label: t('overview.title') }}
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
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput placeholder={t('transactionsSearch')} />
          <FilterChips basePath={basePath} currentParams={sp} paramKey="txKind" label={tCommon('labels.type')} options={txKindOptions} />
        </div>
        {txTotal === 0 && !txParams.q && !txKind ? (
          <EmptyState title={t('transactionsEmptyTitle')} description={t('transactionsEmptyDescription')} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortTh basePath={basePath} currentParams={sp} column="number" sort={txParams.sort} dir={txParams.dir}>{tCommon('labels.number')}</SortTh>
                  <TableHead>{tCommon('labels.type')}</TableHead>
                  <SortTh basePath={basePath} currentParams={sp} column="date" sort={txParams.sort} dir={txParams.dir}>{tCommon('labels.date')}</SortTh>
                  <TableHead>{tCommon('labels.memo')}</TableHead>
                  <SortTh basePath={basePath} currentParams={sp} column="total" sort={txParams.sort} dir={txParams.dir} align="right">{tCommon('labels.total')}</SortTh>
                  <SortTh basePath={basePath} currentParams={sp} column="status" sort={txParams.sort} dir={txParams.dir}>{tCommon('labels.status')}</SortTh>
                  <TableHead className="w-px px-2"><span className="sr-only">{tCommon('labels.actions')}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {txRows.rows.map((d: any) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Link href={`${basePath}?doc=${d.id}` as any} className="font-mono text-[13px] font-semibold text-teal-700 hover:underline dark:text-teal-300">
                        {d.document_number}
                      </Link>
                    </TableCell>
                    <TableCell><DocTypeBadge kind={d.kind} /></TableCell>
                    <TableCell>{d.document_date}</TableCell>
                    <TableCell className="max-w-xs truncate text-slate-500 dark:text-slate-400">{d.memo ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(d.total)}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[d.status] ?? 'secondary'}>{d.status}</Badge>
                    </TableCell>
                    <TableCell className="w-px px-2 text-center">
                      <DocumentRowActions id={d.id} status={d.status} config={DOC_KINDS[d.kind]} openHref={`${basePath}?doc=${d.id}`} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination basePath={basePath} currentParams={sp} total={txTotal} page={txParams.page} perPage={txParams.perPage} />
          </>
        )}
      </section>

      {openDoc && pickers && cfg ? (
        <DocumentDrawer
          payload={openDoc as any}
          config={cfg}
          basePath={basePath}
          accounts={pickers[0] as any}
          taxCodes={pickers[1] as any}
          departments={(pickers[2] as any).departments}
          projects={(pickers[2] as any).projects}
          locations={(pickers[2] as any).locations}
          classes={(pickers[2] as any).classes}
          segments={(pickers[2] as any).segments}
          builtinSegments={(pickers[2] as any).builtinSegments}
          items={pickers[3] as any}
          cards={pickers[4] as any}
          bankAccounts={pickers[5] as any}
          subsidiaries={(pickers[8] as any) ?? undefined}
          headerDefs={pickers[6] as any}
          lineDefs={pickers[7] as any}
          canCreate={canCreate}
          canPost={can(authz, 'ap.post') || can(authz, 'gl.post')}
          layout={resolvedForm?.layout}
          availableLayouts={resolvedForm?.available}
          currentLayoutId={resolvedForm?.row?.id ?? null}
          recordType={openKind}
          canCustomize={can(authz, 'admin.customization.manage')}
        />
      ) : null}
    </ListPageLayout>
  )
}

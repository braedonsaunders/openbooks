import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { requirePermission, can } from '../../../lib/authz'
import { parseListParams, parsePrefixedListParams, pickString } from '../../../lib/list-params'
import { money } from '../../../lib/format'
import {
  BANK_KINDS,
  DOC_KINDS,
  accountOptions,
  bankAccountOptions,
  cardOptions,
  dimensionOptions,
  loadDocument,
  taxCodeOptions,
} from '../../../lib/documents'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { DocumentDrawer } from '../../../components/document-drawer'
import { DocumentRowActions } from '../../../components/document-row-actions'
import { NewDocumentButton } from '../../../components/new-document-button'
import { DocTypeBadge } from '../../../components/doc-type-badge'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  number: sql`a.number`,
  name: sql`a.name`,
  balance: sql`coalesce(bal.balance, 0)`,
  reconciled: sql`lastrec.through_date`,
  unmatched: sql`coalesce(unm.n, 0)`,
} as const

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

const TYPE_KEYS = ['asset_bank', 'liability_card']

export default async function Banking({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('banking.read')
  const canCreate = can(authz, 'ap.create') || can(authz, 'gl.post')
  const t = await getTranslations('banking')
  const tCommon = await getTranslations('common')
  const typeLabel = (type: string) =>
    TYPE_KEYS.includes(type) ? t(`types.${type}`) : String(type).replace(/_/g, ' ')
  const sp = await searchParams

  // -- accounts list (unprefixed params) ------------------------------------
  const params = parseListParams(sp, {
    sort: 'number',
    dir: 'asc',
    perPage: 25,
    allowedSorts: ['number', 'name', 'balance', 'reconciled', 'unmatched'] as const,
  })
  const type = pickString(sp.type)
  const where = sql`a.org_id = ${authz.user.orgId} and a.reconcilable and not a.is_summary
    ${type ? sql` and a.type = ${type}` : sql``}
    ${params.q ? sql` and (a.number ilike ${'%' + params.q + '%'} or a.name ilike ${'%' + params.q + '%'})` : sql``}`

  const [accounts, typeCounts, filtered] = (await Promise.all([
    db.execute(sql`
      select a.id, a.number, a.name, a.type, a.currency_restriction, a.is_active,
             coalesce(bal.balance, 0) as balance,
             lastrec.through_date as reconciled_through,
             coalesce(unm.n, 0) as unmatched_lines,
             openrec.id as open_reconciliation_id
        from accounts a
        left join lateral (
          select sum(jl.amount) as balance
            from journal_lines jl
            join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
           where jl.account_id = a.id) bal on true
        left join lateral (
          select max(r.through_date) as through_date
            from reconciliations r
           where r.account_id = a.id and r.status = 'signed_off') lastrec on true
        left join lateral (
          select count(*) as n
            from bank_statement_lines l
            join bank_statements s on s.id = l.statement_id
           where s.account_id = a.id and l.match_status = 'unmatched') unm on true
        left join lateral (
          select r.id from reconciliations r
           where r.account_id = a.id and r.status <> 'signed_off'
           order by r.created_at desc limit 1) openrec on true
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `),
    db.execute(sql`
      select a.type, count(*) as n from accounts a
       where a.org_id = ${authz.user.orgId} and a.reconcilable and not a.is_summary group by a.type order by a.type
    `),
    db.execute(sql`select count(*) as n from accounts a where ${where}`),
  ])) as unknown as [{ rows: any[] }, { rows: any[] }, { rows: any[] }]

  const total = typeCounts.rows.reduce((a: number, r: any) => a + Number(r.n), 0)
  const filteredTotal = Number(filtered.rows[0].n)
  const typeOptions = typeCounts.rows.map((r: any) => ({
    value: r.type,
    label: typeLabel(r.type),
    count: Number(r.n),
  }))

  // -- transactions list (prefixed: tx*) — card charges, refunds, checks, transfers
  const txParams = parsePrefixedListParams(sp, 'tx', {
    sort: 'date',
    dir: 'desc',
    perPage: 15,
    allowedSorts: ['date', 'number', 'total', 'status'] as const,
  })
  const txKind = pickString(sp.txKind)
  const txList = sql`(${BANK_KINDS.map((k) => `'${k}'`).join(',')})`
  const txWhere = sql`d.org_id = ${authz.user.orgId} and d.kind in ${txList}
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
    db.execute(sql`select kind, count(*) as n from documents d where d.org_id = ${authz.user.orgId} and d.kind in ${txList} group by kind`),
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
  const openDoc = loadedDoc && loadedDoc.doc.org_id === authz.user.orgId ? loadedDoc : null
  const openKind = openDoc?.doc.kind as string | undefined
  const drawerOpen = !!(openDoc && openKind && (BANK_KINDS as readonly string[]).includes(openKind))
  const pickers = drawerOpen
    ? await Promise.all([
        accountOptions(DOC_KINDS[openKind! as 'card_charge']!),
        taxCodeOptions(),
        dimensionOptions().then((d) => d.departments),
        dimensionOptions().then((d) => d.projects),
        cardOptions(),
        bankAccountOptions(),
        loadFieldDefs('documents', openKind!),
        loadFieldDefs('document_lines', openKind!),
      ])
    : null
  // Transfers keep their bespoke form; the line-based banking kinds resolve a
  // customizable form layout like AP/AR.
  const resolvedForm = drawerOpen && pickers && openKind !== 'transfer'
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

  const newItems = [
    { kind: 'check', label: t('txKinds.check') },
    { kind: 'card_charge', label: t('txKinds.card_charge') },
    { kind: 'card_refund', label: t('txKinds.card_refund') },
    { kind: 'transfer', label: t('txKinds.transfer') },
  ]

  const cfg = openKind ? DOC_KINDS[openKind] : undefined

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('list.title')}
          description={t('list.description')}
          actions={
            canCreate ? (
              <NewDocumentButton
                items={newItems}
                basePath="/banking"
                triggerLabel={t('actions.new')}
                creatingLabel={tCommon('actions.creating')}
                failedLabel={t('toasts.createDraftFailed')}
              />
            ) : undefined
          }
        />
      }
    >
      {/* -- Accounts ---------------------------------------------------- */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-sm font-semibold text-slate-900 dark:text-slate-100">{t('accountsTitle')}</h2>
          <SearchInput placeholder={t('list.searchPlaceholder')} />
          <FilterChips basePath="/banking" currentParams={sp} paramKey="type" label={tCommon('labels.type')} options={typeOptions} />
        </div>
        {total === 0 ? (
          <EmptyState title={t('list.emptyTitle')} description={t('list.emptyDescription')} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortTh basePath="/banking" currentParams={sp} column="number" sort={params.sort} dir={params.dir}>{tCommon('labels.account')}</SortTh>
                  <SortTh basePath="/banking" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>{tCommon('labels.name')}</SortTh>
                  <TableHead>{tCommon('labels.type')}</TableHead>
                  <SortTh basePath="/banking" currentParams={sp} column="balance" sort={params.sort} dir={params.dir} align="right">{t('list.columns.glBalance')}</SortTh>
                  <SortTh basePath="/banking" currentParams={sp} column="reconciled" sort={params.sort} dir={params.dir}>{t('list.columns.reconciledThrough')}</SortTh>
                  <SortTh basePath="/banking" currentParams={sp} column="unmatched" sort={params.sort} dir={params.dir} align="right">{t('list.columns.unmatchedLines')}</SortTh>
                  <TableHead>{tCommon('labels.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.rows.map((a: any) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-[13px] font-semibold">
                      <Link href={`/banking/${a.id}` as any} className="text-teal-700 hover:underline dark:text-teal-300">
                        {a.number ?? '—'}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/banking/${a.id}` as any} className="hover:underline">
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-slate-500 dark:text-slate-400">
                      {typeLabel(a.type)}
                      {a.currency_restriction ? ` · ${a.currency_restriction}` : ''}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(a.balance)}</TableCell>
                    <TableCell>{a.reconciled_through ?? <span className="text-slate-400 dark:text-slate-500">{t('labels.never')}</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(a.unmatched_lines).toLocaleString()}</TableCell>
                    <TableCell>
                      {a.open_reconciliation_id ? (
                        <Badge variant="warning">{t('list.badges.reconciling')}</Badge>
                      ) : Number(a.unmatched_lines) > 0 ? (
                        <Badge variant="secondary">{t('list.badges.linesToMatch')}</Badge>
                      ) : (
                        <Badge variant="success">{t('list.badges.upToDate')}</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination basePath="/banking" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </>
        )}
      </section>

      {/* -- Transactions (card charges, refunds, checks, transfers) ------ */}
      <section className="mt-8 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-sm font-semibold text-slate-900 dark:text-slate-100">{t('transactionsTitle')}</h2>
          <SearchInput placeholder={t('transactionsSearch')} paramKey="txQ" pageParamKey="txPage" />
          <FilterChips basePath="/banking" currentParams={sp} paramKey="txKind" label={tCommon('labels.type')} options={txKindOptions} pageParamKey="txPage" />
        </div>
        {txTotal === 0 && !txParams.q && !txKind ? (
          <EmptyState title={t('transactionsEmptyTitle')} description={t('transactionsEmptyDescription')} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortTh basePath="/banking" currentParams={sp} column="number" sort={txParams.sort} dir={txParams.dir} sortParamKey="txSort" dirParamKey="txDir" pageParamKey="txPage">{tCommon('labels.number')}</SortTh>
                  <TableHead>{tCommon('labels.type')}</TableHead>
                  <SortTh basePath="/banking" currentParams={sp} column="date" sort={txParams.sort} dir={txParams.dir} sortParamKey="txSort" dirParamKey="txDir" pageParamKey="txPage">{tCommon('labels.date')}</SortTh>
                  <TableHead>{tCommon('labels.memo')}</TableHead>
                  <SortTh basePath="/banking" currentParams={sp} column="total" sort={txParams.sort} dir={txParams.dir} sortParamKey="txSort" dirParamKey="txDir" pageParamKey="txPage" align="right">{tCommon('labels.total')}</SortTh>
                  <SortTh basePath="/banking" currentParams={sp} column="status" sort={txParams.sort} dir={txParams.dir} sortParamKey="txSort" dirParamKey="txDir" pageParamKey="txPage">{tCommon('labels.status')}</SortTh>
                  <TableHead>{tCommon('labels.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {txRows.rows.map((d: any) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Link href={`/banking?doc=${d.id}` as any} className="font-mono text-[13px] font-semibold text-teal-700 hover:underline dark:text-teal-300">
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
                    <TableCell>
                      <DocumentRowActions id={d.id} status={d.status} config={DOC_KINDS[d.kind]} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination basePath="/banking" currentParams={sp} total={txTotal} page={txParams.page} perPage={txParams.perPage} pageParamKey="txPage" />
          </>
        )}
      </section>

      {openDoc && pickers && cfg ? (
        <DocumentDrawer
          payload={openDoc as any}
          config={cfg}
          basePath="/banking"
          accounts={pickers[0] as any}
          taxCodes={pickers[1] as any}
          departments={pickers[2] as any}
          projects={pickers[3] as any}
          cards={pickers[4] as any}
          bankAccounts={pickers[5] as any}
          headerDefs={pickers[6] as any}
          lineDefs={pickers[7] as any}
          canCreate={canCreate}
          canPost={can(authz, 'ap.post') || can(authz, 'gl.post')}
          layout={resolvedForm?.layout}
          availableLayouts={resolvedForm?.available}
          currentLayoutId={resolvedForm?.row?.id ?? null}
          recordType={openKind !== 'transfer' ? openKind : undefined}
          canCustomize={can(authz, 'admin.customization.manage')}
        />
      ) : null}
    </ListPageLayout>
  )
}

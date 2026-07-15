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
import { parseListParams, pickString } from '../../../lib/list-params'
import { money } from '../../../lib/format'
import { requirePermission, can } from '../../../lib/authz'
import {
  AR_KINDS,
  DOC_KINDS,
  accountOptions,
  dimensionOptions,
  loadDocument,
  partyOptions,
  taxCodeOptions,
} from '../../../lib/documents'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { DocumentDrawer } from '../../../components/document-drawer'
import { DocumentRowActions } from '../../../components/document-row-actions'
import { NewDocumentButton } from '../../../components/new-document-button'
import { DocTypeBadge } from '../../../components/doc-type-badge'

export const dynamic = 'force-dynamic'

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'secondary' | 'warning' | 'outline'> = {
  open: 'default',
  paid: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

const STATUS_ORDER = ['draft', 'pending_approval', 'approved', 'open', 'paid', 'voided']

const STATUS_KEYS: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  posted: 'posted',
  open: 'open',
  paid: 'paid',
  voided: 'voided',
}

const SORT_COLUMNS = {
  date: sql`d.document_date`,
  number: sql`d.document_number`,
  customer: sql`p.display_name`,
  total: sql`d.total`,
  balance: sql`case when d.status = 'posted' and d.kind = 'customer_invoice' then d.total - ap.applied end`,
  status: sql`d.status`,
} as const

/** Sum of un-reversed applications against the posted entry's AR open item. */
const APPLIED_JOIN = sql`
  left join lateral (
    select coalesce(sum(a.amount), 0) as applied
      from journal_lines jl
      join applications a on a.to_line_id = jl.id and a.unapplied_at is null
     where jl.entry_id = d.posted_entry_id and jl.is_open_item
  ) ap on true`

export default async function AR({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('ar.read')
  const canCreate = can(authz, 'ar.create')
  const t = await getTranslations('ar')
  const tCommon = await getTranslations('common')
  const statusLabel = (bucket: string) =>
    STATUS_KEYS[bucket] ? tCommon(`status.${STATUS_KEYS[bucket]}`) : bucket.replace('_', ' ')
  const sp = await searchParams
  const docId = typeof sp.doc === 'string' ? sp.doc : undefined
  const params = parseListParams(sp, {
    sort: 'date',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['date', 'number', 'customer', 'total', 'balance', 'status'] as const,
  })
  const status = pickString(sp.status)
  const kind = pickString(sp.kind)

  // Only invoices resolve to open/paid buckets (credits' applied flows the
  // opposite direction). The status filter honours both bucket and raw status.
  const statusFilter =
    status === 'open'
      ? sql` and d.status = 'posted' and d.kind = 'customer_invoice' and ap.applied < d.total`
      : status === 'paid'
        ? sql` and d.status = 'posted' and d.kind = 'customer_invoice' and ap.applied >= d.total`
        : status
          ? sql` and d.status = ${status}`
          : sql``
  const where = sql`d.org_id = ${authz.user.orgId} and d.kind in ('customer_invoice','customer_credit')
    ${kind ? sql` and d.kind = ${kind}` : sql``}
    ${statusFilter}
    ${params.q ? sql` and (d.document_number ilike ${'%' + params.q + '%'} or p.display_name ilike ${'%' + params.q + '%'} or d.reference_number ilike ${'%' + params.q + '%'})` : sql``}`

  const [invoices, counts] = await Promise.all([
    db.execute(sql`
      select d.id, d.kind, d.document_number, d.document_date, d.status, d.total,
             d.reference_number, p.display_name as customer, e.id as entry_id,
             case when d.status = 'posted' and d.kind = 'customer_invoice' then d.total - ap.applied end as balance,
             case when d.status = 'posted' and d.kind = 'customer_invoice'
                  then case when ap.applied >= d.total then 'paid' else 'open' end
                  else d.status end as bucket
        from documents d
        left join parties p on p.id = d.party_id
        left join journal_entries e on e.id = d.posted_entry_id
        ${APPLIED_JOIN}
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select case when d.status = 'posted' and d.kind = 'customer_invoice'
                  then case when ap.applied >= d.total then 'paid' else 'open' end
                  else d.status end as bucket,
             count(*) as n
        from documents d
        ${APPLIED_JOIN}
       where d.org_id = ${authz.user.orgId} and d.kind in ('customer_invoice','customer_credit')
       group by 1
    `) as any,
  ])
  const total = counts.rows.reduce((a: number, r: any) => a + Number(r.n), 0)
  const filteredTotal = status || params.q || kind
    ? Number(((await db.execute(sql`
        select count(*) as n from documents d
          left join parties p on p.id = d.party_id
          ${APPLIED_JOIN}
         where ${where}`)) as any).rows[0].n)
    : total

  // Org guard: never render another tenant's document in the drawer.
  const loadedDoc = docId ? await loadDocument(docId) : null
  const openDoc = loadedDoc && loadedDoc.doc.org_id === authz.user.orgId ? loadedDoc : null
  const openKind = openDoc?.doc.kind as string | undefined
  const drawerOpen = !!(openDoc && openKind && (AR_KINDS as readonly string[]).includes(openKind))
  const pickers = drawerOpen
    ? await Promise.all([
        partyOptions('customer'),
        accountOptions(DOC_KINDS[openKind! as 'customer_invoice']!),
        taxCodeOptions(),
        dimensionOptions().then((d) => d.departments),
        dimensionOptions().then((d) => d.projects),
        loadFieldDefs('documents', openKind!),
        loadFieldDefs('document_lines', openKind!),
      ])
    : null
  const resolvedForm = drawerOpen && pickers
    ? await resolveFormLayout({
        orgId: authz.user.orgId,
        userId: authz.user.id,
        recordType: openKind!,
        userRoles: [authz.user.role],
        headerDefs: pickers[5] as any,
        lineDefs: pickers[6] as any,
        explicitLayoutId: pickString(sp.form),
      })
    : null

  const kindOptions = [
    { value: 'customer_invoice', label: t('kinds.invoice') },
    { value: 'customer_credit', label: t('kinds.credit') },
  ]
  const kindCounts = (await db.execute(sql`
    select kind, count(*) as n from documents
     where org_id = ${authz.user.orgId} and kind in ('customer_invoice','customer_credit') group by kind
  `)) as any
  for (const r of kindCounts.rows as any[]) {
    const opt = kindOptions.find((o) => o.value === r.kind)
    if (opt) (opt as any).count = Number(r.n)
  }

  const statusOptions = counts.rows
    .slice()
    .sort((a: any, b: any) => STATUS_ORDER.indexOf(a.bucket) - STATUS_ORDER.indexOf(b.bucket))
    .map((r: any) => ({
      value: r.bucket,
      label: statusLabel(String(r.bucket)),
      count: Number(r.n),
    }))

  const newItems = [
    { kind: 'customer_invoice', label: t('actions.newInvoice') },
    { kind: 'customer_credit', label: t('actions.newCredit') },
  ]

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description')}
            actions={
              canCreate ? (
                <NewDocumentButton
                  items={newItems}
                  basePath="/ar"
                  triggerLabel={t('actions.new')}
                  creatingLabel={tCommon('actions.creating')}
                  failedLabel={t('toasts.createDraftFailed')}
                />
              ) : undefined
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <FilterChips basePath="/ar" currentParams={sp} paramKey="kind" label={tCommon('labels.type')} options={kindOptions as any} />
            <FilterChips basePath="/ar" currentParams={sp} paramKey="status" label={tCommon('labels.status')} options={statusOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title={t('list.emptyTitle')}
          description={t('list.emptyDescription')}
          action={
            canCreate ? (
              <NewDocumentButton
                items={newItems}
                basePath="/ar"
                triggerLabel={t('actions.new')}
                creatingLabel={tCommon('actions.creating')}
                failedLabel={t('toasts.createDraftFailed')}
              />
            ) : undefined
          }
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/ar" currentParams={sp} column="number" sort={params.sort} dir={params.dir}>{t('list.columns.number')}</SortTh>
                <SortTh basePath="/ar" currentParams={sp} column="customer" sort={params.sort} dir={params.dir}>{tCommon('labels.customer')}</SortTh>
                <SortTh basePath="/ar" currentParams={sp} column="date" sort={params.sort} dir={params.dir}>{tCommon('labels.date')}</SortTh>
                <TableHead>{t('list.columns.ref')}</TableHead>
                <SortTh basePath="/ar" currentParams={sp} column="total" sort={params.sort} dir={params.dir} align="right">{tCommon('labels.total')}</SortTh>
                <SortTh basePath="/ar" currentParams={sp} column="balance" sort={params.sort} dir={params.dir} align="right">{tCommon('labels.balance')}</SortTh>
                <SortTh basePath="/ar" currentParams={sp} column="status" sort={params.sort} dir={params.dir}>{tCommon('labels.status')}</SortTh>
                <TableHead>{tCommon('labels.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.rows.map((inv: any) => (
                <TableRow key={inv.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <DocTypeBadge kind={inv.kind} />
                      <Link href={`/ar?doc=${inv.id}`} className="font-mono text-[13px] font-semibold text-teal-700 hover:underline dark:text-teal-300">
                        {inv.document_number}
                      </Link>
                    </div>
                  </TableCell>
                  <TableCell>{inv.customer}</TableCell>
                  <TableCell>{inv.document_date}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{inv.reference_number}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(inv.total)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {inv.balance == null ? (
                      <span className="text-slate-400 dark:text-slate-500">—</span>
                    ) : (
                      money(inv.balance)
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[inv.bucket] ?? 'secondary'}>
                      {statusLabel(String(inv.bucket))}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <DocumentRowActions id={inv.id} status={inv.status} config={DOC_KINDS[inv.kind]} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/ar" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {openDoc && pickers && openDoc.doc.kind ? (
        <DocumentDrawer
          payload={openDoc as any}
          config={DOC_KINDS[openDoc.doc.kind as string]!}
          basePath="/ar"
          parties={pickers[0] as any}
          accounts={pickers[1] as any}
          taxCodes={pickers[2] as any}
          departments={pickers[3] as any}
          projects={pickers[4] as any}
          headerDefs={pickers[5] as any}
          lineDefs={pickers[6] as any}
          canCreate={canCreate}
          canPost={can(authz, 'ar.post')}
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

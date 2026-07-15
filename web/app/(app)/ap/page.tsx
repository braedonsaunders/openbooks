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
import { ViewsMenu } from '../../../components/views-menu'
import { parseListParams, pickString } from '../../../lib/list-params'
import { money } from '../../../lib/format'
import { requirePermission, can } from '../../../lib/authz'
import {
  AP_KINDS,
  DOC_KINDS,
  accountOptions,
  dimensionOptions,
  loadDocument,
  partyOptions,
  taxCodeOptions,
} from '../../../lib/documents'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { resolveFormLayout, resolveListView } from '../../../lib/customization/resolve'
import {
  VENDOR_BILL_SORTS,
  vendorBillColumnDescriptors,
  vendorBillWhere,
  type ListColDesc,
} from '../../../lib/customization/list-query'
import { DocumentDrawer } from '../../../components/document-drawer'
import { DocumentRowActions } from '../../../components/document-row-actions'
import { NewDocumentButton } from '../../../components/new-document-button'
import { DocTypeBadge } from '../../../components/doc-type-badge'

export const dynamic = 'force-dynamic'

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'secondary' | 'warning' | 'outline'> = {
  posted: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

const STATUS_KEYS: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  posted: 'posted',
  voided: 'voided',
}

const ALLOWED_SORTS = ['number', 'vendor', 'date', 'total', 'status'] as const
type SortKey = (typeof ALLOWED_SORTS)[number]

export default async function AP({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('ap.read')
  const canCreate = can(authz, 'ap.create')
  const t = await getTranslations('ap')
  const tCommon = await getTranslations('common')
  const tCustom = await getTranslations('customization')
  const statusLabel = (status: string) => {
    const key = STATUS_KEYS[status]
    return key ? tCommon(`status.${key}`) : status.replace('_', ' ')
  }
  const sp = await searchParams
  const docId = typeof sp.doc === 'string' ? sp.doc : undefined
  const viewIdParam = pickString(sp.view)

  // Header defs (documents) double as list custom columns (showInList) + drawer
  // header custom fields; line defs feed the drawer line grid.
  const [headerDefs, lineDefs] = await Promise.all([
    loadFieldDefs('documents', 'vendor_bill'),
    loadFieldDefs('document_lines', 'vendor_bill'),
  ])
  const showInListDefs = headerDefs.filter((d) => d.config.showInList)

  // Resolve the effective saved list view (explicit ?view → user default → org → system).
  const resolvedView = await resolveListView({
    orgId: authz.user.orgId,
    userId: authz.user.id,
    recordType: 'vendor_bill',
    viewId: viewIdParam,
    showInListDefs,
  })
  const view = resolvedView.view
  const viewName = resolvedView.row?.name ?? tCustom('views.defaultName')

  const defaultSort: SortKey =
    view.sort && (ALLOWED_SORTS as readonly string[]).includes(view.sort.column)
      ? (view.sort.column as SortKey)
      : 'date'
  const params = parseListParams(sp, {
    sort: defaultSort,
    dir: view.sort?.dir ?? 'desc',
    perPage: view.perPage ?? 25,
    allowedSorts: ALLOWED_SORTS,
  })
  const status = pickString(sp.status)
  const kind = pickString(sp.kind)

  const cols = vendorBillColumnDescriptors(view, showInListDefs, {
    actions: tCommon('labels.actions'),
    document_number: t('list.columns.bill'),
    party_name: tCommon('labels.vendor'),
    document_date: tCommon('labels.date'),
    reference_number: t('list.columns.ref'),
    total: tCommon('labels.total'),
    status: tCommon('labels.status'),
  })

  const selectCols = sql.join(
    cols.filter((c) => c.expr).map((c) => sql`${c.expr} as ${sql.raw(`"${c.key}"`)}`),
    sql`, `,
  )
  const where = vendorBillWhere(
    view,
    { q: params.q, status, kind, vendor: pickString(sp.vendor), from: pickString(sp.from), to: pickString(sp.to) },
    AP_KINDS,
    authz.user.orgId,
  )

  const [bills, counts, totalRow] = await Promise.all([
    db.execute(sql`
      select d.id, d.kind, ${selectCols}
        from documents d
        left join parties p on p.id = d.party_id
       where ${where}
       order by ${VENDOR_BILL_SORTS[params.sort] ?? sql`d.document_date`} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`select d.status, count(*) as n from documents d where d.org_id = ${authz.user.orgId} and d.kind in (${sql.join(AP_KINDS.map((k) => sql`${k}`), sql`, `)}) group by d.status`) as any,
    db.execute(sql`select count(*) as n from documents d left join parties p on p.id = d.party_id where ${where}`) as any,
  ])
  const total = counts.rows.reduce((a: number, r: any) => a + Number(r.n), 0)
  const filteredTotal = Number(totalRow.rows[0].n)

  // Drawer + form layout resolve only when a flyout is open.
  // Org guard: never render another tenant's document in the drawer.
  const loadedDoc = docId ? await loadDocument(docId) : null
  const openDoc = loadedDoc && loadedDoc.doc.org_id === authz.user.orgId ? loadedDoc : null
  const openKind = openDoc?.doc.kind as string | undefined
  const drawerOpen = !!(openDoc && openKind && (AP_KINDS as readonly string[]).includes(openKind))
  const [pickers, resolvedForm] = await Promise.all([
    drawerOpen
      ? Promise.all([
          partyOptions('vendor'),
          accountOptions(DOC_KINDS[openKind as 'vendor_bill']!),
          taxCodeOptions(),
          dimensionOptions().then((d) => d.departments),
          dimensionOptions().then((d) => d.projects),
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

  const kindOptions = [
    { value: 'vendor_bill', label: t('kinds.bill') },
    { value: 'vendor_credit', label: t('kinds.credit') },
  ]
  const kindCounts = (await db.execute(sql`
    select kind, count(*) as n from documents
     where org_id = ${authz.user.orgId} and kind in (${sql.join(AP_KINDS.map((k) => sql`${k}`), sql`, `)}) group by kind
  `)) as any
  for (const r of kindCounts.rows as any[]) {
    const opt = kindOptions.find((o) => o.value === r.kind)
    if (opt) (opt as any).count = Number(r.n)
  }

  const statusOptions = counts.rows.map((r: any) => ({
    value: r.status,
    label: statusLabel(String(r.status)),
    count: Number(r.n),
  }))

  const newItems = [
    { kind: 'vendor_bill', label: t('actions.newBill') },
    { kind: 'vendor_credit', label: t('actions.newCredit') ?? t('actions.newBill') },
  ]

  const cellFor = (b: any, c: ListColDesc) => {
    const v = b[c.key]
    switch (c.kind) {
      case 'reference':
        return (
          <TableCell key={c.key}>
            <div className="flex items-center gap-2">
              <DocTypeBadge kind={b.kind} />
              <Link href={`/ap?doc=${b.id}`} className="font-mono text-[13px] font-semibold text-teal-700 hover:underline dark:text-teal-300">
                {String(v ?? '')}
              </Link>
            </div>
          </TableCell>
        )
      case 'amount':
        return (
          <TableCell key={c.key} className="text-right tabular-nums">{money(v)}</TableCell>
        )
      case 'status':
        return (
          <TableCell key={c.key}>
            <Badge variant={STATUS_VARIANT[String(v)] ?? 'secondary'}>{statusLabel(String(v))}</Badge>
          </TableCell>
        )
      case 'custom': {
        const def = showInListDefs.find((d) => d.key === c.defKey)
        let display: string
        if (Array.isArray(v)) display = v.join(', ')
        else if (def?.fieldType === 'boolean') display = v ? tCommon('labels.yes') : tCommon('labels.no')
        else display = v != null && v !== '' ? String(v) : '—'
        return <TableCell key={c.key} className="text-slate-700 dark:text-slate-300">{display}</TableCell>
      }
      case 'actions':
        return (
          <TableCell key={c.key}>
            <DocumentRowActions id={b.id} status={b.status} config={DOC_KINDS[b.kind]} />
          </TableCell>
        )
      default:
        return (
          <TableCell key={c.key} className={v == null || v === '' ? 'text-slate-400' : ''}>
            {v != null && v !== '' ? String(v) : '—'}
          </TableCell>
        )
    }
  }

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
                  basePath="/ap"
                  triggerLabel={t('actions.newBill')}
                  creatingLabel={tCommon('actions.creating')}
                  failedLabel={t('toasts.createDraftFailed')}
                />
              ) : undefined
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <FilterChips basePath="/ap" currentParams={sp} paramKey="kind" label={tCommon('labels.type')} options={kindOptions as any} />
            <FilterChips basePath="/ap" currentParams={sp} paramKey="status" label={tCommon('labels.status')} options={statusOptions} />
            <ViewsMenu
              available={resolvedView.available}
              currentId={resolvedView.row?.id ?? null}
              currentName={viewName}
              recordType="vendor_bill"
              basePath="/ap"
              currentParams={sp}
              canManage={can(authz, 'admin.customization.manage')}
            />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title={t('list.empty.title')}
          description={t('list.empty.description')}
          action={
            canCreate ? (
              <NewDocumentButton
                items={newItems}
                basePath="/ap"
                triggerLabel={t('actions.newBill')}
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
                {cols.map((c) =>
                  c.kind === 'actions' ? (
                    <TableHead key={c.key}>{c.label}</TableHead>
                  ) : c.sortable && c.sortKey ? (
                    <SortTh key={c.key} basePath="/ap" currentParams={sp} column={c.sortKey} sort={params.sort} dir={params.dir} align={c.kind === 'amount' ? 'right' : undefined}>
                      {c.label}
                    </SortTh>
                  ) : (
                    <TableHead key={c.key} className={c.kind === 'amount' ? 'text-right' : undefined}>{c.label}</TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {bills.rows.map((b: any) => (
                <TableRow key={b.id}>{cols.map((c) => cellFor(b, c))}</TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/ap" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {openDoc && pickers && resolvedForm && openKind ? (
        <DocumentDrawer
          payload={openDoc as any}
          config={DOC_KINDS[openKind]!}
          basePath="/ap"
          parties={pickers[0] as any}
          accounts={pickers[1] as any}
          taxCodes={pickers[2] as any}
          departments={pickers[3] as any}
          projects={pickers[4] as any}
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
      ) : null}
    </ListPageLayout>
  )
}

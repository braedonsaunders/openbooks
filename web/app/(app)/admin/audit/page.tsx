import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { Button, EmptyState, PageHeader } from '@openbooks/ui'
import { BookOpen, ScrollText } from 'lucide-react'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { DateRangeFilter } from '../../../../components/date-range-filter'
import { Pagination } from '../../../../components/pagination'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { AuditRows, type AuditListRow } from './AuditRows'
import { AuditEventDrawer, type AuditEvent } from './AuditEventDrawer'

export const dynamic = 'force-dynamic'

// Raw record-type tokens (table names or document kinds like "customer_invoice")
// → friendly labels: "Customer Invoice", "Journal Entry", "Budget Scenarios".
const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// Known audit actions with translated labels (admin.audit.actions.*); anything
// else in the log renders verbatim as the stored action code.
const KNOWN_ACTIONS = new Set(['insert', 'update', 'delete', 'post', 'void', 'approve', 'reject'])

export default async function Audit({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('admin.audit.read')
  const t = await getTranslations('admin.audit')
  const tHub = await getTranslations('admin.hub')
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'at', allowedSorts: ['at'] as const, perPage: 50 })
  const action = pickString(sp.action)
  const rtype = pickString(sp.rtype)
  const actor = pickString(sp.actor)
  const from = pickString(sp.from)
  const to = pickString(sp.to)
  const eventId = pickString(sp.event)

  // Effective record type: the raw table for most rows, but the document's KIND
  // (customer_invoice, vendor_bill, journal_entry, …) for the shared `documents`
  // table so the filter splits it into its transaction types. Deleted documents
  // recover their kind from the immutable before snapshot.
  const rtypeExpr = sql`case when a.table_name = 'documents'
    then coalesce(d.kind, a.changes #>> '{before,document,kind}', 'documents')
    else a.table_name end`
  const auditFrom = sql`
    from audit_log a
    left join users u on u.id = a.actor_id and u.org_id = a.org_id
    left join documents d on a.table_name = 'documents' and d.id = a.row_id and d.org_id = a.org_id`

  const where = sql`a.org_id = ${authz.user.orgId}
    ${action ? sql` and a.action = ${action}` : sql``}
    ${rtype ? sql` and (${rtypeExpr}) = ${rtype}` : sql``}
    ${actor ? (actor === 'system' ? sql` and a.actor_id is null` : sql` and a.actor_id = ${actor}`) : sql``}
    ${from ? sql` and a.at >= ${from}::date` : sql``}
    ${to ? sql` and a.at < (${to}::date + interval '1 day')` : sql``}
    ${params.q ? sql` and ((${rtypeExpr}) ilike ${'%' + params.q + '%'} or u.name ilike ${'%' + params.q + '%'} or a.row_id::text = ${params.q})` : sql``}`

  const [rows, totalRow, actions, rtypes, users, selectedResult] = await Promise.all([
    (db.execute(sql`
      select a.id, a.row_id, a.action, a.at, u.name as actor_name, (${rtypeExpr}) as rtype,
             case
               when a.changes ? 'before' or a.changes ? 'after' then 'snapshot'
               when a.changes ->> 'source' = 'record_metadata' then 'metadata'
               else 'fields'
             end as summary_kind,
             (select count(*)
                from jsonb_object_keys(
                  case when jsonb_typeof(a.changes) = 'object' then a.changes else '{}'::jsonb end
                ) as changed_key(key)
               where changed_key.key not in ('source', 'mode', 'reason', 'before', 'after')) as change_count
        ${auditFrom}
       where ${where}
       order by a.at desc
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `)),
    db.execute(sql`select count(*) as n ${auditFrom} where ${where}`) as any,
    (db.execute(sql`
      select action, count(*) as n
        from audit_log
       where org_id = ${authz.user.orgId}
       group by 1 order by 2 desc
    `)),
    (db.execute(sql`
      select (${rtypeExpr}) as rtype, count(*) as n
        ${auditFrom}
       where a.org_id = ${authz.user.orgId}
       group by 1 order by 2 desc limit 60
    `)),
    (db.execute(sql`
      select a.actor_id, u.name, count(*) as n
        from audit_log a left join users u on u.id = a.actor_id and u.org_id = a.org_id
       where a.org_id = ${authz.user.orgId}
       group by 1, 2 order by 3 desc limit 50
    `)),
    eventId && isUuid(eventId)
      ? (db.execute(sql`
          select a.id, a.row_id, a.action, a.at, a.request_id, a.changes,
                 u.name as actor_name, (${rtypeExpr}) as rtype
            ${auditFrom}
           where a.id = ${eventId} and a.org_id = ${authz.user.orgId}
           limit 1
        `))
      : Promise.resolve({ rows: [] }),
  ])
  const total = Number(totalRow.rows[0].n)
  const actionLabel = (a: string) => (KNOWN_ACTIONS.has(a) ? t(`actions.${a}`) : a)
  const auditRows: AuditListRow[] = rows.rows.map((row: any) => ({
    id: row.id,
    rowId: row.row_id,
    at: new Date(row.at).toISOString(),
    actorName: row.actor_name,
    action: row.action,
    recordType: row.rtype,
    summaryKind: row.summary_kind,
    changeCount: Number(row.change_count),
  }))
  const selectedRow = selectedResult.rows[0] as any | undefined
  const selectedEvent: AuditEvent | null = selectedRow ? {
    id: selectedRow.id,
    rowId: selectedRow.row_id,
    at: new Date(selectedRow.at).toISOString(),
    actorName: selectedRow.actor_name,
    action: selectedRow.action,
    recordType: selectedRow.rtype,
    requestId: selectedRow.request_id,
    changes: selectedRow.changes,
  } : null
  const closeHref = mergeHref('/admin/audit', sp, { event: null })

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: '/admin', label: tHub('title') }}
            title={t('title')}
            description={t('description')}
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link href="/docs/audit-log">
                  <BookOpen size={15} aria-hidden /> {t('documentation')}
                </Link>
              </Button>
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('searchPlaceholder')} />
            <FilterChips
              basePath="/admin/audit"
              currentParams={sp}
              paramKey="rtype"
              label={t('recordTypeFilter')}
              options={rtypes.rows.map((r: any) => ({ value: r.rtype, label: humanize(r.rtype), count: Number(r.n) }))}
            />
            <FilterChips
              basePath="/admin/audit"
              currentParams={sp}
              paramKey="actor"
              label={t('userFilter')}
              options={users.rows.map((r: any) => ({
                value: r.actor_id ?? 'system',
                label: r.name ?? t('systemActor'),
                count: Number(r.n),
              }))}
            />
            <FilterChips
              basePath="/admin/audit"
              currentParams={sp}
              paramKey="action"
              label={t('actionFilter')}
              options={actions.rows.map((r: any) => ({ value: r.action, label: actionLabel(r.action), count: Number(r.n) }))}
            />
            <DateRangeFilter fromLabel={t('dateFrom')} toLabel={t('dateTo')} clearLabel={t('clearDates')} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          icon={<ScrollText />}
          title={t('empty.title')}
          description={t('empty.description')}
        />
      ) : (
        <>
          <AuditRows rows={auditRows} selectedId={selectedEvent?.id} />
          <div className="mt-3">
            <Pagination basePath="/admin/audit" currentParams={sp} total={total} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {selectedEvent ? <AuditEventDrawer event={selectedEvent} closeHref={closeHref} /> : null}
    </ListPageLayout>
  )
}

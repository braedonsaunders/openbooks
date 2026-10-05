import { defineRoute } from '@/lib/api/route'
import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { assertAnyPermission, ScopeNotFoundError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { can, guardSubsidiaryScope } from '../../../../lib/authz';
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";
import { isAuditRecordTable } from '@/lib/audit-record-types'


const ACTIONS = ['insert', 'update', 'delete', 'post', 'void', 'approve', 'reject'] as const

function documentReadPermission(kind: string): string {
  if (kind === 'expense_report') return 'expenses.read'
  if (kind === 'journal' || kind === 'deposit' || kind === 'transfer') return 'gl.read'
  if (kind === 'cash_sale' || kind === 'cash_refund') return 'cash_sales.read'
  if (kind === 'customer_invoice' || kind === 'customer_credit' || kind === 'customer_payment'
    || kind === 'quote' || kind === 'sales_order') return 'ar.read'
  return 'ap.read'
}

export const GET = defineRoute({
  public: 'session',
  handler: async ({ request, authz }) => {

    const table = new URL(request.url).searchParams.get('table')
    const recordId = new URL(request.url).searchParams.get('id')
    if (!isAuditRecordTable(table) || !recordId || !isUuid(recordId)) {
      return NextResponse.json({ error: 'invalid record' }, { status: 400 })
    }

    // Permission before existence (canonical shape 4 in
    // engine/src/organization/subsidiary-scope.ts): a caller holding none of
    // the table family's permissions learns nothing — an existing record and a
    // missing id answer the same uniform 404, never a 403 naming the needed
    // permission. The kind is unknown before the lookup, so the family gate
    // admits every document-read permission here; the kind check below narrows
    // it, still as a uniform 404.
    const compensation = table === 'payroll_compensation_packages' || table === 'payroll_compensation_versions' || table === 'payroll_compensation_assignments'
    const family = compensation ? ['payroll.read'] : table === 'parties'
      ? ['parties.read']
      : (table === 'hrm_benefit_enrollments' || table === 'hrm_benefit_programs' || table === 'hrm_benefit_plans' || table === 'entitlement_plans') ? ['hrm.benefits.read']
      : table === 'item_rate_versions'
        ? ['admin.setup.manage']
        : ['ar.read', 'ap.read', 'gl.read', 'expenses.read']
    try {
      assertAnyPermission((permission) => can(authz, permission), family)
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound("record")
      throw error
    }

    if ((table === 'hrm_benefit_enrollments' || table === 'hrm_benefit_programs' || table === 'hrm_benefit_plans' || table === 'entitlement_plans') && !await isFeatureEnabled(authz.user.orgId, 'hrm')) return notFound('record')

    if (table === 'entitlement_plans' && !await isFeatureEnabled(authz.user.orgId, 'payroll')) return notFound('record')
    if (compensation && !await isFeatureEnabled(authz.user.orgId, 'payroll')) return notFound('record')

    // Existence, kind, and creator metadata are disclosures too: resolve the
    // record's subsidiary alongside org scope and gate BEFORE anything is
    // returned. Documents follow the documents-list rule (null fails closed);
    // parties follow the party-list rule (null-subsidiary rows are org-wide).
    const record = table === 'payroll_compensation_packages' || table === 'payroll_compensation_assignments'
      ? (await db.execute<{ org_id: string; kind: string; created_at: Date; created_by: string | null; updated_at: Date; updated_by: string | null; subsidiaryId: string | null }>(sql`
          select org_id,${table}::text as kind,created_at,created_by,updated_at,updated_by,subsidiary_id as "subsidiaryId"
          from ${table === 'payroll_compensation_packages' ? sql`payroll_compensation_packages` : sql`payroll_compensation_assignments`} where org_id=${authz.user.orgId} and id=${recordId}`))
      : table === 'payroll_compensation_versions'
      ? (await db.execute<{ org_id: string; kind: string; created_at: Date; created_by: string | null; updated_at: Date; updated_by: string | null; subsidiaryId: string | null }>(sql`
          select v.org_id,'payroll_compensation_versions'::text as kind,v.created_at,v.created_by,v.updated_at,v.updated_by,p.subsidiary_id as "subsidiaryId"
          from payroll_compensation_versions v join payroll_compensation_packages p on p.org_id=v.org_id and p.id=v.package_id
          where v.org_id=${authz.user.orgId} and v.id=${recordId}`))
      : table === 'hrm_benefit_plans'
      ? (await db.execute<{ org_id: string; kind: string; created_at: Date; created_by: string | null; updated_at: Date; updated_by: string | null; subsidiaryId: string | null }>(sql`
          select org_id, 'benefit_program' as kind, created_at, created_by, updated_at, updated_by, employer_subsidiary_id as "subsidiaryId"
          from hrm_benefit_plans where org_id=${authz.user.orgId} and id=${recordId}`))
      : table === 'entitlement_plans'
      ? (await db.execute<{ org_id: string; kind: string; created_at: Date; created_by: string | null; updated_at: Date; updated_by: string | null; subsidiaryId: string | null }>(sql`
          select org_id, 'benefit_program' as kind, created_at, created_by, updated_at, updated_by, null::uuid as "subsidiaryId"
          from entitlement_plans where org_id=${authz.user.orgId} and id=${recordId}`))
      : table === 'hrm_benefit_programs'
      ? (await db.execute<{ org_id: string; kind: string; created_at: Date; created_by: string | null; updated_at: Date; updated_by: string | null; subsidiaryId: string | null }>(sql`
          select org_id, 'benefit_program' as kind, created_at, created_by, updated_at, updated_by, legal_entity_id as "subsidiaryId"
          from hrm_benefit_programs where org_id=${authz.user.orgId} and id=${recordId}`))
      : table === 'documents'
      ? (await db.execute<{ org_id: string; kind: string; created_at: Date; created_by: string | null; updated_at: Date; updated_by: string | null; subsidiaryId: string | null }>(sql`
          select org_id, kind, created_at, created_by, updated_at, updated_by,
                 subsidiary_id as "subsidiaryId"
            from documents where id = ${recordId} and org_id = ${authz.user.orgId}`))
      : table === 'hrm_benefit_enrollments' ? (await db.execute<{ org_id: string; kind: string; created_at: Date; created_by: string | null; updated_at: Date; updated_by: string | null; subsidiaryId: string | null }>(sql`
          select e.org_id,'benefit_enrollment' as kind,e.created_at,e.created_by,e.updated_at,e.updated_by,
                 w.employer_subsidiary_id as "subsidiaryId"
          from hrm_benefit_enrollments e join worker_employments w on w.org_id=e.org_id and w.id=e.employment_id
          where e.org_id=${authz.user.orgId} and e.id=${recordId}`))
      : table === 'parties' ? (await db.execute<{ org_id: string; kind: string; created_at: Date; created_by: string | null; updated_at: Date; updated_by: string | null; subsidiaryId: string | null }>(sql`
          select org_id, 'party' as kind, created_at, created_by, updated_at, updated_by,
                 subsidiary_id as "subsidiaryId"
            from parties where id = ${recordId} and org_id = ${authz.user.orgId}`))
      : (await db.execute<{ org_id: string; kind: string; created_at: Date; created_by: string | null; updated_at: Date; updated_by: string | null; subsidiaryId?: string | null }>(sql`
          select org_id, 'labor_rate_card' as kind, created_at, created_by, updated_at, updated_by
            from item_rate_versions where id = ${recordId} and org_id = ${authz.user.orgId}`))
    const metadata = record.rows[0]
    if (!metadata) return notFound("record")
    if (table === 'item_rate_versions') {
      // Rate-card versions carry no subsidiary_id of their own: their
      // subsidiary lineage lives in labor_rate_version_scopes, so the shared
      // record gate above cannot see it. A version naming only another
      // subsidiary prices none of this caller's work, so its history is that
      // subsidiary's material and stays hidden behind the same uniform 404.
      // Versions with no subsidiary rows price every subsidiary and stay
      // visible to restricted callers, exactly as the pricing engine treats
      // them (web/lib/item-rates.ts versionScopePredicate).
      const allowed = authz.allowedSubsidiaryIds
      if (allowed !== null) {
        const scopeRows = await db.execute<{ subsidiaryId: string | null }>(sql`
          select s.scope_value_id as "subsidiaryId"
            from labor_rate_version_scopes s
           where s.org_id = ${authz.user.orgId} and s.version_id = ${recordId}
             and s.scope_type = 'subsidiary'`)
        const named = scopeRows.rows
          .map((row) => row.subsidiaryId)
          .filter((id): id is string => id !== null)
        if (named.length > 0 && !named.some((id) => allowed.has(id))) {
          return notFound("record")
        }
      }
    } else {
      const denied = guardSubsidiaryScope(authz, metadata.subsidiaryId ?? null,
        table === 'parties' || table === 'hrm_benefit_programs' || table === 'hrm_benefit_plans' || table === 'entitlement_plans' ? { orgWideNull: true } : {})
      if (denied) return denied
    }
    const permission = compensation ? 'payroll.read' : (table === 'hrm_benefit_enrollments' || table === 'hrm_benefit_programs' || table === 'hrm_benefit_plans' || table === 'entitlement_plans') ? 'hrm.benefits.read' : table === 'parties' ? 'parties.read' : table === 'item_rate_versions' ? 'admin.setup.manage' : documentReadPermission(String(metadata.kind))
    // Wrong-kind callers learn nothing either: the kind-specific permission
    // fails closed with the same uniform 404, so an ar.read-only caller cannot
    // distinguish an existing AP bill from a missing id (and symmetrically).
    if (!can(authz, permission)) return notFound("record")

    const q = new URL(request.url).searchParams.get('q')?.trim().slice(0, 120) ?? ''
    const requestedAction = new URL(request.url).searchParams.get('action') ?? ''
    const action = (ACTIONS as readonly string[]).includes(requestedAction) ? requestedAction : ''
    const page = Math.max(1, Number.parseInt(new URL(request.url).searchParams.get('page') ?? '1', 10) || 1)
    const perPage = 15

    const enrollmentEvents = table === 'hrm_benefit_enrollments' ? sql`
      union all
      select b.id::text,b.kind as action,jsonb_build_object('reason',b.reason) as changes,b.actor as actor_id,b.recorded_at as at,null::text as request_id
      from hrm_benefit_events b where b.org_id=${authz.user.orgId} and b.enrollment_id=${recordId}
    ` : sql``
    const events = sql`
      select a.id::text as id, a.action, a.changes, a.actor_id, a.at, a.request_id
        from audit_log a
       where a.org_id = ${authz.user.orgId} and a.table_name = ${table} and a.row_id = ${recordId}
      union all
      select ${`${recordId}:created`} as id, 'insert' as action,
             jsonb_build_object('source', 'record_metadata', 'event', 'record_created') as changes,
             ${metadata.created_by}::uuid as actor_id, ${metadata.created_at}::timestamptz as at,
             null::text as request_id
       where not exists (
         select 1 from audit_log a
          where a.org_id = ${authz.user.orgId} and a.table_name = ${table}
            and a.row_id = ${recordId} and a.action = 'insert'
       )
      ${enrollmentEvents}
    `
    const filters = sql`
      ${action ? sql`and e.action = ${action}` : sql``}
      ${q ? sql`and (e.action ilike ${`%${q}%`} or coalesce(u.name, '') ilike ${`%${q}%`} or e.changes::text ilike ${`%${q}%`})` : sql``}
    `

    const [rows, count] = await Promise.all([
      (db.execute(sql`
        with events as (${events})
        select e.id, e.action, e.changes, e.at, e.request_id, u.name as actor_name
          from events e left join users u on u.id = e.actor_id
         where true ${filters}
         order by e.at desc, e.id desc
         limit ${perPage} offset ${(page - 1) * perPage}`)),
      (db.execute(sql`
        with events as (${events})
        select count(*) as n from events e left join users u on u.id = e.actor_id
         where true ${filters}`)),
    ])

    return NextResponse.json({
      rows: rows.rows,
      total: Number(count.rows[0]?.n ?? 0),
      page,
      perPage,
      actions: ACTIONS,
      recordType: String(metadata.kind),
    })

  },
})

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { FieldTicketsList, type TicketListRow } from './FieldTicketsList'

export const dynamic = 'force-dynamic'

/**
 * Field tickets — the signed crew timesheets T&M invoices are built from.
 * Feature-gated: /admin/setup/features → Field Tickets.
 */
export default async function FieldTicketsPage() {
  const authz = await requirePermission('time.read')
  const orgId = authz.user.orgId
  if (!(await isFeatureEnabled(orgId, 'fieldTickets'))) notFound()
  const t = await getTranslations('fieldTickets')

  const [tickets, projects] = await Promise.all([
    db.execute(sql`
      select d.id, d.document_number, d.status, d.document_date::text as document_date, d.total,
             d.custom->'fieldTicket'->>'period' as period,
             d.custom->'fieldTicket'->>'periodStart' as period_start,
             d.custom->'fieldTicket'->>'periodEnd' as period_end,
             (d.custom->'fieldTicket'->'signatures'->'customer'->>'at') as signed_at,
             (d.custom->'fieldTicket'->'send'->>'sentAt') as sent_at,
             cust.display_name as customer_name, p.name as project_name, p.code as project_code,
             fm.display_name as foreman_name,
             (select coalesce(sum(te.hours), 0) from time_entries te where te.field_ticket_id = d.id) as total_hours
        from documents d
        left join parties cust on cust.id = d.party_id
        left join projects p on p.id = d.project_id
        left join parties fm on fm.id = (d.custom->'fieldTicket'->>'foremanPartyId')::uuid
       where d.org_id = ${orgId} and d.kind = 'field_ticket'
       order by d.document_date desc, d.created_at desc
       limit 500`) as unknown as Promise<{ rows: TicketListRow[] }>,
    db.execute(sql`
      select id, code, name from projects where org_id = ${orgId} and is_active order by name`) as unknown as Promise<{
      rows: { id: string; code: string | null; name: string }[]
    }>,
  ])

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
      </div>
      <FieldTicketsList
        tickets={tickets.rows}
        projects={projects.rows.map((p) => ({ id: p.id, label: p.code ? `${p.code} · ${p.name}` : p.name }))}
      />
    </div>
  )
}

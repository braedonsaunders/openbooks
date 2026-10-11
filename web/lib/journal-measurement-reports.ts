import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/db'
import { subsidiaryVisibleFilter } from '@openbooks/engine/organization/scope'
import { getTranslations } from 'next-intl/server'
import { statementBookIdsExpr } from './gl-summary'
import type { ExportData } from './report-pdf'

/** Retained measurements and physical audit assignments share native report rendering and exports. */
export async function journalMeasurementExportData(kind: 'statistical-journal' | 'gl-audit-numbers', input: {
  orgId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; from: string; to: string; label: string; bookId?: string | null;
}): Promise<ExportData> {
  const t = await getTranslations('reports.journalMeasurements')
  const audit = kind === 'gl-audit-numbers'
  const rows = audit ? (await db.execute<{ number: string; entry: string; date: string; entity: string; period: string; book: string }>(sql`
    select n.audit_number as number,e.entry_number as entry,e.posting_date::text as date,s.name as entity,p.name as period,b.name as book
      from gl_audit_number_assignments n join journal_entries e on e.org_id=n.org_id and e.id=n.entry_id
      join subsidiaries s on s.org_id=n.org_id and s.id=n.subsidiary_id
      join accounting_periods p on p.org_id=n.org_id and p.id=n.period_id
      join accounting_books b on b.org_id=n.org_id and b.id=n.book_id
     where n.org_id=${input.orgId} and e.posting_date between ${input.from}::date and ${input.to}::date
       and n.book_id in ${statementBookIdsExpr(input.orgId,input.bookId)}
       ${subsidiaryVisibleFilter(sql`n.subsidiary_id`,input.allowedSubsidiaryIds)}
     order by e.posting_date,n.book_id,n.subsidiary_id,n.scope_key,n.ordinal`)).rows
    : (await db.execute<{ entry: string; date: string; entity: string; account: string; quantity: string; unit: string; department: string | null }>(sql`
    select e.entry_number as entry,e.posting_date::text as date,s.name as entity,concat_ws(' ',a.number,a.name) as account,
      l.quantity::text,l.unit,d.name as department
      from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id
      join accounts a on a.org_id=l.org_id and a.id=l.account_id and a.type='statistical'
      join subsidiaries s on s.org_id=l.org_id and s.id=l.subsidiary_id
      left join departments d on d.org_id=l.org_id and d.id=l.department_id
     where l.org_id=${input.orgId} and e.status in ('posted','reversed') and e.posting_date between ${input.from}::date and ${input.to}::date
       and e.book_id in ${statementBookIdsExpr(input.orgId,input.bookId)}
       ${subsidiaryVisibleFilter(sql`l.subsidiary_id`,input.allowedSubsidiaryIds)}
     order by e.posting_date,e.entry_number,l.line_number`)).rows
  const keys = audit ? ['number','entry','date','entity','period','book'] : ['entry','date','entity','account','quantity','unit','department']
  return { title: t(audit ? 'auditTitle' : 'statisticalTitle'), dateRangeLabel: input.label,
    groups: [{ kind: 'results', title: t(audit ? 'auditTitle' : 'statisticalTitle'), columns: keys.map(key => t(key)),
      rows: rows.map(row => keys.map(key => (row as Record<string, unknown>)[key] as string ?? '')), money: keys.map(() => false),
      align: keys.map(key => key === 'quantity' ? 'right' : 'left') }] }
}

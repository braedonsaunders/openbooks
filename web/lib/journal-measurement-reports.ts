import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/db'
import { canonicalPeriodLabelSql, periodDisplayLabelSql } from '@openbooks/engine/periods/period-policy'
import { subsidiaryVisibleFilter } from '@openbooks/engine/organization/scope'
import { getTranslations } from 'next-intl/server'
import { statementBookIdsExpr } from './gl-summary'
import type { ExportData } from './report-pdf'

/**
 * Retained measurements and physical audit assignments share native report
 * rendering and exports. The audit register's period column reads as every
 * period list labels it in the viewer's `locale` (`P07 FY2026 · Jul 2026`);
 * without a viewer locale it carries the locale-free canonical label.
 */
export async function journalMeasurementExportData(kind: 'statistical-journal' | 'gl-audit-numbers', input: {
  orgId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; from: string; to: string; label: string; bookId?: string | null;
  locale?: string;
}): Promise<ExportData> {
  const t = await getTranslations('reports.journalMeasurements')
  const audit = kind === 'gl-audit-numbers'
  const periodLabel = input.locale ? periodDisplayLabelSql(input.locale, 'p') : canonicalPeriodLabelSql('p')
  const rows = audit ? (await db.execute<{ number: string; entry: string; date: string; entity: string; period: string; book: string }>(sql`
    select n.audit_number as number,e.entry_number as entry,e.posting_date::text as date,s.name as entity,${periodLabel} as period,b.name as book
      from gl_audit_number_assignments n join journal_entries e on e.org_id=n.org_id and e.id=n.entry_id
      join subsidiaries s on s.org_id=n.org_id and s.id=n.subsidiary_id
      join accounting_periods p on p.org_id=n.org_id and p.id=n.period_id
      join accounting_books b on b.org_id=n.org_id and b.id=n.book_id
     where n.org_id=${input.orgId} and e.posting_date between ${input.from}::date and ${input.to}::date
       and n.book_id in ${statementBookIdsExpr(input.orgId,input.bookId)}
       ${subsidiaryVisibleFilter(sql`n.subsidiary_id`,input.allowedSubsidiaryIds)}
     order by e.posting_date,n.book_id,n.subsidiary_id,n.scope_key,n.ordinal`, 'objects')).map(row => [row.number,row.entry,row.date,row.entity,row.period,row.book])
    : (await db.execute<{ entry: string; date: string; entity: string; account: string; quantity: string; unit: string; department: string | null }>(sql`
    select e.entry_number as entry,e.posting_date::text as date,s.name as entity,concat_ws(' ',a.number,a.name) as account,
      l.quantity::text,l.unit,d.name as department
      from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id
      join accounts a on a.org_id=l.org_id and a.id=l.account_id and a.type='statistical'
      join subsidiaries s on s.org_id=l.org_id and s.id=l.subsidiary_id
      left join departments d on d.org_id=l.org_id and d.id=l.department_id
     where l.org_id=${input.orgId} and e.status in ('posted','reversed') and l.posting_date >= ${input.from}::date and l.posting_date <= ${input.to}::date
       and e.posting_date between ${input.from}::date and ${input.to}::date
       and e.book_id in ${statementBookIdsExpr(input.orgId,input.bookId)}
       ${subsidiaryVisibleFilter(sql`l.subsidiary_id`,input.allowedSubsidiaryIds)}
     order by e.posting_date,e.entry_number,l.line_number`, 'objects')).map(row => [row.entry,row.date,row.entity,row.account,row.quantity ?? '',row.unit ?? '',row.department ?? ''])
  const keys = audit ? ['number','entry','date','entity','period','book'] : ['entry','date','entity','account','quantity','unit','department']
  return { title: t(audit ? 'auditTitle' : 'statisticalTitle'), dateRangeLabel: input.label, summary: [],
    groups: [{ kind: 'results', title: t(audit ? 'auditTitle' : 'statisticalTitle'), columns: keys.map(key => t(key)),
      rows, money: keys.map(() => false),
      align: keys.map(key => key === 'quantity' ? 'right' : 'left') }] }
}

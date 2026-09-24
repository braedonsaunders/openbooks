import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { isReportUuidParam } from '../../../../../lib/report-filters'
import { getAuthz, can } from '../../../../../lib/authz'
import { PAYROLL_RESTRICTED_PARTY_LABEL, collapseRestrictedPayrollLines } from '../../../../../lib/payroll-confidentiality'

export const runtime = 'nodejs'

/**
 * Rich read-only detail for one journal entry, used by the reports EntryFlyout
 * so drilling from a statement opens the transaction as a flyout. Returns the
 * entry header, its source document (so the
 * flyout can escalate to the full editable transaction drawer), and every line
 * enriched with account/party/dimension names.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!can(authz, 'gl.read') && !can(authz, 'reports.read')) {
    return NextResponse.json({ error: 'missing permission: gl.read or reports.read' }, { status: 403 })
  }
  const { id } = await params
  if (!isReportUuidParam(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const subsidiaryFilter = authz.allowedSubsidiaryIds
    ? authz.allowedSubsidiaryIds.size > 0
      ? sql`and e.subsidiary_id in ${[...authz.allowedSubsidiaryIds]}`
      : sql`and false`
    : sql``
  const lineSubsidiaryFilter = authz.allowedSubsidiaryIds
    ? authz.allowedSubsidiaryIds.size > 0
      ? sql`and l.subsidiary_id in ${[...authz.allowedSubsidiaryIds]}`
      : sql`and false`
    : sql``

  const e = (await db.execute<Record<string, unknown>>(sql`
    select e.id, e.entry_number, e.posting_date::text as date, e.memo, e.origin, e.status,
           e.source_document_id,
           re.entry_number as reverses_number,
           d.id as doc_id, d.kind as doc_kind, d.document_number as doc_number
      from journal_entries e
      left join journal_entries re on re.id = e.reverses_entry_id and re.org_id = e.org_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where e.id = ${id} and e.org_id = ${authz.user.orgId}
       ${subsidiaryFilter}
  `))
  const entry = e.rows[0]
  if (!entry) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const lines = (await db.execute<Record<string, unknown>>(sql`
    select l.line_number, l.amount, l.memo, l.is_open_item,
           l.contributor_kind, l.contributor_ref,
           coalesce(ar.name, us.name) as contributor_name,
           a.id as account_id, a.number as account_number, a.name as account_name,
           p.display_name as party, l.party_id, d.name as department, pr.name as project,
           doc.kind as doc_kind, e.origin as entry_origin
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join parties p on p.id = l.party_id and p.org_id = l.org_id
      left join departments d on d.id = l.department_id and d.org_id = l.org_id
      left join projects pr on pr.id = l.project_id and pr.org_id = l.org_id
      left join allocation_rule_versions arv on arv.id = l.contributor_ref and arv.org_id = l.org_id
      left join allocation_rules ar on ar.id = arv.rule_id and ar.org_id = arv.org_id
      left join user_scripts us on us.id = l.contributor_ref and us.org_id = l.org_id
      left join documents doc on doc.id = e.source_document_id and doc.org_id = e.org_id
     where l.entry_id = ${id} and l.org_id = ${authz.user.orgId}
       ${lineSubsidiaryFilter}
     order by l.line_number
  `))

  // Without payroll.read the collapsed line keeps the account and the summed
  // amount but names no employee and shows no per-employee memo or amount.
  // party_id is dropped from the response: it would otherwise carry the first
  // grouped employee's id past the collapse.
  const canSeePayroll = can(authz, 'payroll.read')
  type FlyoutLine = Record<string, unknown> & {
    amount: string
    entryId: string
    accountId: string
    partyId: string | null
    payrollOrigin: boolean
  }
  const mapped: FlyoutLine[] = lines.rows.map((row) => ({
    ...row,
    amount: row.amount as string,
    entryId: id,
    accountId: row.account_id as string,
    partyId: (row.party_id ?? null) as string | null,
    payrollOrigin: row.doc_kind === 'pay_run' || row.entry_origin === 'payroll',
  }))
  const confidential = canSeePayroll ? mapped : collapseRestrictedPayrollLines(
    mapped,
    (first, total) => ({
      ...first, party: PAYROLL_RESTRICTED_PARTY_LABEL, party_id: null, memo: null, amount: total,
    }),
  )
  const shaped = confidential.map((row) => {
    // Strip every collapse input/output key so the response keeps its
    // original shape: no party ids and no origin markers reach the client.
    const {
      party_id: _partyId, doc_kind: _docKind, entry_origin: _entryOrigin,
      entryId: _entryId, accountId: _accountId, partyId: _partyUuid, payrollOrigin: _payrollOrigin,
      ...rest
    } = row
    return rest
  })

  return NextResponse.json({ entry, lines: shaped })
}

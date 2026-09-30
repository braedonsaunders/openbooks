import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { isReportUuidParam } from '../../../../../lib/report-filters'
import { getAuthz, can } from '../../../../../lib/authz'
import { PAYROLL_RESTRICTED_PARTY_LABEL, collapseRestrictedPayrollLines } from '../../../../../lib/payroll-confidentiality'
import { notFound } from "@/lib/api/responses";
import { loadJournalDoc } from '@/lib/journals'
import { loadFieldDefs } from '@/lib/custom-fields'
import { customSegmentOptions } from '@/lib/segments'
import { resolveFormLayout } from '@/lib/customization/resolve'


export const runtime = 'nodejs'

/**
 * Rich read-only detail for one journal entry, used by the reports EntryFlyout
 * so drilling from a statement opens the transaction as a flyout. Returns the
 * entry header, its source document (so the
 * flyout can escalate to the full editable transaction drawer), and every line
 * enriched with account/party/dimension names.
 */
export const GET = defineRoute({
  public: 'session',
  handler: async ({ request: req, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = await getAuthz()
    if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const journalDrawer = new URL(req.url).searchParams.get('journal') === '1'
    if (journalDrawer && !can(authz, 'gl.read')) {
      return NextResponse.json({ error: 'missing permission: gl.read' }, { status: 403 })
    }
    if (!can(authz, 'gl.read') && !can(authz, 'reports.read')) {
        return NextResponse.json({ error: 'missing permission: gl.read or reports.read' }, { status: 403 })
      }
    const { id } = await params
    if (!isReportUuidParam(id)) return notFound("record")
    const subsidiaryFilter = authz.allowedSubsidiaryIds
        ? authz.allowedSubsidiaryIds.size > 0
          ? journalDrawer
            ? sql`and exists (select 1 from journal_lines visible where visible.entry_id = e.id
                and visible.org_id = e.org_id and visible.subsidiary_id in ${[...authz.allowedSubsidiaryIds]})`
            : sql`and e.subsidiary_id in ${[...authz.allowedSubsidiaryIds]}`
          : sql`and false`
        : sql``
    const lineSubsidiaryFilter = authz.allowedSubsidiaryIds
        ? authz.allowedSubsidiaryIds.size > 0
          ? sql`and l.subsidiary_id in ${[...authz.allowedSubsidiaryIds]}`
          : sql`and false`
        : sql``
    const e = (await db.execute<Record<string, unknown>>(sql`
        select e.id, e.entry_number, e.posting_date::text as date, e.memo, e.origin, e.status,
               e.source_document_id, e.subsidiary_id, ${journalDrawer ? sql`e.custom,` : sql``}
               re.entry_number as reverses_number,
               d.id as doc_id, d.kind as doc_kind, d.document_number as doc_number
          from journal_entries e
          left join journal_entries re on re.id = e.reverses_entry_id and re.org_id = e.org_id
          left join lateral (
            select source.id, source.kind, source.document_number from documents source
             where source.org_id = e.org_id and (source.id = e.source_document_id
                or (e.source_document_id is null and source.posted_entry_id = e.id))
             order by source.id limit 1
          ) d on true
         where e.id = ${id} and e.org_id = ${authz.user.orgId}
           ${subsidiaryFilter}
      `))
    const entry = e.rows[0]
    if (!entry) return notFound("record")
    const lines = (await db.execute<Record<string, unknown>>(sql`
        select l.line_number, l.amount, l.memo, l.is_open_item,
               l.subsidiary_id, sub.name as subsidiary, sub.base_currency as functional_currency,
               l.extra_dims, ${journalDrawer ? sql`l.custom,` : sql``}
               l.contributor_kind, l.contributor_ref,
               coalesce(ar.name, us.name) as contributor_name,
               a.id as account_id, a.number as account_number, a.name as account_name,
               p.display_name as party, l.party_id, d.name as department, pr.name as project,
               doc.kind as doc_kind, e.origin as entry_origin
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          join accounts a on a.id = l.account_id and a.org_id = l.org_id
          join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
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
    const canSeePayroll = can(authz, 'payroll.read')
    const restrictedPayroll = !canSeePayroll && (entry.origin === 'payroll' || entry.doc_kind === 'pay_run')
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
        // Currency/entity boundaries must survive confidentiality grouping
        // when the native journal drawer displays functional-currency totals.
        accountId: journalDrawer ? `${row.account_id}:${row.subsidiary_id}:${row.functional_currency}` : row.account_id as string,
        partyId: (row.party_id ?? null) as string | null,
        payrollOrigin: row.doc_kind === 'pay_run' || row.entry_origin === 'payroll',
      }))
    const confidential = canSeePayroll ? mapped : collapseRestrictedPayrollLines(
        mapped,
        (first, total) => ({
          ...first, party: PAYROLL_RESTRICTED_PARTY_LABEL, party_id: null, memo: null, custom: {}, amount: total,
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
    // Only the current journal document offers document actions. Historical
    // generations and subledger postings remain immutable ledger snapshots.
    const sourceJournal = journalDrawer && entry.doc_kind === 'journal' && entry.doc_id
      ? await loadJournalDoc(String(entry.doc_id), authz.user.orgId, authz.allowedSubsidiaryIds)
      : null
    const currentJournal = sourceJournal?.doc.entry_id === id ? sourceJournal : null
    const journalHeader = currentJournal ? {
      doc: {
        ...currentJournal.doc,
        ...(restrictedPayroll ? { party_id: null, party_name: null, custom: {} } : {}),
      },
      // The drawer displays the immutable, confidentiality-shaped GL lines.
      lines: [],
    } : null
    const [headerDefs, lineDefs, segments] = journalDrawer ? await Promise.all([
      loadFieldDefs('documents', 'journal'),
      loadFieldDefs('document_lines', 'journal'),
      customSegmentOptions(authz.user.orgId, authz.allowedSubsidiaryIds),
    ]) : [[], [], []]
    const form = journalDrawer ? await resolveFormLayout({
      orgId: authz.user.orgId, userId: authz.user.id, recordType: 'journal',
      userRoles: authz.user.roles.map(({ key }) => key), headerDefs, lineDefs,
      explicitLayoutId: new URL(req.url).searchParams.get('form') ?? undefined,
    }) : null
    return NextResponse.json({
      entry: restrictedPayroll ? { ...entry, custom: {} } : entry, lines: shaped,
      ...(journalDrawer ? { sourceJournal: journalHeader, canPost: Boolean(currentJournal) && can(authz, 'gl.post'),
        currentEntryId: !currentJournal ? sourceJournal?.doc.entry_id ?? null : null,
        headerDefs, lineDefs, segments, layout: form?.layout } : {}),
    })
  },
});

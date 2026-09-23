import { sql, type SQL } from "drizzle-orm";

/**
 * The one shared answer to "which ACCOUNTS carry open payables" — the
 * account side of the open-item scope. (Document-kind membership lives once
 * in ./open-item-kinds.ts; this module never re-lists kinds, only the
 * account side.)
 *
 * A payable-side balance lives on a liability_payable account OR on the
 * org's designated employee-payable control, which the industry presets type
 * liability_current_other. An expense report contributes exactly its
 * OUT-OF-POCKET portion by construction: OOP legs post open to the
 * designated control (admitted here), company-paid card legs are never
 * stamped open, and personal debits sit on the employee-receivable account
 * outside the AP scope — so no kind-list edit can ever route them into AP
 * aging or a reimbursement run.
 *
 * Read by the web readers through web/lib/ledger-scope.ts (which delegates
 * here — never a second copy) and directly by the cash agent, which cannot
 * import the server-only web module. A bare `type = 'liability_payable'`
 * anywhere else silently drops every reimbursement payable from that reader.
 *
 * The settings writer validates the stored mapping, so the scalar
 * subquery's uuid cast cannot meet garbage — the same trust the document
 * posting places on it.
 */
export function apOpenAccountScope(accounts: SQL, orgId: string): SQL {
  return sql`(${accounts}.type = 'liability_payable' or ${accounts}.id = (select (settings->'controlAccounts'->>'employeePayable')::uuid from orgs where id = ${orgId}))`;
}

/**
 * The document's posting AS OF a date, from journal history — the shared
 * answer to "which entry represented this document then". Append-only
 * correction never edits history: a correction reverses the old entry and
 * re-posts (moving documents.posted_entry_id), and a void reverses plus
 * stamps voided_at. Reading the live posted_entry_id (or the live status)
 * therefore rewrites the past — a July invoice corrected in August reads
 * zero open at a July as-of, and a later void erases it from every earlier
 * forecast.
 *
 * The effective entry is the latest entry for the document posted on/before
 * the date that was not yet reversed as of it (reversal = a reversing entry
 * dated on/before it; reversal entries themselves never post). The current
 * posted_entry_id wins ties and superseded projections: for every
 * never-corrected document it IS the selected row, so live (today) reads are
 * bit-for-bit identical to the old direct join. Pair with an as-of liveness
 * gate on the document — posted, or voided strictly after the date
 * (voided_at::date follows the same end-of-day convention as the
 * applications cutoff) — so a later void hides the document from its date
 * forward but never before it.
 *
 * @param docAlias the SQL alias of the outer `documents` row (a static
 * identifier from the calling query, never user input).
 */
export function asOfPostedEntryLateral(orgId: string, asOf: string, docAlias = "d"): SQL {
  const d = sql.raw(docAlias);
  return sql`
    join lateral (
      select je.id, je.org_id, je.posting_date
        from journal_entries je
       where je.org_id = ${orgId}
         and je.source_document_id = ${d}.id
         and je.status in ('posted', 'reversed')
         and je.reverses_entry_id is null
         and je.posting_date <= ${asOf}
         and not exists (
           select 1 from journal_entries r
            where r.org_id = ${orgId}
              and r.reverses_entry_id = je.id
              and r.posting_date <= ${asOf}
         )
       order by (je.id = ${d}.posted_entry_id) desc, je.posting_date desc, je.id desc
       limit 1
    ) je on true`;
}

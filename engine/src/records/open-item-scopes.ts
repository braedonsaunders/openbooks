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
         -- The live posted entry is always a candidate: a project-attribution
         -- move re-posts it without a source document, and that replacement
         -- must keep the document in every as-of read.
         and (je.source_document_id = ${d}.id or je.id = ${d}.posted_entry_id)
         and ${entryInEffectSql(orgId, asOf, "je")}
       order by (je.id = ${d}.posted_entry_id) desc, je.posting_date desc, je.id desc
       limit 1
    ) je on true`;
}

/**
 * Whether a journal entry can carry a document on a date: posted (or since
 * reversed), not itself a reversal, dated on or before it, and not reversed
 * by an entry dated on or before it. The one eligibility rule behind
 * {@link asOfPostedEntryLateral} and the open-item index reader.
 */
function entryInEffectSql(orgId: string, asOf: string, entryAlias: string): SQL {
  const je = sql.raw(entryAlias);
  return sql`${je}.status in ('posted', 'reversed')
         and ${je}.reverses_entry_id is null
         and ${je}.posting_date <= ${asOf}
         and not exists (
           select 1 from journal_entries r
            where r.org_id = ${orgId}
              and r.reverses_entry_id = ${je}.id
              and r.posting_date <= ${asOf}
         )`;
}

export interface OpenItemsAsOfScope {
  orgId: string;
  asOf: string;
  /** The posting book whose entries carry the items; none carries no items. */
  bookId: string | null;
  /** Predicate over `accounts a` naming the side's control accounts. */
  accounts: SQL;
  /** Document kinds whose lines are the side's open items. */
  kinds: readonly string[];
  /** The side's credit-memo kind: it carries the opposite sign and presents negative. */
  creditKind: string;
  /** The ledger sign of a non-credit item on the control account. */
  normalSign: "debit" | "credit";
  subsidiaryIds?: readonly string[];
  partyId?: string;
}

/**
 * Every AR or AP open item as of a date, read through the maintained
 * open-item index (open_item_balances) rather than reconstructed from every
 * document the side has ever posted.
 *
 * The candidate lines are the index's open lines plus the lines touched by
 * applications applied or unapplied after the date, each corrected by
 * exactly those legs.
 *
 * A line counts when its entry is the one carrying its document on the date
 * ({@link asOfPostedEntryLateral}). For a line on its document's live posted
 * entry that is in effect on the date, that entry is the choice by
 * definition; any other line resolves its document's choice explicitly.
 *
 * Yields `id` (the line), `entry_id`, `doc_id`, `doc_kind`, `doc_number`,
 * `party_id`, `subsidiary_id`, `tran_date`, `due_date` and `remaining`, the
 * side's open amount in the line's functional currency (credits negative,
 * never zero).
 */
export function openItemsAsOfSql(scope: OpenItemsAsOfScope): SQL {
  const { orgId, asOf, bookId } = scope;
  const kindList = sql.join(
    scope.kinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const normalDebit = scope.normalSign === "debit";
  // A credit memo carries the opposite sign of the side's items.
  const sideLine = (kind: SQL, amount: SQL) =>
    normalDebit
      ? sql`((${kind} = ${scope.creditKind} and ${amount} < 0) or (${kind} <> ${scope.creditKind} and ${amount} > 0))`
      : sql`((${kind} = ${scope.creditKind} and ${amount} > 0) or (${kind} <> ${scope.creditKind} and ${amount} < 0))`;
  const live = (status: SQL, voidedAt: SQL) =>
    sql`(${status} = 'posted' or (${voidedAt} is not null and ${voidedAt}::date > ${asOf}::date))`;
  const candidates = candidateLinesCte(scope);
  return sql`
    with ${candidates},
    resolved as materialized (
      select l.*, je.posting_date, je.book_id, je.source_document_id,
             (${entryInEffectSql(orgId, asOf, "je")}) as in_effect,
             d.id as doc_id, d.kind, d.document_number, d.status, d.voided_at
        from lines l
        join journal_entries je on je.id = l.entry_id and je.org_id = ${orgId}
        left join documents d on d.posted_entry_id = je.id and d.org_id = ${orgId}
         and (je.source_document_id is null or je.source_document_id = d.id)
    )
    -- Each branch decides membership in one boolean column behind an
    -- optimization fence. Read through the materialized steps above, the
    -- individual conditions would multiply default selectivities down to a
    -- row or two, and a caller joining these rows would plan nested loops
    -- over what is really tens of thousands of items.
    select carried.id, carried.entry_id, carried.doc_id, carried.doc_kind, carried.doc_number,
           carried.party_id, carried.subsidiary_id, carried.tran_date, carried.due_date, carried.remaining
      from (
        select r.line_id as id, r.entry_id, r.doc_id, r.kind as doc_kind, r.document_number as doc_number,
               r.party_id, r.subsidiary_id, r.posting_date as tran_date, r.due_date,
               (case when r.kind = ${scope.creditKind} then -1 else 1 end) * r.remaining as remaining,
               (r.in_effect and r.doc_id is not null and r.book_id = ${bookId}
                and ${live(sql`r.status`, sql`r.voided_at`)}
                and r.kind in (${kindList})
                and ${sideLine(sql`r.kind`, sql`r.amount`)}) is true as carried
          from resolved r
        offset 0
      ) carried
     where carried.carried
    union all
    select r.line_id, r.entry_id, d.id, d.kind, d.document_number,
           r.party_id, r.subsidiary_id, r.posting_date, r.due_date,
           (case when d.kind = ${scope.creditKind} then -1 else 1 end) * r.remaining
      from resolved r
      join documents d on d.org_id = ${orgId} and (d.id = r.source_document_id or d.posted_entry_id = r.entry_id)
      ${asOfPostedEntryLateral(orgId, asOf)}
     where r.in_effect and r.doc_id is null and r.book_id = ${bookId}
       and je.id = r.entry_id
       and ${live(sql`d.status`, sql`d.voided_at`)}
       and d.kind in (${kindList})
       and ${sideLine(sql`d.kind`, sql`r.amount`)}`;
}

/**
 * The open-item index rows that can be open on a date, as two CTEs
 * (`corrections`, `lines`). A line's remaining on a date differs from its
 * live remaining only through applications applied after the date (not yet
 * consumed then) and applications unapplied after it (still consumed then),
 * so the candidates are the open lines plus the lines those applications
 * touch, each corrected by exactly those legs — the legs and carrying
 * columns `datedAppliedAmountSql` nets. `lines.remaining` is the line's
 * unsigned remaining on the date, never zero.
 */
function candidateLinesCte(
  scope: Pick<OpenItemsAsOfScope, "orgId" | "asOf" | "accounts" | "subsidiaryIds" | "partyId">,
): SQL {
  const { orgId, asOf } = scope;
  // The side's control accounts resolve once, as an array: a semi-join to
  // accounts would let the planner drive every candidate probe per account.
  const lineScope = sql`b.account_id = any(array(select a.id from accounts a where a.org_id = ${orgId} and ${scope.accounts}))
         and b.posting_date <= ${asOf}
         ${scope.subsidiaryIds !== undefined ? sql`and b.subsidiary_id = any(${`{${scope.subsidiaryIds.join(",")}}`}::uuid[])` : sql``}
         ${scope.partyId !== undefined ? sql`and b.party_id = ${scope.partyId}` : sql``}`;
  return sql`corrections as materialized (
      select legs.line_id, sum(legs.delta) as delta
        from (
          select x.from_line_id as line_id, x.source_amount as delta from applications x
           where x.org_id = ${orgId} and x.unapplied_at is null and x.applied_on > ${asOf}
          union all
          select x.to_line_id, x.amount from applications x
           where x.org_id = ${orgId} and x.unapplied_at is null and x.applied_on > ${asOf}
             and x.from_line_id <> x.to_line_id
          union all
          select x.from_line_id, -x.source_amount from applications x
           where x.org_id = ${orgId} and x.unapplied_at is not null and x.unapplied_at::date > ${asOf}::date
             and x.applied_on <= ${asOf}
          union all
          select x.to_line_id, -x.amount from applications x
           where x.org_id = ${orgId} and x.unapplied_at is not null and x.unapplied_at::date > ${asOf}::date
             and x.applied_on <= ${asOf} and x.from_line_id <> x.to_line_id
        ) legs
       group by legs.line_id
    ),
    lines as materialized (
      select c.line_id, c.entry_id, c.party_id, c.subsidiary_id, c.due_date, c.amount,
             c.remaining + coalesce(x.delta, 0) as remaining
        from (
          select b.line_id, b.entry_id, b.party_id, b.subsidiary_id, b.due_date, b.amount, b.remaining
            from open_item_balances b
           where b.org_id = ${orgId} and b.is_open and ${lineScope}
          union
          select b.line_id, b.entry_id, b.party_id, b.subsidiary_id, b.due_date, b.amount, b.remaining
            from corrections cx
            join open_item_balances b on b.org_id = ${orgId} and b.line_id = cx.line_id
           where ${lineScope}
        ) c
        left join corrections x on x.line_id = c.line_id
       where c.remaining + coalesce(x.delta, 0) <> 0
    )`;
}

/**
 * The documents that can hold an open item on the side's control accounts on
 * a date: every document owning an open-item index line that is not settled
 * on the date. Any other document's lines are all settled on the date, so a
 * reader that nets documents from their lines may restrict itself to these.
 */
export function openItemCandidateDocumentsSql(
  scope: Pick<OpenItemsAsOfScope, "orgId" | "asOf" | "accounts">,
): SQL {
  const { orgId } = scope;
  return sql`
    with ${candidateLinesCte(scope)}
    select je.source_document_id as id
      from lines l
      join journal_entries je on je.id = l.entry_id and je.org_id = ${orgId}
     where je.source_document_id is not null
    union
    select d.id
      from lines l
      join documents d on d.posted_entry_id = l.entry_id and d.org_id = ${orgId}`;
}

/**
 * The open-item lines on the scoped accounts that are not settled on a date,
 * as a select of `line_id`. Every other open-item line on those accounts has
 * nothing left on the date, so a reader netting control lines against their
 * applications may skip it.
 */
export function openItemCandidateLinesSql(
  scope: Pick<OpenItemsAsOfScope, "orgId" | "asOf" | "accounts">,
): SQL {
  return sql`
    with ${candidateLinesCte(scope)}
    select l.line_id from lines l`;
}

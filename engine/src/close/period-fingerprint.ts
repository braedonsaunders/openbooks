import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { CloseError } from "../periods/period-policy.ts";
import { financialClosePeriodScope } from "./fx-revaluation.ts";
import { closeBankStatementScope, closeEntityScope } from "./close-scope.ts";

export type PeriodFingerprintEvidence = Record<string, unknown>;

/**
 * Change buckets naming what a revalidation saw move, for the
 * "re-review needed because <what> changed" invalidation reason. Ledger
 * activity (entries, attributed and unassigned documents, group eliminations)
 * is the book of record; bank sign-offs and rates/policies are named
 * separately so the operator knows which evidence to re-check.
 */
export function fingerprintChangeBuckets(
  before: PeriodFingerprintEvidence | null | undefined,
  after: PeriodFingerprintEvidence,
): string[] {
  if (!before) return [];
  const changed = (keys: string[]): boolean =>
    keys.some((key) => String(before[key] ?? "") !== String(after[key] ?? ""));
  const buckets: string[] = [];
  if (
    changed([
      "entries",
      "entry_changed",
      "debits",
      "documents",
      "document_changed",
      "unassigned_documents",
      "unassigned_document_changed",
      "group_activity",
    ])
  )
    buckets.push("ledger");
  if (changed(["reconciliations"])) buckets.push("reconciliations");
  if (changed(["consolidated_rates", "fx_rate_age_policy"])) buckets.push("rates");
  return buckets;
}

export async function periodFingerprintEvidence(
  orgId: string,
  periodId: string,
  bookId: string,
  subsidiaryIds: string[] = [],
  includeGroupEvidence = true,
): Promise<PeriodFingerprintEvidence> {
  const period = (
    await db.execute<{
      id: string;
      starts_on: string;
      ends_on: string;
      is_adjustment: boolean;
      fiscal_calendar_id: string;
      period_number: number;
    }>(
      sql`select id,starts_on::text as starts_on,ends_on::text as ends_on,is_adjustment,fiscal_calendar_id,period_number from accounting_periods
    where org_id=${orgId} and id=${periodId}`,
      "objects",
    )
  )[0];
  if (!period) throw new CloseError("period not found");
  // Closing balances include prior posted activity. A controlled reopening of
  // an earlier period must invalidate evidence even without a current-period
  // entry. Use the FX engine's exact regular/adjustment period ordering.
  const ledgerPeriodScope = sql`(e.period_id=${periodId} or exists(select 1 from journal_lines actual
    where actual.org_id=e.org_id and actual.entry_id=e.id and actual.period_id=${periodId}) or
    (e.status in ('posted','reversed') and ${financialClosePeriodScope(period)}))`;
  const inScope = (entity: SQL) => closeEntityScope(subsidiaryIds, entity);
  const entryScope = sql`(exists(select 1 from journal_lines l where l.org_id=e.org_id and l.entry_id=e.id and ${inScope(sql`l.subsidiary_id`)})
    or (not exists(select 1 from journal_lines l where l.org_id=e.org_id and l.entry_id=e.id) and ${inScope(sql`e.subsidiary_id`)}))`;
  const documentScope = sql`(d.subsidiary_id is null or ${inScope(sql`d.subsidiary_id`)})`;
  const result = await db.execute<Record<string, unknown>>(
    sql`
    select
      (select count(*) from journal_entries e where e.org_id = ${orgId} and ${ledgerPeriodScope} and e.book_id = ${bookId} and ${entryScope}) as entries,
      (select coalesce(max(updated_at)::text, '') from journal_entries e where e.org_id = ${orgId} and ${ledgerPeriodScope} and e.book_id = ${bookId} and ${entryScope}) as entry_changed,
      (select coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0)::text
         from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        where e.org_id = ${orgId} and ${ledgerPeriodScope} and e.book_id = ${bookId} and ${inScope(sql`l.subsidiary_id`)}) as debits,
      (select count(*) from documents d
       where d.org_id = ${orgId}
         and d.posting_period_id = ${periodId} and ${documentScope}) as documents,
      (select coalesce(max(d.updated_at)::text, '') from documents d
       where d.org_id = ${orgId}
         and d.posting_period_id = ${periodId} and ${documentScope}) as document_changed,
      (select count(*) from documents d
        where d.org_id = ${orgId}
          -- Live entries only: a voided document needs no posting period before close.
          -- Period-bounded: a draft dated outside this period (next month's
          -- invoice) is not this review's evidence, so creating it must not
          -- invalidate a completed attestation on revalidation.
          -- Live entries only: voided documents carry no activity for the period to close
          and d.status in ('draft','pending_approval','approved','posted')
          and d.posting_period_id is null
          and coalesce(d.posting_date, d.document_date) between ${period.starts_on}::date and ${period.ends_on}::date
          and ${documentScope}) as unassigned_documents,
      (select coalesce(max(d.updated_at)::text, '') from documents d
        where d.org_id = ${orgId}
          -- Live entries only: the change marker watches the same unassigned set the count above reads.
          and d.status in ('draft','pending_approval','approved','posted')
          and d.posting_period_id is null
          and coalesce(d.posting_date, d.document_date) between ${period.starts_on}::date and ${period.ends_on}::date
          and ${documentScope}) as unassigned_document_changed,
      (select count(*) from reconciliations r join accounts a on a.org_id=r.org_id and a.id=r.account_id join accounting_periods p on p.id = ${periodId} and p.org_id = r.org_id
        where r.org_id = ${orgId} and r.through_date <= p.ends_on and r.status = 'signed_off'
          and (${closeBankStatementScope(orgId, subsidiaryIds)} or exists(select 1 from journal_lines l where l.org_id=r.org_id and l.account_id=r.account_id and ${inScope(sql`l.subsidiary_id`)}))) as reconciliations,
      -- Consolidated translation rates are close evidence: re-deriving or
      -- overriding a period's rates restates every consolidated statement, so
      -- the change must invalidate completed tasks like a ledger change does.
      -- Value-based (not updated_at) so a no-op re-derive leaves sign-offs intact.
      (select coalesce(string_agg(
                 cf.from_currency || '>' || cf.to_currency || ':' || cf.current_rate::text || '/'
                   || cf.average_rate::text || '/' || cf.historical_rate::text || '/' || cf.source,
                 ',' order by cf.from_currency, cf.to_currency), '')
         from consolidated_fx_rates cf
        where cf.org_id = ${orgId} and cf.period_id = ${periodId} and ${includeGroupEvidence}) as consolidated_rates,
      -- Effective policy changes invalidate the readiness evidence they govern.
      (select coalesce(string_agg(policy.rate_kind || ':' || policy.max_age_days::text || ':' || policy.effective_from::text,
                 ',' order by policy.rate_kind), '') from (
          select distinct on (rate_kind) rate_kind,max_age_days,effective_from
            from fx_rate_age_policies
           where org_id=${orgId} and effective_from<=${period.ends_on}
           order by rate_kind,effective_from desc
        ) policy) as fx_rate_age_policy,
      (select coalesce(string_agg(e.id::text || ':' || e.updated_at::text || ':' || l.id::text || ':' || l.amount::text, ',' order by l.id), '')
        from journal_lines l join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
        join accounts a on a.id=l.account_id and a.org_id=l.org_id
        where e.org_id=${orgId} and ${ledgerPeriodScope} and e.book_id=${bookId}
          and a.eliminate and ${includeGroupEvidence}) as group_activity
  `,
    "objects",
  );
  return (result[0] ?? {}) as PeriodFingerprintEvidence;
}

function hashFingerprintEvidence(
  subsidiaryIds: string[],
  evidence: PeriodFingerprintEvidence,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ subsidiaryIds: [...subsidiaryIds].sort(), evidence }))
    .digest("hex");
}

export async function periodFingerprint(
  orgId: string,
  periodId: string,
  bookId: string,
  subsidiaryIds: string[] = [],
  includeGroupEvidence = true,
): Promise<string> {
  return hashFingerprintEvidence(
    subsidiaryIds,
    await periodFingerprintEvidence(orgId, periodId, bookId, subsidiaryIds, includeGroupEvidence),
  );
}

/** Fingerprint with the evidence it was hashed from, for change attribution without a second read. */
export async function periodFingerprintWithEvidence(
  orgId: string,
  periodId: string,
  bookId: string,
  subsidiaryIds: string[] = [],
  includeGroupEvidence = true,
): Promise<{ fingerprint: string; evidence: PeriodFingerprintEvidence }> {
  const evidence = await periodFingerprintEvidence(
    orgId,
    periodId,
    bookId,
    subsidiaryIds,
    includeGroupEvidence,
  );
  return { fingerprint: hashFingerprintEvidence(subsidiaryIds, evidence), evidence };
}

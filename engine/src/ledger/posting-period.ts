import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { resolveCoveringPeriod } from "../close/period-resolution.ts";
import { type Doc, PostingError } from "./posting-contracts.ts";
/**
 * Resolve the authoritative accounting period independently from transaction
 * date when the document carries an explicit override. This is required for
 * late postings and adjustment periods; the composite database FK guarantees
 * the selected period belongs to the same organization.
 *
 * Adjustment handling (decided, documented): an explicit ADJUSTMENT period
 * is honoured without a date-window check — adjustments re-date activity by
 * nature (the posting keeps its economic date while the period is the close
 * bucket), so a window check would make explicit adjustment postings
 * impossible. An explicit REGULAR period must still cover the posting date:
 * an imported document dated outside its named period posts into the wrong
 * bucket otherwise. Date-derived resolution always goes through the shared
 * covering-period resolver (default calendar, regular periods only).
 */
export async function resolvePostingPeriod(
  runner: Pick<typeof db, "execute">,
  doc: Doc,
  postingDate: string,
): Promise<{ id: string }> {
  if (doc.postingPeriodId) {
    const override = (await runner.execute<{ id: string; is_adjustment: boolean }>(sql`
        select id, is_adjustment
          from accounting_periods
         where id = ${doc.postingPeriodId}
           and org_id = ${doc.orgId}
           and (is_adjustment or (starts_on <= ${postingDate} and ends_on >= ${postingDate}))
         limit 1
      `));
    const period = override.rows[0];
    if (!period) {
      throw new PostingError(
        `accounting period ${doc.postingPeriodId} does not cover posting date ${postingDate} — import the document on a date inside its period`,
      );
    }
    return { id: period.id };
  }
  const period = await resolveCoveringPeriod(runner, doc.orgId, postingDate);
  if (!period) {
    throw new PostingError(`no accounting period covers ${postingDate}`);
  }
  return { id: period.id };
}

/**
 * A pay run posts its subsidiary's face amounts into the shared book; nothing
 * is translated at posting time. Statements translate each subsidiary through
 * the period's DERIVED consolidated rates and refuse outright when a pair is
 * underived ("No consolidated exchange rates … Derive rates from period close
 * first"). A foreign-subsidiary run posted with no derived rate for its
 * period would sit in the book untranslatable, with the trial balance as the
 * only guard — so the posting path refuses with the trial balance's own
 * message instead, reusing its notion of a derived rate.
 *
 * Runs in the root subsidiary's own currency return before any rate is read,
 * so single-currency tenants post exactly as today. Same-currency lineage
 * steps are skipped as identical, never substituted: no rate is ever
 * defaulted to 1, and a missing cross-currency row throws.
 */
export async function assertPayRunConsolidatedRateCoverage(
  runner: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    docCurrency: string;
    docSubsidiaryId: string;
    postingDate: string;
  },
): Promise<void> {
  const root = (await runner.execute<{ id: string; base_currency: string }>(sql`
    select id, base_currency from subsidiaries
     where org_id = ${args.orgId} and parent_id is null and is_active
     order by created_at limit 1`));
  const rootBase = root.rows[0]?.base_currency;
  if (!rootBase || args.docCurrency === rootBase) return;
  // The run subsidiary's lineage, child first — the same subsidiary→ancestor
  // pairs the period-close derivation writes (see neededPairs in
  // consolidation.ts), so a derived row exists exactly when close derived one
  // for this lineage. Currencies are data off the subsidiary rows; no
  // jurisdiction or currency is named here.
  const chain = (await runner.execute<{ id: string; parent_id: string | null; base_currency: string }>(sql`
    with recursive chain as (
      select id, parent_id, base_currency from subsidiaries
       where org_id = ${args.orgId} and id = ${args.docSubsidiaryId}
      union all
      select p.id, p.parent_id, p.base_currency from subsidiaries p
        join chain c on p.id = c.parent_id and p.org_id = ${args.orgId}
    ) select id, parent_id, base_currency from chain`));
  if (chain.rows.length === 0) {
    throw new PostingError(`pay run subsidiary ${args.docSubsidiaryId} does not exist`);
  }
  const byId = new Map(chain.rows.map((row) => [row.id, row]));
  const pairs: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  let current = byId.get(args.docSubsidiaryId);
  while (current?.parent_id && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parent_id);
    if (!parent) break;
    if (current.base_currency !== parent.base_currency) {
      pairs.push({ from: current.base_currency, to: parent.base_currency });
    }
    current = parent;
  }
  if (pairs.length === 0) return;
  // Rate windows are posting-date windows: activity translates through the
  // regular period's rates, exactly as the statement engine resolves them.
  // With no regular period covering the date the kernel's own period logic
  // governs, and statements still refuse at report time.
  const period = await resolveCoveringPeriod(runner, args.orgId, args.postingDate);
  if (!period) return;
  for (const pair of pairs) {
    const covered = (await runner.execute<{ one: number }>(sql`
      select 1 as one from consolidated_fx_rates
       where org_id = ${args.orgId} and period_id = ${period.id}
         and from_currency = ${pair.from} and to_currency = ${pair.to}
       limit 1`));
    if (!covered.rows[0]) {
      throw new PostingError(
        `No consolidated exchange rates for ${pair.from} → ${pair.to} in the period ending ${period.ends_on}. Derive rates from period close first.`,
      );
    }
  }
}

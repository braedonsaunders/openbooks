/**
 * The restricted-stock releases posted for one certificate bought by early
 * exercise: each stock compensation run that released some of its
 * early-exercise deposit as the shares vested, with the shares released to
 * date, the deposit released by that run and the journal entry it posted.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { assertEquityReadable, requireEquityReader } from "./internal.ts";

export interface RestrictedReleaseRow {
  runId: string;
  throughDate: string;
  /** Restricted shares released through the run, and by the run itself. */
  cumulativeShares: string;
  shares: string;
  /** The deposit the run released to equity, in the functional currency. */
  deposit: string;
  currency: string;
  journalEntryId: string | null;
  entryNumber: string | null;
}

/** Releases of a certificate, latest run first (equity.read and reach to its legal entity); empty for any other security. */
export async function listRestrictedReleases(input: {
  orgId: string;
  actorId: string;
  securityId: string;
}): Promise<RestrictedReleaseRow[]> {
  if (!isUuid(input.securityId)) return [];
  await assertEquityReadable(input.orgId);
  return withOrgTransaction(
    input.orgId,
    async () => {
      const security = (
        await db.execute<{ subsidiary_id: string }>(
          sql`
      select subsidiary_id from equity_securities where org_id = ${input.orgId} and id = ${input.securityId}`,
          "objects",
        )
      )[0];
      if (!security) return [];
      await requireEquityReader(db, input.orgId, input.actorId, security.subsidiary_id);
      const rows = await db.execute<{
        run_id: string;
        through_date: string;
        cumulative_shares: string;
        previous_shares: string;
        period_deposit: string;
        currency: string;
        journal_entry_id: string | null;
        entry_number: string | null;
      }>(
        sql`
      select r.id as run_id, r.through_date::text as through_date, l.cumulative_shares::text as cumulative_shares,
             l.previous_shares::text as previous_shares, l.period_deposit::text as period_deposit, r.currency,
             r.release_journal_entry_id as journal_entry_id, je.entry_number
        from equity_compensation_run_releases l
        join equity_compensation_runs r on r.org_id = l.org_id and r.id = l.run_id
        left join journal_entries je on je.org_id = r.org_id and je.id = r.release_journal_entry_id
       where l.org_id = ${input.orgId} and l.security_id = ${input.securityId}
       order by r.through_date desc, r.id`,
        "objects",
      );
      return rows.map((row) => ({
        runId: row.run_id,
        throughDate: row.through_date,
        cumulativeShares: row.cumulative_shares,
        shares: (BigInt(row.cumulative_shares) - BigInt(row.previous_shares)).toString(),
        deposit: row.period_deposit,
        currency: row.currency,
        journalEntryId: row.journal_entry_id,
        entryNumber: row.entry_number,
      }));
    },
    { isolationLevel: "REPEATABLE READ", readOnly: true },
  );
}

/** Source-evidenced reconciliation. Split from banking.ts (pure moves only). */
import { BankingError, type BankingContext } from "./banking-core"
import { loadReconcilableAccount, lockReconciliationAccount } from "./reconcilable-account"
import { reconciliationBookId } from "./reconciliation"
import { assertRealDate } from "./statement-parsers/shared"
import { sql } from "drizzle-orm"
import { db } from "../platform/db.ts"
import { fromUnits, toUnits } from "../money/money.ts"

// ---------------------------------------------------------------------------
// Source-evidenced reconciliation (0158)
// ---------------------------------------------------------------------------

/**
 * Close-policy switch for source-evidenced sign-offs. Absent on orgs that
 * predate the seed reads as ON: the owner decision ships this behavior, and
 * only an explicit opt-out turns it off.
 */
export const SOURCE_EVIDENCE_POLICY_CODE = "source-reconciliation-evidence";

export async function sourceEvidencePolicyActive(orgId: string): Promise<boolean> {
  const row = (await db.execute<{ is_active: boolean }>(sql`
    select is_active from close_policies
     where org_id = ${orgId} and code = ${SOURCE_EVIDENCE_POLICY_CODE}
     limit 1
  `)).rows[0];
  return row?.is_active ?? true;
}

function validateSourceClearedDate(value: string): void {
  const match = typeof value === "string" ? value.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!match) throw new BankingError("Source cleared date must be YYYY-MM-DD");
  assertRealDate(match[1]!, match[2]!, match[3]!, "Source cleared date");
}

/** One mirrored line's cleared evidence, as the connector reported it. */
export interface SourceClearedLineEvidence {
  accountId: string;
  cleared: boolean;
  /** ISO date when cleared; required exactly when `cleared` is true. */
  clearedDate: string | null;
}

export interface SourceClearedEntryEvidence {
  entryId: string;
  lines: SourceClearedLineEvidence[];
}

/**
 * Stamp the mirror's source-cleared evidence onto posted journal lines. The
 * stamp applies per (entry, account) group only when EVERY journal line of
 * the group is evidenced as cleared: a partially cleared group — or a group
 * whose evidence omits some of the group's lines — stays unstamped (and the
 * account stays open) rather than recording evidence the source did not
 * give. Only reconcilable accounts stamp; already-stamped lines keep their
 * first stamp (the trigger's append-only carve-out enforces it).
 */
export async function applySourceLineEvidence(
  orgId: string,
  connector: string,
  entries: SourceClearedEntryEvidence[],
): Promise<{ entries: number; linesStamped: number }> {
  const key = connector?.trim() ?? "";
  if (!key) throw new BankingError("Source evidence requires a connector key");
  let linesStamped = 0;
  await db.transaction(async (tx) => {
    for (const entry of entries) {
      const byAccount = new Map<string, SourceClearedLineEvidence[]>();
      for (const line of entry.lines) {
        const group = byAccount.get(line.accountId) ?? [];
        group.push(line);
        byAccount.set(line.accountId, group);
      }
      for (const [accountId, group] of byAccount) {
        if (group.length === 0 || group.some((line) => !line.cleared)) continue;
        const dates = group.map((line) => line.clearedDate);
        if (dates.some((date) => !date)) {
          throw new BankingError(
            "Source cleared evidence requires a cleared date for every cleared line",
          );
        }
        for (const date of dates) validateSourceClearedDate(date!);
        // Completeness fence: the supplied group must account for EVERY
        // journal line of this (entry, account) — not just the cleared ones
        // the connector chose to send. An entry with two bank lines where
        // only one cleared would otherwise stamp both irreversibly, because
        // the stamp below targets the whole (entry, account). An incomplete
        // group stays unstamped (and the account stays open) rather than
        // recording evidence the source did not give.
        const actual = (await tx.execute<{ count: string }>(sql`
          select count(*)::text as count from journal_lines
           where org_id = ${orgId} and entry_id = ${entry.entryId} and account_id = ${accountId}
        `));
        if (group.length !== Number(actual.rows[0]!.count)) continue;
        const maxDate = [...dates].sort().at(-1)!;
        const stamped = (await tx.execute<{ id: string }>(sql`
          update journal_lines jl
             set source_cleared_date = ${maxDate}, source_cleared_connector = ${key}
           where jl.org_id = ${orgId} and jl.entry_id = ${entry.entryId} and jl.account_id = ${accountId}
             and jl.source_cleared_date is null
             and exists (
               select 1 from accounts a
                where a.id = jl.account_id and a.org_id = jl.org_id and a.reconcilable
             )
          returning jl.id
        `));
        linesStamped += stamped.rows.length;
      }
    }
  });
  return { entries: entries.length, linesStamped };
}

/** Per-account source-evidence coverage derived from mirrored stamps. */
export interface SourceAccountEvidenceState {
  accountId: string;
  number: string | null;
  name: string;
  connector: string | null;
  reconciledThrough: string | null;
  clearedLines: number;
  unclearedLines: number;
}

/**
 * Recompute every reconcilable account's source-evidence coverage from the
 * mirrored stamps and persist the reconciled-through date per account. A
 * line is covered by a prior sign-off of any kind or by a source stamp at or
 * before the account's latest cleared date; anything else stays open.
 */
export async function refreshSourceReconciliationState(
  orgId: string,
  connector: string,
): Promise<SourceAccountEvidenceState[]> {
  const key = connector?.trim() ?? "";
  if (!key) throw new BankingError("Source evidence requires a connector key");
  const bookId = await reconciliationBookId(db, orgId);
  const rows = (await db.execute<{
    account_id: string; number: string | null; name: string;
    cleared: string; uncleared: string; through: string | null;
  }>(sql`
    select a.id as account_id, a.number, a.name,
           count(*) filter (where jl.source_cleared_date is not null or jl.reconciled_at is not null) as cleared,
           count(*) filter (where jl.source_cleared_date is null and jl.reconciled_at is null) as uncleared,
           max(jl.source_cleared_date)::text as through
      from accounts a
      join journal_lines jl on jl.account_id = a.id and jl.org_id = a.org_id
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
     where a.org_id = ${orgId} and a.reconcilable and a.is_active and not a.is_summary
       and je.book_id = ${bookId} and je.status = 'posted'
     group by a.id, a.number, a.name
    having count(*) > 0
     order by a.number nulls last, a.name
  `)).rows;
  await db.transaction(async (tx) => {
    for (const row of rows) {
      if (row.through) {
        await tx.execute(sql`
          insert into source_reconciliation_state
            (org_id, account_id, connector, reconciled_through, source_balance, observed_at)
          values (${orgId}, ${row.account_id}, ${key}, ${row.through}, null, now())
          on conflict (org_id, account_id) do update set
            connector = excluded.connector,
            reconciled_through = excluded.reconciled_through,
            source_balance = excluded.source_balance,
            observed_at = now()
        `);
      } else {
        await tx.execute(sql`
          delete from source_reconciliation_state
           where org_id = ${orgId} and account_id = ${row.account_id}
        `);
      }
    }
  });
  return rows.map((row) => ({
    accountId: row.account_id,
    number: row.number,
    name: row.name,
    connector: row.through ? key : null,
    reconciledThrough: row.through,
    clearedLines: Number(row.cleared),
    unclearedLines: Number(row.uncleared),
  }));
}

export type SourceSignOffOutcome =
  | {
    signed: true;
    reconciliationId: string;
    throughDate: string;
    /** Newly stamped lines. */
    clearedLines: number;
    /** Lines already reconciled by an earlier sign-off of any kind. */
    previouslyReconciledLines: number;
    /** True when an earlier signed-off row already covered the account. */
    advanced: boolean;
  }
  | {
    signed: false;
    reason: "policy-disabled" | "no-evidence" | "open-session" | "already-covered" | "partially-cleared";
    throughDate: string | null;
    clearedLines: number;
    unclearedLines: number;
  };

/**
 * Sign a reconcilable account off THROUGH the source's reconciled date from
 * mirrored cleared evidence — never inventing statement lines. Fully covered
 * accounts (every posted line at or before the date is source-stamped or
 * already reconciled) create or advance a signed-off `source` row and stamp
 * the newly covered lines; partially covered accounts stay open with exact
 * counts. An open statement session blocks the mirror from signing behind a
 * human; reruns through an already-covered date report instead of duplicating.
 */
export async function signOffFromSourceEvidence(
  opts: { accountId: string },
  ctx: BankingContext,
): Promise<SourceSignOffOutcome> {
  if (!(await sourceEvidencePolicyActive(ctx.orgId))) {
    return { signed: false, reason: "policy-disabled", throughDate: null, clearedLines: 0, unclearedLines: 0 };
  }
  const account = await loadReconcilableAccount(ctx.orgId, opts.accountId, ctx.allowedSubsidiaryIds);
  const state = (await db.execute<{ connector: string; reconciled_through: string }>(sql`
    select connector, reconciled_through::text
      from source_reconciliation_state
     where org_id = ${ctx.orgId} and account_id = ${account.id}
  `)).rows[0];
  if (!state) {
    return { signed: false, reason: "no-evidence", throughDate: null, clearedLines: 0, unclearedLines: 0 };
  }
  return db.transaction(async (tx) => {
    const bookId = await reconciliationBookId(tx, ctx.orgId);
    await lockReconciliationAccount(tx, ctx.orgId, account.id);
    const coverage = (await tx.execute<{ cleared: string; open: string; balance: string }>(sql`
      select
        count(*) filter (
          where (jl.source_cleared_date is not null and jl.source_cleared_date <= ${state.reconciled_through})
             or jl.reconciled_at is not null
        ) as cleared,
        count(*) filter (
          where (jl.source_cleared_date is null or jl.source_cleared_date > ${state.reconciled_through})
            and jl.reconciled_at is null
        ) as open,
        coalesce(sum(jl.txn_amount), 0) as balance
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
       where jl.account_id = ${account.id} and jl.org_id = ${ctx.orgId}
         and je.book_id = ${bookId}
         and jl.currency = ${account.currency}
         and je.posting_date <= ${state.reconciled_through}
    `)).rows[0]!;
    const clearedLines = Number(coverage.cleared);
    const openLines = Number(coverage.open);
    const open = (await tx.execute<{ id: string }>(sql`
      select id from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${account.id} and status <> 'signed_off'
       limit 1
    `));
    if (open.rows[0]) {
      return {
        signed: false, reason: "open-session", throughDate: state.reconciled_through,
        clearedLines, unclearedLines: openLines,
      };
    }
    const latestSigned = (await tx.execute<{ through_date: string }>(sql`
      select through_date::text from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${account.id} and status = 'signed_off'
       order by through_date desc limit 1
    `)).rows[0];
    if (latestSigned && state.reconciled_through <= latestSigned.through_date) {
      return {
        signed: false, reason: "already-covered", throughDate: state.reconciled_through,
        clearedLines, unclearedLines: openLines,
      };
    }
    if (openLines > 0) {
      return {
        signed: false, reason: "partially-cleared", throughDate: state.reconciled_through,
        clearedLines, unclearedLines: openLines,
      };
    }
    const statementBalance = fromUnits(toUnits(coverage.balance));
    // Raw SQL, not the drizzle model: the new evidence columns travel with
    // the 0158 migration in this same change, and the shared schema package
    // resolves from main until this change is merged.
    const recon = (await tx.execute<{ id: string }>(sql`
      insert into reconciliations
        (org_id, account_id, through_date, currency, statement_balance,
         status, created_by, evidence_kind, evidence_connector)
      values
        (${ctx.orgId}, ${account.id}, ${state.reconciled_through}, ${account.currency},
         ${statementBalance}, 'in_progress', ${ctx.userId}, 'source', ${state.connector})
      returning id
    `)).rows[0]!;
    // The row above is still unsigned, so the trigger's source-evidenced
    // stamp path admits stamping the already-source-stamped lines. Lines
    // reconciled by an earlier sign-off keep their original stamp.
    const stamped = (await tx.execute<{ id: string }>(sql`
      update journal_lines jl
         set reconciled_at = now(), reconciliation_id = ${recon.id}
       where jl.org_id = ${ctx.orgId} and jl.account_id = ${account.id}
         and jl.reconciled_at is null
         and jl.source_cleared_date is not null
         and jl.source_cleared_date <= ${state.reconciled_through}
         and jl.currency = ${account.currency}
         and exists (
           select 1 from journal_entries je
            where je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
              and je.book_id = ${bookId} and je.posting_date <= ${state.reconciled_through}
         )
      returning jl.id
    `));
    await tx.execute(sql`
      update reconciliations
         set status = 'signed_off', signed_off_by = ${ctx.userId}, signed_off_at = now(),
             updated_at = now(), updated_by = ${ctx.userId}
       where id = ${recon.id} and org_id = ${ctx.orgId}
    `);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'reconciliations', ${recon.id}, 'approve',
         ${JSON.stringify({
           operation: "sign_off",
           evidenceKind: "source",
           connector: state.connector,
           bookId,
           statementBalance,
           currency: account.currency,
           throughDate: state.reconciled_through,
           clearedJournalLines: stamped.rows.length,
           previouslyReconciledLines: clearedLines - stamped.rows.length,
           throughBasis: "max-source-cleared-date",
         })}::jsonb,
         ${ctx.userId})
    `);
    return {
      signed: true,
      reconciliationId: recon.id,
      throughDate: state.reconciled_through,
      clearedLines: stamped.rows.length,
      previouslyReconciledLines: clearedLines - stamped.rows.length,
      advanced: Boolean(latestSigned),
    };
  });
}

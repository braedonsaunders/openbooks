import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { assertPeriodModulesOpen } from "../periods/period-policy.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { assertNotSandbox } from "../organization/sandbox-guard.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { PspSettlementError, summarizeSettlement } from "./psp-settlement-core.ts";
import type { SettlementLineKind } from "./psp-settlement-core.ts";
import {
  MATCHABLE_SETTLEMENT_LINE_KINDS,
  auditSettlementLine,
  requireBankingFeature,
  settlementLineDocumentInEntity,
} from "./psp-settlement-matching.ts";
import type { SettlementLineLock } from "./psp-settlement-matching.ts";
import { periodForDate } from "./psp-settlement-posting-context.ts";

/**
 * Reverse a batch-level journal recognition before close. Only markers the
 * batch action set (`via: "batch"`) come off, so a line the bookkeeper
 * marked by hand keeps its evidence; the journal stays exactly as posted.
 * Once the payout's settlement period is closed for Banking the recognition
 * is close evidence and refuses — the refusal names the controlled reopen
 * route through the native period wording.
 */
export async function clearSettlementBatchJournal(
  orgId: string,
  batchId: string,
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
): Promise<{ batchId: string; cleared: number; journalEntryNumbers: string[] }> {
  const scope = allowedSubsidiaryIds;
  if (scope === undefined) throw new ScopeNotFoundError();
  return withOrg(orgId, async () => {
    await requireBankingFeature(orgId);
    const batch = (
      await db.execute<{
        id: string;
        status: string;
        subsidiary_id: string | null;
        external_ref: string;
        settlement_date: string;
        journal_entry_id: string | null;
      }>(
        sql`
      select id, status, subsidiary_id, external_ref, settlement_date::text, journal_entry_id
        from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(scope, batch.subsidiary_id)) throw new ScopeNotFoundError();
    if (batch.status === "void") {
      throw new PspSettlementError(
        `payout ${batch.external_ref} is void; voided history is closed`,
      );
    }
    // The recognition becomes close evidence at close: lifting it afterwards
    // would rewrite what the close attested, so the payout's own settlement
    // period must still be open for Banking.
    const periodId = await periodForDate(orgId, batch.settlement_date, batch.subsidiary_id);
    if (!periodId) {
      throw new PspSettlementError(
        `no accounting period covers the payout date ${batch.settlement_date}; the batch recognition cannot be reversed without a period to attest it`,
      );
    }
    const sourceBook = batch.journal_entry_id
      ? ((
          await db.execute<{ book_id: string }>(
            sql`
          select book_id from journal_entries where id = ${batch.journal_entry_id} and org_id = ${orgId}
        `,
            "objects",
          )
        )[0]?.book_id ?? null)
      : null;
    if (!sourceBook) {
      throw new PspSettlementError(
        `payout ${batch.external_ref} has no posted settlement journal; post it first, then reverse the batch recognition`,
      );
    }
    await assertPeriodModulesOpen(db, {
      orgId,
      periodId,
      bookId: sourceBook,
      subsidiaryIds: batch.subsidiary_id ? [batch.subsidiary_id] : [],
      modules: ["banking"],
    });
    const matchableList = `{"${[...MATCHABLE_SETTLEMENT_LINE_KINDS].join('","')}"}`;
    const lines = await db.execute<{ id: string; meta: unknown }>(
      sql`
      select id, meta from psp_settlement_lines
       where org_id = ${orgId} and batch_id = ${batchId}
         and kind = any(${matchableList}::text[])
         and meta->'recognizedByJournalEntry'->>'via' = 'batch'
       order by line_number for update
    `,
      "objects",
    );
    if (lines.length === 0) {
      throw new PspSettlementError(
        `payout ${batch.external_ref} carries no batch-level journal recognition to reverse`,
      );
    }
    const numbers = new Set<string>();
    for (const line of lines) {
      const before =
        (line.meta as Record<string, unknown> | null)?.["recognizedByJournalEntry"] ?? null;
      const number = (before as Record<string, unknown> | null)?.["number"];
      if (typeof number === "string") numbers.add(number);
      const updated = await db.execute<never>(sql`
        update psp_settlement_lines
           set meta = coalesce(meta, '{}'::jsonb) - 'recognizedByJournalEntry',
               updated_at = now(), updated_by = ${actorId}
         where id = ${line.id} and org_id = ${orgId} and batch_id = ${batchId}
      `);
      if ((updated.rowCount ?? 0) !== 1) {
        throw new PspSettlementError(
          `settlement line ${line.id} could not be unmarked; reload the payout and try again`,
        );
      }
      await auditSettlementLine(
        orgId,
        line.id,
        "unmark-journal",
        { before: { recognizedByJournalEntry: before }, after: { recognizedByJournalEntry: null } },
        actorId,
      );
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'psp_settlement_batches', ${batchId}, 'unmark-batch-journal',
              ${JSON.stringify({ cleared: lines.length, journalEntryNumbers: [...numbers] })}::jsonb, ${actorId})
    `);
    return { batchId, cleared: lines.length, journalEntryNumbers: [...numbers] };
  });
}

/**
 * Suggest the journal entry that recognised a batch's sales: a posted entry
 * in the payout's entity, posted in the 62 days up to the settlement date,
 * whose revenue-account lines total exactly the batch's charge total in the
 * payout currency. Equality is exact decimal against numeric(19,4) sums —
 * never rounded — and the operator still confirms: the suggestion proposes,
 * the batch action disposes. Never the batch's own posting journal, never a
 * reversal leg, never a draft.
 */
export async function suggestSettlementBatchJournal(
  orgId: string,
  batchId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
): Promise<{
  batchId: string;
  chargeTotal: string;
  currency: string;
  excludedOtherCurrencyLines: number;
  candidates: { id: string; number: string; postingDate: string; revenueTotal: string }[];
}> {
  const scope = allowedSubsidiaryIds;
  if (scope === undefined) throw new ScopeNotFoundError();
  return withOrg(orgId, async () => {
    const batch = (
      await db.execute<{
        id: string;
        status: string;
        subsidiary_id: string | null;
        external_ref: string;
        settlement_date: string;
        currency: string;
        journal_entry_id: string | null;
      }>(
        sql`
      select id, status, subsidiary_id, external_ref, settlement_date::text, currency, journal_entry_id
        from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId}
    `,
        "objects",
      )
    )[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(scope, batch.subsidiary_id)) throw new ScopeNotFoundError();
    if (batch.status === "void") {
      throw new PspSettlementError(
        `payout ${batch.external_ref} is void; voided history needs no recognition`,
      );
    }
    const totals = (
      await db.execute<{ charge_total: string; excluded_lines: string }>(
        sql`
      select coalesce(sum(amount) filter (where kind = 'charge' and (currency is null or currency = ${batch.currency})), 0)::text as charge_total,
             count(*) filter (where kind = 'charge' and currency is not null and currency <> ${batch.currency})::text as excluded_lines
        from psp_settlement_lines
       where org_id = ${orgId} and batch_id = ${batchId}
    `,
        "objects",
      )
    )[0] ?? { charge_total: "0", excluded_lines: "0" };
    const excluded = Number(totals.excluded_lines);
    // A zero charge total matches everything, and a mixed-currency batch
    // cannot prove equality in one currency: both refuse candidates by
    // construction rather than proposing a wrong journal.
    if (totals.charge_total === "0" || totals.charge_total === "0.0000" || excluded > 0) {
      return {
        batchId,
        chargeTotal: totals.charge_total,
        currency: batch.currency,
        excludedOtherCurrencyLines: excluded,
        candidates: [],
      };
    }
    const rows = await db.execute<{
      id: string;
      number: string;
      posting_date: string;
      revenue_total: string;
      subsidiary_id: string | null;
    }>(
      sql`
      select e.id, e.entry_number as number, e.posting_date::text as posting_date,
             abs(sum(l.txn_amount))::text as revenue_total, e.subsidiary_id
        from journal_entries e
        join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
        join accounts a on a.id = l.account_id and a.org_id = e.org_id
       -- Live entries only: settlement matches against standing revenue entries
       where e.org_id = ${orgId} and e.status = 'posted'
         and e.reverses_entry_id is null
         and e.id <> coalesce(${batch.journal_entry_id}, '00000000-0000-0000-0000-000000000000'::uuid)
         and e.posting_date between (${batch.settlement_date}::date - interval '62 days') and ${batch.settlement_date}::date
         and a.type in ('income', 'income_other')
         and l.currency = ${batch.currency}
       group by e.id, e.entry_number, e.posting_date, e.subsidiary_id
      having abs(sum(l.txn_amount)) = abs(${totals.charge_total}::numeric)
       order by e.posting_date desc, e.entry_number
       limit 10
    `,
      "objects",
    );
    const candidates: { id: string; number: string; postingDate: string; revenueTotal: string }[] =
      [];
    for (const row of rows) {
      if (!subsidiaryScopeAllows(scope, row.subsidiary_id)) continue;
      if (!(await settlementLineDocumentInEntity(orgId, batch.subsidiary_id, row.subsidiary_id)))
        continue;
      candidates.push({
        id: row.id,
        number: row.number,
        postingDate: row.posting_date,
        revenueTotal: row.revenue_total,
      });
    }
    return {
      batchId,
      chargeTotal: totals.charge_total,
      currency: batch.currency,
      excludedOtherCurrencyLines: excluded,
      candidates,
    };
  });
}

/**
 * Delete an unposted settlement draft. Drafts are not history — nothing is
 * posted and nothing unwinds — but the removal is still audited with the
 * batch and line snapshot, and the provider reference is freed so a
 * corrected reimport can replace a bad-scale draft. Posted and void batches
 * refuse: posted history unwinds only through reversal.
 */
export async function deleteSettlementDraft(
  orgId: string,
  batchId: string,
  actorId: string | null,
  input: { reason: string },
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
): Promise<{ batchId: string }> {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new PspSettlementError(
      "a reason between 5 and 500 characters is required to delete a settlement draft",
    );
  }
  const scope = allowedSubsidiaryIds;
  if (scope === undefined) throw new ScopeNotFoundError();
  await assertNotSandbox(orgId, "delete a PSP settlement draft");
  return withOrg(orgId, async () => {
    await requireBankingFeature(orgId);
    const batch = (
      await db.execute<{
        id: string;
        status: string;
        provider: string;
        external_ref: string;
        subsidiary_id: string | null;
        net_amount: string;
        settlement_date: string;
      }>(
        sql`
      select id, status, provider, external_ref, subsidiary_id, net_amount::text, settlement_date::text
        from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(scope, batch.subsidiary_id)) throw new ScopeNotFoundError();
    if (batch.status !== "draft") {
      throw new PspSettlementError(
        `batch is ${batch.status}; only an unposted draft can be deleted — reverse a posted batch instead`,
      );
    }
    const lines = await db.execute<{ line_number: number; kind: string; amount: string }>(
      sql`
      select line_number, kind, amount::text from psp_settlement_lines
       where batch_id = ${batchId} and org_id = ${orgId}
       order by line_number
    `,
      "objects",
    );
    await db.execute(sql`
      delete from psp_settlement_lines where batch_id = ${batchId} and org_id = ${orgId}`);
    const deleted = await db.execute<never>(sql`
      delete from psp_settlement_batches where id = ${batchId} and org_id = ${orgId} and status = 'draft'`);
    if ((deleted.rowCount ?? 0) !== 1) {
      throw new PspSettlementError(
        `settlement draft ${batchId} could not be deleted; reload and try again`,
      );
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'psp_settlement_batches', ${batchId}, 'delete',
              ${JSON.stringify({
                before: {
                  provider: batch.provider,
                  externalRef: batch.external_ref,
                  status: "draft",
                  netAmount: batch.net_amount,
                  settlementDate: batch.settlement_date,
                  lines: lines.map((line) => ({
                    line: line.line_number,
                    kind: line.kind,
                    amount: line.amount,
                  })),
                },
                after: null,
                reason,
              })}::jsonb, ${actorId})`);
    return { batchId };
  });
}

/**
 * Reclassify an unmatched line as a provider adjustment. Draft batches only:
 * the kind feeds the stored batch totals, and posted totals are history.
 * Totals are recomputed from the stored lines through the same summarizer
 * posting uses, so the batch still foots after the move.
 */
export async function markSettlementLineAdjustment(
  orgId: string,
  batchId: string,
  lineId: string,
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ lineId: string; kind: SettlementLineKind }> {
  return withOrg(orgId, async () => {
    await requireBankingFeature(orgId);
    const batch = (
      await db.execute<{ id: string; status: string; subsidiary_id: string | null }>(
        sql`
      select id, status, subsidiary_id from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(allowedSubsidiaryIds, batch.subsidiary_id))
      throw new ScopeNotFoundError();
    if (batch.status !== "draft") {
      throw new PspSettlementError(
        `batch is ${batch.status}; a posted payout's line kinds are history — reverse the batch and re-import it to reclassify`,
      );
    }
    const line = (
      await db.execute<SettlementLineLock>(
        sql`
      select id, kind, document_id, amount::text, currency from psp_settlement_lines
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId} for update
    `,
        "objects",
      )
    )[0];
    if (!line) {
      throw new PspSettlementError(
        `settlement line ${lineId} is not part of batch ${batchId} in this organization; reload the payout and try again`,
      );
    }
    if (line.kind === "adjustment") return { lineId, kind: "adjustment" };
    if (line.document_id !== null) {
      throw new PspSettlementError(
        `settlement line ${lineId} is linked to document ${line.document_id}; unlink it before reclassifying as an adjustment`,
      );
    }
    if (line.kind === "fee" || line.kind === "fx_adjustment") {
      throw new PspSettlementError(
        `a ${line.kind} line is provider cost evidence, never an adjustment; link it to nothing and leave its kind alone`,
      );
    }
    const moved = await db.execute<never>(sql`
      update psp_settlement_lines set kind = 'adjustment', updated_at = now(), updated_by = ${actorId}
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId}
    `);
    if ((moved.rowCount ?? 0) !== 1) {
      throw new PspSettlementError(
        `settlement line ${lineId} could not be reclassified; reload the payout and try again`,
      );
    }
    const stored = await db.execute<{ kind: string; amount: string; currency: string | null }>(
      sql`
      select kind, amount::text, currency from psp_settlement_lines
       where batch_id = ${batchId} and org_id = ${orgId}
    `,
      "objects",
    );
    const totals = summarizeSettlement(
      stored.map((row) => ({
        kind: row.kind as SettlementLineKind,
        amount: row.amount,
        currency: row.currency,
      })),
    );
    const restamped = await db.execute<never>(sql`
      update psp_settlement_batches
         set gross_amount = ${totals.grossAmount}, fee_amount = ${totals.feeAmount},
             refund_amount = ${totals.refundAmount}, dispute_amount = ${totals.disputeAmount},
             adjustment_amount = ${totals.adjustmentAmount}, net_amount = ${totals.netAmount},
             updated_at = now(), updated_by = ${actorId}
       where id = ${batchId} and org_id = ${orgId}
    `);
    if ((restamped.rowCount ?? 0) !== 1) {
      throw new PspSettlementError(
        `settlement batch ${batchId} could not be refooted after reclassification`,
      );
    }
    await auditSettlementLine(
      orgId,
      lineId,
      "reclassify",
      { before: { kind: line.kind }, after: { kind: "adjustment", netAmount: totals.netAmount } },
      actorId,
    );
    return { lineId, kind: "adjustment" };
  });
}

export type DepositTieoutLine = {
  statementLineId: string;
  statementId: string;
  postedOn: string;
  amount: string;
  currency: string;
  description: string | null;
  bankTransactionId: string | null;
};

export type DepositTieout =
  | { status: "not_posted"; batchId: string }
  | {
      status: "tied" | "untied";
      batchId: string;
      provider: string;
      externalRef: string;
      netAmount: string;
      currency: string;
      settlementDate: string;
      depositLines: DepositTieoutLine[];
      /** Net minus tied deposit total; null when currencies differ. */
      gapAmount: string | null;
    };

/**
 * Tie a posted payout to its bank deposit through the existing bank
 * reconciliation matches: the batch's bank-leg journal lines matched to
 * statement lines ARE the deposit. No parallel link table — the tie-out is
 * derived, so unmatching in Banking moves the payout back to in-transit
 * with no sync step. Draft batches have no journal legs yet and report
 * not_posted.
 */
export async function batchDepositTieout(
  orgId: string,
  batchId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<DepositTieout> {
  return withOrg(orgId, async () => {
    const batch = (
      await db.execute<{
        id: string;
        provider: string;
        external_ref: string;
        status: string;
        currency: string;
        net_amount: string;
        settlement_date: string;
        bank_account_id: string | null;
        journal_entry_id: string | null;
        subsidiary_id: string | null;
      }>(
        sql`
      select id, provider, external_ref, status, currency, net_amount::text,
             settlement_date::text, bank_account_id, journal_entry_id, subsidiary_id
        from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId}
    `,
        "objects",
      )
    )[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(allowedSubsidiaryIds, batch.subsidiary_id))
      throw new ScopeNotFoundError();
    if (batch.status !== "posted" || !batch.journal_entry_id || !batch.bank_account_id) {
      return { status: "not_posted", batchId };
    }
    // Ledger sums name their book state: only live legs tie to a deposit.
    const legs = await db.execute<{ id: string }>(
      sql`
      select jl.id from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${orgId} and jl.entry_id = ${batch.journal_entry_id}
         and jl.account_id = ${batch.bank_account_id}
         and je.status in ('posted', 'reversed')
    `,
      "objects",
    );
    if (legs.length === 0)
      return {
        status: "untied",
        batchId,
        provider: batch.provider,
        externalRef: batch.external_ref,
        netAmount: batch.net_amount,
        currency: batch.currency,
        settlementDate: batch.settlement_date,
        depositLines: [],
        gapAmount: batch.net_amount,
      };
    const legIds = legs.map((leg) => leg.id);
    const deposits = await db.execute<{
      statement_line_id: string;
      statement_id: string;
      posted_on: string;
      amount: string;
      currency: string;
      description: string | null;
      bank_transaction_id: string | null;
    }>(
      sql`
      select sl.id as statement_line_id, sl.statement_id, sl.posted_on::text,
             sl.amount::text, sl.currency, sl.description, sl.bank_transaction_id
        from reconciliation_matches m
        join bank_statement_lines sl on sl.id = m.statement_line_id and sl.org_id = m.org_id
       where m.org_id = ${orgId}
         and m.journal_line_id in (${sql.join(
           legIds.map((legId) => sql`${legId}::uuid`),
           sql`, `,
         )})
       order by sl.posted_on, sl.id
    `,
      "objects",
    );
    if (deposits.length === 0) {
      return {
        status: "untied",
        batchId,
        provider: batch.provider,
        externalRef: batch.external_ref,
        netAmount: batch.net_amount,
        currency: batch.currency,
        settlementDate: batch.settlement_date,
        depositLines: [],
        gapAmount: batch.net_amount,
      };
    }
    const foreign = deposits.find(
      (row) => row.currency.toUpperCase() !== batch.currency.toUpperCase(),
    );
    let gapAmount: string | null = null;
    if (!foreign) {
      let tied = 0n;
      for (const row of deposits) tied += toUnits(row.amount);
      gapAmount = fromUnits(toUnits(batch.net_amount) - tied);
    }
    return {
      status: "tied",
      batchId,
      provider: batch.provider,
      externalRef: batch.external_ref,
      netAmount: batch.net_amount,
      currency: batch.currency,
      settlementDate: batch.settlement_date,
      depositLines: deposits.map((row) => ({
        statementLineId: row.statement_line_id,
        statementId: row.statement_id,
        postedOn: row.posted_on,
        amount: row.amount,
        currency: row.currency,
        description: row.description,
        bankTransactionId: row.bank_transaction_id,
      })),
      gapAmount,
    };
  });
}

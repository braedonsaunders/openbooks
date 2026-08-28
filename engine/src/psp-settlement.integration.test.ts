import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  importSettlementBatch,
  postSettlementBatch,
  PspSettlementError,
  reverseSettlementBatch,
  type ParsedSettlement,
} from "./psp-settlement.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (pattern.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

test(
  "PSP settlement is atomic, exactly-once, balanced, auditable, and reverses append-only",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const parsed: ParsedSettlement = {
        provider: "stripe",
        externalRef: `payout-${org.orgId}`,
        settlementDate: org.date,
        currency: "CAD",
        memo: "PSP invariant settlement",
        raw: { source: "integration-test", immutable: true },
        lines: [
          {
            kind: "charge",
            amount: "200.0000",
            currency: "CAD",
            externalRef: "charge-1",
          },
          {
            kind: "fee",
            amount: "6.0000",
            currency: "CAD",
            externalRef: "fee-1",
          },
          {
            kind: "refund",
            amount: "20.0000",
            currency: "CAD",
            externalRef: "refund-1",
          },
          {
            kind: "dispute",
            amount: "15.0000",
            currency: "CAD",
            externalRef: "dispute-1",
          },
          {
            kind: "dispute_reversal",
            amount: "5.0000",
            currency: "CAD",
            externalRef: "dispute-reversal-1",
          },
          {
            kind: "fx_adjustment",
            amount: "1.2500",
            currency: "CAD",
            externalRef: "fx-1",
          },
        ],
      };
      const accounts = {
        bankAccountId: org.accounts.bank,
        feeAccountId: org.accounts.freight,
        disputeAccountId: org.accounts.adjustment,
        fxAccountId: org.accounts.fxGainLoss,
        clearingAccountId: org.accounts.clearing,
        subsidiaryId: org.subsidiaryId,
      };

      const imports = await Promise.all([
        importSettlementBatch(org.orgId, actor, parsed, accounts),
        importSettlementBatch(org.orgId, actor, parsed, accounts),
      ]);
      assert.equal(imports[0].batchId, imports[1].batchId);
      assert.equal(
        imports.filter((result) => result.created).length,
        1,
        "exactly one concurrent import creates the batch",
      );
      const batchId = imports[0].batchId;
      const draft = (await db.execute<{
          status: string;
          gross_amount: string;
          fee_amount: string;
          refund_amount: string;
          dispute_amount: string;
          fx_amount: string;
          net_amount: string;
          line_count: number;
        }>(sql`
        select status, gross_amount::text, fee_amount::text,
               refund_amount::text, dispute_amount::text, fx_amount::text,
               net_amount::text, line_count
          from psp_settlement_batches
         where id = ${batchId} and org_id = ${org.orgId}
      `));
      assert.deepEqual(draft.rows[0], {
        status: "draft",
        gross_amount: "200.0000",
        fee_amount: "6.0000",
        refund_amount: "20.0000",
        dispute_amount: "10.0000",
        fx_amount: "1.2500",
        net_amount: "165.2500",
        line_count: 6,
      });
      const evidenceLines = (await db.execute<{ count: number; distinct_refs: number }>(sql`
        select count(*)::int as count,
               count(distinct external_ref)::int as distinct_refs
          from psp_settlement_lines
         where batch_id = ${batchId} and org_id = ${org.orgId}
      `));
      assert.deepEqual(evidenceLines.rows[0], {
        count: 6,
        distinct_refs: 6,
      });

      const posts = await Promise.all([
        postSettlementBatch(org.orgId, batchId, actor),
        postSettlementBatch(org.orgId, batchId, actor),
      ]);
      assert.equal(
        posts[0].entryId,
        posts[1].entryId,
        "concurrent post retries return one journal",
      );
      const entryId = posts[0].entryId;
      const gl = (await db.execute<{ account_id: string; amount: string }>(sql`
        select account_id, sum(amount)::text as amount
          from journal_lines
         where entry_id = ${entryId} and org_id = ${org.orgId}
         group by account_id
         order by account_id
      `));
      const byAccount = new Map(
        gl.rows.map((line) => [line.account_id, line.amount]),
      );
      assert.equal(byAccount.get(org.accounts.bank), "165.2500");
      assert.equal(byAccount.get(org.accounts.freight), "6.0000");
      assert.equal(byAccount.get(org.accounts.adjustment), "10.0000");
      assert.equal(byAccount.get(org.accounts.fxGainLoss), "-1.2500");
      assert.equal(byAccount.get(org.accounts.clearing), "-180.0000");
      const balance = (await db.execute<{ amount: string }>(sql`
        select coalesce(sum(amount), 0)::text as amount
          from journal_lines where entry_id = ${entryId}
      `));
      assert.equal(balance.rows[0]?.amount, "0.0000");
      const postAudits = (await db.execute<{ count: number }>(sql`
        select count(*)::int as count
          from audit_log
         where org_id = ${org.orgId}
           and table_name = 'psp_settlement_batches'
           and row_id = ${batchId}
           and action = 'post'
      `));
      assert.equal(postAudits.rows[0]?.count, 1);

      const reimport = await importSettlementBatch(
        org.orgId,
        actor,
        { ...parsed, memo: "must not replace posted evidence", lines: [] },
        accounts,
      ).catch((error: unknown) => error);
      assert.ok(
        reimport instanceof PspSettlementError,
        "empty replacement payload fails before touching posted evidence",
      );
      const postedRetry = await importSettlementBatch(
        org.orgId,
        actor,
        { ...parsed, memo: "must not replace posted evidence" },
        accounts,
      );
      assert.deepEqual(postedRetry, { batchId, created: false });

      const reversals = await Promise.all([
        reverseSettlementBatch(org.orgId, batchId, actor, {
          reversalDate: org.date,
          reason: "Provider confirmed payout cancellation",
        }),
        reverseSettlementBatch(org.orgId, batchId, actor, {
          reversalDate: org.date,
          reason: "Provider confirmed payout cancellation",
        }),
      ]);
      assert.equal(reversals[0].entryId, reversals[1].entryId);
      const reversalEntryId = reversals[0].entryId;
      const mirror = (await db.execute<{
          source_amount: string;
          reversal_amount: string;
          source_txn_amount: string;
          reversal_txn_amount: string;
          same_account: boolean;
          same_currency: boolean;
          same_rate: boolean;
        }>(sql`
        select source.line_number,
               source.amount::text as source_amount,
               reversal.amount::text as reversal_amount,
               source.txn_amount::text as source_txn_amount,
               reversal.txn_amount::text as reversal_txn_amount,
               source.account_id = reversal.account_id as same_account,
               source.currency = reversal.currency as same_currency,
               source.fx_rate = reversal.fx_rate as same_rate
          from journal_lines source
          join journal_lines reversal
            on reversal.entry_id = ${reversalEntryId}
           and reversal.line_number = source.line_number
         where source.entry_id = ${entryId}
         order by source.line_number
      `));
      assert.equal(mirror.rows.length, 6);
      for (const line of mirror.rows) {
        assert.equal(
          BigInt(line.source_amount.replace(".", "")) +
            BigInt(line.reversal_amount.replace(".", "")),
          0n,
        );
        assert.equal(
          BigInt(line.source_txn_amount.replace(".", "")) +
            BigInt(line.reversal_txn_amount.replace(".", "")),
          0n,
        );
        assert.equal(line.same_account, true);
        assert.equal(line.same_currency, true);
        assert.equal(line.same_rate, true);
      }
      const lifecycle = (await db.execute<{
          status: string;
          journal_entry_id: string;
          reversal_entry_id: string;
          reversal_reason: string;
          reversed_by: string;
          source_status: string;
          reversal_status: string;
          reverses_entry_id: string;
        }>(sql`
        select b.status, b.journal_entry_id, b.reversal_entry_id,
               b.reversal_reason, b.reversed_by,
               source.status as source_status,
               reversal.status as reversal_status,
               reversal.reverses_entry_id
          from psp_settlement_batches b
          join journal_entries source on source.id = b.journal_entry_id
          join journal_entries reversal on reversal.id = b.reversal_entry_id
         where b.id = ${batchId} and b.org_id = ${org.orgId}
      `));
      assert.deepEqual(lifecycle.rows[0], {
        status: "void",
        journal_entry_id: entryId,
        reversal_entry_id: reversalEntryId,
        reversal_reason: "Provider confirmed payout cancellation",
        reversed_by: actor,
        source_status: "reversed",
        reversal_status: "posted",
        reverses_entry_id: entryId,
      });
      await assert.rejects(
        db.execute(sql`
          update journal_lines
             set memo = 'forbidden rewrite'
           where entry_id = ${entryId}
        `),
        (error: unknown) => errorChainMatches(error, /immutable/),
      );
      await assert.rejects(
        importSettlementBatch(org.orgId, actor, parsed, accounts),
        /voided provider settlement reference cannot be reused/,
      );

      const usd = await importSettlementBatch(
        org.orgId,
        actor,
        {
          ...parsed,
          externalRef: `${parsed.externalRef}-usd`,
          currency: "USD",
          lines: parsed.lines.map((line) => ({ ...line, currency: "USD" })),
        },
        accounts,
      );
      await assert.rejects(
        postSettlementBatch(org.orgId, usd.batchId, actor),
        /requires explicit rate and functional-currency evidence/,
      );
      const usdState = (await db.execute<{ status: string; journal_entry_id: string | null }>(sql`
        select status, journal_entry_id
          from psp_settlement_batches
         where id = ${usd.batchId}
      `));
      assert.deepEqual(usdState.rows[0], {
        status: "draft",
        journal_entry_id: null,
      });

      const locked = await importSettlementBatch(
        org.orgId,
        actor,
        { ...parsed, externalRef: `${parsed.externalRef}-locked` },
        accounts,
      );
      await db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state,
           locked_at, locked_by, reason, created_by, updated_by)
        values
          (${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId},
           'banking', 'closed', now(), ${actor}, 'PSP close-lock invariant',
           ${actor}, ${actor})
      `);
      await assert.rejects(
        postSettlementBatch(org.orgId, locked.batchId, actor),
        /BANKING is closed/,
      );
      const lockedState = (await db.execute<{ status: string; journal_entry_id: string | null }>(sql`
        select status, journal_entry_id
          from psp_settlement_batches
         where id = ${locked.batchId}
      `));
      assert.deepEqual(lockedState.rows[0], {
        status: "draft",
        journal_entry_id: null,
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "PSP settlement refuses FX adjustments when no realized FX account is configured",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const parsed: ParsedSettlement = {
        provider: "stripe",
        externalRef: `payout-fx-unconfigured-${org.orgId}`,
        settlementDate: org.date,
        currency: "CAD",
        lines: [
          {
            kind: "charge",
            amount: "100.0000",
            currency: "CAD",
            externalRef: "charge-1",
          },
          {
            kind: "fx_adjustment",
            amount: "1.2500",
            currency: "CAD",
            externalRef: "fx-1",
          },
        ],
      };
      const { batchId } = await importSettlementBatch(org.orgId, actor, parsed, {
        bankAccountId: org.accounts.bank,
        feeAccountId: org.accounts.freight,
        disputeAccountId: org.accounts.adjustment,
        clearingAccountId: org.accounts.clearing,
        subsidiaryId: org.subsidiaryId,
      });

      await db.execute(sql`
        update orgs
           set settings = settings #- '{controlAccounts,fxRealizedGainLoss}'
         where id = ${org.orgId}
      `);

      await assert.rejects(
        postSettlementBatch(org.orgId, batchId, actor),
        (error: unknown) =>
          error instanceof PspSettlementError &&
          error.message === "realized FX gain/loss account is not configured",
      );

      const state = (await db.execute<{
        status: string;
        journal_entry_id: string | null;
        journal_entries: number;
      }>(sql`
        select b.status,
               b.journal_entry_id,
               (select count(*)::int
                  from journal_entries j
                 where j.org_id = b.org_id
                   and j.id = b.journal_entry_id) as journal_entries
          from psp_settlement_batches b
         where b.id = ${batchId} and b.org_id = ${org.orgId}
      `));
      assert.deepEqual(state.rows[0], {
        status: "draft",
        journal_entry_id: null,
        journal_entries: 0,
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

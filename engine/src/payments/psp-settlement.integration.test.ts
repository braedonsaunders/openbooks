import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { UnrestrictedScopeError } from "../organization/subsidiary-scope.ts";
import { db } from "../platform/db.ts";
import {
  importSettlementBatch,
  parseChargebeeSettlement,
  postSettlementBatch,
  PspSettlementError,
  reverseSettlementBatch,
  savePspProviderConfig,
  type ParsedSettlement,
} from "./psp-settlement.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("provider config service requires the explicit unrestricted-scope sentinel", async () => {
  await assert.rejects(
    savePspProviderConfig("not-an-org", { provider: "stripe", isEnabled: true }, "actor", new Set(["sub-a"])),
    (error: unknown) => error instanceof UnrestrictedScopeError,
  );
});

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
        postSettlementBatch(org.orgId, batchId, actor, null),
        postSettlementBatch(org.orgId, batchId, actor, null),
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
        }, null),
        reverseSettlementBatch(org.orgId, batchId, actor, {
          reversalDate: org.date,
          reason: "Provider confirmed payout cancellation",
        }, null),
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
        postSettlementBatch(org.orgId, usd.batchId, actor, null),
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
        postSettlementBatch(org.orgId, locked.batchId, actor, null),
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
  "a dispute reversal heavier than the dispute posts the signed net on the dispute leg",
  { skip: !DB },
  async () => {
    // Regression: dispute 100 plus dispute_reversal 150 clamped the stored
    // dispute to 0 while net carried +50, so the GL dispute leg was skipped
    // and the 50 stranded in the clearing residual. The signed net rides the
    // dispute leg, and the stored row foots.
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const parsed: ParsedSettlement = {
        provider: "stripe",
        externalRef: `payout-dispute-net-${org.orgId}`,
        settlementDate: org.date,
        currency: "CAD",
        memo: "PSP dispute-net settlement",
        raw: { source: "integration-test", immutable: true },
        lines: [
          { kind: "charge", amount: "1000.0000", currency: "CAD", externalRef: "charge-1" },
          { kind: "dispute", amount: "100.0000", currency: "CAD", externalRef: "dispute-1" },
          { kind: "dispute_reversal", amount: "150.0000", currency: "CAD", externalRef: "dispute-reversal-1" },
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
      const imported = await importSettlementBatch(org.orgId, actor, parsed, accounts);
      assert.equal(imported.created, true);
      const row = (await db.execute<{
          gross_amount: string;
          dispute_amount: string;
          net_amount: string;
        }>(sql`
        select gross_amount::text, dispute_amount::text, net_amount::text
          from psp_settlement_batches
         where id = ${imported.batchId} and org_id = ${org.orgId}
      `));
      assert.deepEqual(row.rows[0], {
        gross_amount: "1000.0000",
        dispute_amount: "-50.0000",
        net_amount: "1050.0000",
      });
      const { entryId } = await postSettlementBatch(org.orgId, imported.batchId, actor, null);
      const gl = (await db.execute<{ account_id: string; amount: string }>(sql`
        select account_id, sum(amount)::text as amount
          from journal_lines
         where entry_id = ${entryId} and org_id = ${org.orgId}
         group by account_id
      `));
      const byAccount = new Map(gl.rows.map((line) => [line.account_id, line.amount]));
      assert.equal(byAccount.get(org.accounts.bank), "1050.0000");
      assert.equal(
        byAccount.get(org.accounts.adjustment),
        "-50.0000",
        "the reversal-heavy net posts on the dispute leg, not the clearing residual",
      );
      assert.equal(byAccount.get(org.accounts.clearing), "-1000.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an ordinary dispute-only batch is unchanged by signed dispute legs",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const parsed: ParsedSettlement = {
        provider: "stripe",
        externalRef: `payout-dispute-plain-${org.orgId}`,
        settlementDate: org.date,
        currency: "CAD",
        memo: "PSP dispute-only settlement",
        raw: { source: "integration-test", immutable: true },
        lines: [
          { kind: "charge", amount: "1000.0000", currency: "CAD", externalRef: "charge-1" },
          { kind: "dispute", amount: "100.0000", currency: "CAD", externalRef: "dispute-1" },
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
      const imported = await importSettlementBatch(org.orgId, actor, parsed, accounts);
      const row = (await db.execute<{ dispute_amount: string; net_amount: string }>(sql`
        select dispute_amount::text, net_amount::text
          from psp_settlement_batches
         where id = ${imported.batchId} and org_id = ${org.orgId}
      `));
      assert.deepEqual(row.rows[0], { dispute_amount: "100.0000", net_amount: "900.0000" });
      const { entryId } = await postSettlementBatch(org.orgId, imported.batchId, actor, null);
      const gl = (await db.execute<{ account_id: string; amount: string }>(sql`
        select account_id, sum(amount)::text as amount
          from journal_lines
         where entry_id = ${entryId} and org_id = ${org.orgId}
         group by account_id
      `));
      const byAccount = new Map(gl.rows.map((line) => [line.account_id, line.amount]));
      assert.equal(byAccount.get(org.accounts.adjustment), "100.0000");
      assert.equal(byAccount.get(org.accounts.clearing), "-1000.0000");
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
        postSettlementBatch(org.orgId, batchId, actor, null),
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

test(
  "settlement import and provider config refuse accounts from another organization",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const foreign = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const foreignBank = (
        await db.execute<{ id: string }>(sql`
          select id from accounts
           where org_id = ${foreign.orgId} and type = 'asset_bank'
             and is_active and not is_summary limit 1
        `)
      ).rows[0]!.id;
      const parsed: ParsedSettlement = {
        provider: "stripe",
        externalRef: `payout-foreign-${org.orgId}`,
        settlementDate: org.date,
        currency: "CAD",
        lines: [{ kind: "charge", amount: "100.0000", currency: "CAD" }],
      };
      const accounts = {
        bankAccountId: foreignBank,
        feeAccountId: org.accounts.freight,
        clearingAccountId: org.accounts.clearing,
        subsidiaryId: org.subsidiaryId,
      };
      // A foreign bank account must fail closed at the boundary with a domain
      // error — not persist and detonate as a raw FK 500 at posting time.
      await assert.rejects(
        importSettlementBatch(org.orgId, actor, parsed, accounts),
        (error: unknown) => {
          assert.ok(error instanceof PspSettlementError);
          assert.match((error as Error).message, /same organization|postable/i);
          return true;
        },
      );
      assert.equal(
        (
          await db.execute<{ n: number }>(sql`
            select count(*)::int as n from psp_settlement_batches
             where org_id = ${org.orgId} and external_ref = ${parsed.externalRef}
          `)
        ).rows[0]!.n,
        0,
        "the refused import stores no batch",
      );
      await assert.rejects(
        savePspProviderConfig(
          org.orgId,
          { provider: "stripe", isEnabled: true, defaultBankAccountId: foreignBank },
          actor,
          null,
        ),
        (error: unknown) => {
          assert.ok(error instanceof PspSettlementError);
          return true;
        },
      );
    } finally {
      await dropScratchOrg(foreign.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "settlement posting refuses a batch whose accounts left the organization",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const foreign = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const foreignBank = (
        await db.execute<{ id: string }>(sql`
          select id from accounts
           where org_id = ${foreign.orgId} and type = 'asset_bank'
             and is_active and not is_summary limit 1
        `)
      ).rows[0]!.id;
      // A bank account deactivated-or-foreign after import (or written around
      // the service) must fail closed naming the account — not escape as a
      // raw foreign-key 500 from the journal insert.
      const batchId = randomUUID();
      await db.execute(sql`
        insert into psp_settlement_batches
          (id, org_id, provider, external_ref, status, currency,
           gross_amount, net_amount, settlement_date,
           bank_account_id, fee_account_id, clearing_account_id, subsidiary_id,
           created_by, updated_by)
        values (${batchId}, ${org.orgId}, 'stripe', ${`payout-stale-${batchId}`}, 'draft', 'CAD',
                '100', '100', ${org.date},
                ${foreignBank}, ${org.accounts.freight}, ${org.accounts.clearing}, ${org.subsidiaryId},
                ${actor}, ${actor})
      `);
      await assert.rejects(
        postSettlementBatch(org.orgId, batchId, actor, null),
        (error: unknown) => {
          assert.ok(error instanceof PspSettlementError);
          assert.match((error as Error).message, /same organization|postable|not found/i);
          return true;
        },
      );
      assert.equal(
        (
          await db.execute<{ status: string; journal_entry_id: string | null }>(sql`
            select status, journal_entry_id from psp_settlement_batches
             where id = ${batchId} and org_id = ${org.orgId}
          `)
        ).rows[0]!.status,
        "draft",
        "the refused post leaves the draft without a journal",
      );
    } finally {
      await dropScratchOrg(foreign.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "provider config save refuses an unknown provider instead of a storage 500",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await assert.rejects(
        savePspProviderConfig(
          org.orgId,
          { provider: "wirecard" as unknown as "stripe", isEnabled: true },
          actor,
          null,
        ),
        (error: unknown) => {
          assert.ok(error instanceof PspSettlementError);
          return true;
        },
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "Chargebee settlement imports amount_paid with adjustments as their own evidence line",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      // Real-shaped provider payload: unix date, minor-unit ints, entity-typed
      // detail. $100 billed, $80 collected, $20 adjusted off for goodwill.
      const parsed = parseChargebeeSettlement(
        {
          id: `cb-settle-${org.orgId}`,
          date: 1720000000,
          currency_code: "CAD",
          total: 10_000,
          amount_paid: 8_000,
          amount_adjusted: 2_000,
          adjustment_reason: "goodwill",
          line_items: [
            { id: "li_plan", description: "Standard plan", amount: 9_000, entity_type: "plan" },
            { id: "li_tax", description: "Sales tax", amount: 1_000, entity_type: "tax" },
          ],
        },
        org.date,
      );
      const accounts = {
        bankAccountId: org.accounts.bank,
        feeAccountId: org.accounts.freight,
        disputeAccountId: org.accounts.adjustment,
        fxAccountId: org.accounts.fxGainLoss,
        clearingAccountId: org.accounts.clearing,
        subsidiaryId: org.subsidiaryId,
      };
      const first = await importSettlementBatch(org.orgId, actor, parsed, accounts);
      assert.equal(first.created, true);
      const batch = (await db.execute<{
          status: string;
          gross_amount: string;
          fee_amount: string;
          refund_amount: string;
          dispute_amount: string;
          adjustment_amount: string;
          fx_amount: string;
          net_amount: string;
          line_count: number;
        }>(sql`
        select status, gross_amount::text, fee_amount::text,
               refund_amount::text, dispute_amount::text,
               adjustment_amount::text, fx_amount::text, net_amount::text,
               line_count
          from psp_settlement_batches
         where id = ${first.batchId} and org_id = ${org.orgId}
      `));
      // The receipt is what was collected: gross − adjustments == amount_paid,
      // with adjustments tracked apart from refunds.
      assert.deepEqual(batch.rows[0], {
        status: "draft",
        gross_amount: "100.0000",
        fee_amount: "0.0000",
        refund_amount: "0.0000",
        dispute_amount: "0.0000",
        adjustment_amount: "20.0000",
        fx_amount: "0.0000",
        net_amount: "80.0000",
        line_count: 3,
      });
      const stored = (await db.execute<{
          line_number: number;
          kind: string;
          external_ref: string | null;
          description: string | null;
          amount: string;
          meta: Record<string, unknown>;
        }>(sql`
        select line_number, kind, external_ref, description, amount::text as amount, meta
          from psp_settlement_lines
         where batch_id = ${first.batchId} and org_id = ${org.orgId}
         order by line_number
      `));
      assert.deepEqual(
        stored.rows.map((line) => [line.kind, line.amount]),
        [
          ["charge", "90.0000"],
          ["other", "10.0000"],
          ["adjustment", "20.0000"],
        ],
      );
      assert.equal(stored.rows[2]!.external_ref, `cb-settle-${org.orgId}_adjustment`);
      assert.equal(stored.rows[2]!.description, "Chargebee adjustment (goodwill)");
      assert.deepEqual(stored.rows[2]!.meta, { chargebeeReason: "goodwill" });

      // Replay is idempotent: same batch, same evidence, no duplicate lines.
      const replay = await importSettlementBatch(org.orgId, actor, parsed, accounts);
      assert.deepEqual(replay, { batchId: first.batchId, created: false });
      assert.equal(
        (
          await db.execute<{ n: number }>(sql`
            select count(*)::int as n from psp_settlement_lines
             where batch_id = ${first.batchId} and org_id = ${org.orgId}
          `)
        ).rows[0]!.n,
        3,
      );

      // An unfooted invoice never reaches storage: the parse refuses naming it.
      const mismatchId = `cb-mismatch-${org.orgId}`;
      assert.throws(
        () =>
          parseChargebeeSettlement(
            {
              id: mismatchId,
              currency_code: "CAD",
              total: 10_000,
              amount_paid: 8_000,
              amount_adjusted: 1_000,
            },
            org.date,
          ),
        (error: unknown) =>
          error instanceof PspSettlementError && error.message.includes(mismatchId),
      );
      assert.equal(
        (
          await db.execute<{ n: number }>(sql`
            select count(*)::int as n from psp_settlement_batches
             where org_id = ${org.orgId} and external_ref = ${mismatchId}
          `)
        ).rows[0]!.n,
        0,
        "the refused settlement stores no batch",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "Chargebee settlement posts the collected amount to bank with adjustments on their own clearing line",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const parsed = parseChargebeeSettlement(
        {
          id: `cb-post-${org.orgId}`,
          // Unix provider timestamp aligned to the scratch org's open period.
          date: Math.floor(new Date(`${org.date}T12:00:00Z`).getTime() / 1000),
          currency_code: "CAD",
          total: 10_000,
          amount_paid: 8_000,
          amount_adjusted: 2_000,
          adjustment_reason: "goodwill",
          line_items: [
            { id: "li_plan", description: "Standard plan", amount: 9_000, entity_type: "plan" },
            { id: "li_tax", description: "Sales tax", amount: 1_000, entity_type: "tax" },
          ],
        },
        org.date,
      );
      const { batchId } = await importSettlementBatch(org.orgId, actor, parsed, {
        bankAccountId: org.accounts.bank,
        feeAccountId: org.accounts.freight,
        disputeAccountId: org.accounts.adjustment,
        fxAccountId: org.accounts.fxGainLoss,
        clearingAccountId: org.accounts.clearing,
        subsidiaryId: org.subsidiaryId,
      });
      const { entryId } = await postSettlementBatch(org.orgId, batchId, actor, null);
      const gl = (await db.execute<{ account_id: string; memo: string; amount: string }>(sql`
        select account_id, memo, sum(amount)::text as amount
          from journal_lines
         where entry_id = ${entryId} and org_id = ${org.orgId}
         group by account_id, memo
         order by memo
      `));
      const byMemo = new Map(gl.rows.map((line) => [line.memo, line]));
      // Bank receipts exactly what was collected; the adjustment clears the
      // customer balance on its own line, apart from any refund leg.
      assert.equal(byMemo.get("PSP net deposit")?.amount, "80.0000");
      assert.equal(byMemo.get("PSP net deposit")?.account_id, org.accounts.bank);
      assert.equal(byMemo.get("PSP adjustments")?.amount, "20.0000");
      assert.equal(byMemo.get("PSP adjustments")?.account_id, org.accounts.clearing);
      assert.equal(byMemo.get("PSP clearing / charges")?.amount, "-100.0000");
      assert.equal(byMemo.get("PSP clearing / charges")?.account_id, org.accounts.clearing);
      assert.equal(gl.rows.length, 3);
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
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

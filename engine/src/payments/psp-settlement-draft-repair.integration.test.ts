import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  importSettlementBatch,
  postSettlementBatch,
  PspSettlementConflictError,
  PspSettlementError,
  type ParsedSettlement,
} from "./psp-settlement.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function payout(ref: string, date: string): ParsedSettlement {
  return {
    provider: "stripe",
    externalRef: ref,
    settlementDate: date,
    currency: "CAD",
    memo: "draft repair payout",
    raw: { source: "draft-repair-test", immutable: true },
    lines: [
      { kind: "charge", amount: "100.0000", currency: "CAD", externalRef: "charge-1" },
      { kind: "fee", amount: "5.0000", currency: "CAD", externalRef: "fee-1" },
    ],
  };
}

test(
  "an unposted draft is repaired by re-importing the same reference with its missing configuration",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const parsed = payout(`po_0306-${org.orgId}`, org.date);

      const first = await importSettlementBatch(org.orgId, actor, parsed, {});
      const draft = (
        await db.execute<{ status: string }>(
          sql`
        select status from psp_settlement_batches
         where id = ${first.batchId} and org_id = ${org.orgId}
      `,
          "objects",
        )
      )[0];
      assert.equal(draft?.status, "draft");

      await assert.rejects(
        postSettlementBatch(org.orgId, first.batchId, actor, null),
        (error: unknown) =>
          error instanceof PspSettlementError &&
          /cannot post without bank account, clearing account, fee account/.test(error.message) &&
          /re-import the same provider reference with the missing details to repair this draft/.test(
            error.message,
          ),
        "posting names the missing configuration and the repair path that works",
      );

      const accounts = {
        bankAccountId: org.accounts.bank,
        feeAccountId: org.accounts.freight,
        clearingAccountId: org.accounts.clearing,
        subsidiaryId: org.subsidiaryId,
      };
      const repair = await importSettlementBatch(org.orgId, actor, parsed, accounts);
      assert.deepEqual(repair, { batchId: first.batchId, created: false });

      const repaired = (
        await db.execute<{
          bank_account_id: string | null;
          fee_account_id: string | null;
          clearing_account_id: string | null;
          subsidiary_id: string | null;
          line_count: number;
        }>(
          sql`
        select bank_account_id, fee_account_id, clearing_account_id, subsidiary_id, line_count
          from psp_settlement_batches
         where id = ${first.batchId} and org_id = ${org.orgId}
      `,
          "objects",
        )
      )[0];
      assert.equal(repaired?.bank_account_id, org.accounts.bank);
      assert.equal(repaired?.fee_account_id, org.accounts.freight);
      assert.equal(repaired?.clearing_account_id, org.accounts.clearing);
      assert.equal(repaired?.subsidiary_id, org.subsidiaryId);
      assert.equal(repaired?.line_count, 2);

      const audits = (
        await db.execute<{ changes: unknown }>(
          sql`
        select changes from audit_log
         where org_id = ${org.orgId}
           and table_name = 'psp_settlement_batches'
           and row_id = ${first.batchId}
           and action = 'update'
         order by id desc limit 1
      `,
          "objects",
        )
      )[0]?.changes as { mode?: string } | undefined;
      assert.equal(audits?.mode, "draft_configuration_repair");

      const { entryId } = await postSettlementBatch(org.orgId, first.batchId, actor, null);
      const balance = await db.execute<{ amount: string }>(
        sql`
        select coalesce(sum(amount), 0)::text as amount
          from journal_lines where entry_id = ${entryId} and org_id = ${org.orgId}
      `,
        "objects",
      );
      assert.equal(balance[0]?.amount, "0.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "re-importing a draft with different line evidence refuses naming the difference",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const parsed = payout(`po_0310-${org.orgId}`, org.date);
      const accounts = {
        bankAccountId: org.accounts.bank,
        feeAccountId: org.accounts.freight,
        clearingAccountId: org.accounts.clearing,
        subsidiaryId: org.subsidiaryId,
      };
      const first = await importSettlementBatch(org.orgId, actor, parsed, accounts);

      const error = await importSettlementBatch(
        org.orgId,
        actor,
        {
          ...parsed,
          lines: parsed.lines.map((line, index) =>
            index === 0 ? { ...line, amount: "999.0000" } : line,
          ),
        },
        accounts,
      ).catch((failure: unknown) => failure);
      assert.ok(error instanceof PspSettlementConflictError);
      assert.match(
        error.message,
        /already has different evidence \(gross amount differs \(stored 100\.0000 vs imported 999\.0000\)\)/,
      );

      const reordered = await importSettlementBatch(
        org.orgId,
        actor,
        {
          ...parsed,
          lines: [...parsed.lines].reverse(),
        },
        accounts,
      ).catch((failure: unknown) => failure);
      assert.ok(reordered instanceof PspSettlementConflictError);
      assert.match(
        (reordered as PspSettlementConflictError).message,
        /already has different evidence \(line 1 kind differs \(stored charge vs imported fee\)\)/,
      );

      const kept = (
        await db.execute<{ status: string; gross_amount: string }>(
          sql`
        select status, gross_amount::text from psp_settlement_batches
         where id = ${first.batchId} and org_id = ${org.orgId}
      `,
          "objects",
        )
      )[0];
      assert.equal(kept?.status, "draft");
      assert.equal(kept?.gross_amount, "100.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a posted batch keeps its configuration immutable when the evidence matches",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const parsed = payout(`po_0314-${org.orgId}`, org.date);
      const accounts = {
        bankAccountId: org.accounts.bank,
        feeAccountId: org.accounts.freight,
        clearingAccountId: org.accounts.clearing,
        subsidiaryId: org.subsidiaryId,
      };
      const first = await importSettlementBatch(org.orgId, actor, parsed, accounts);
      await postSettlementBatch(org.orgId, first.batchId, actor, null);

      await assert.rejects(
        importSettlementBatch(org.orgId, actor, parsed, {
          ...accounts,
          feeAccountId: org.accounts.adjustment,
        }),
        (error: unknown) =>
          error instanceof PspSettlementConflictError &&
          /already has different evidence \(only the posting configuration differs/.test(
            error.message,
          ),
        "posted history cannot be reconfigured by re-import",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

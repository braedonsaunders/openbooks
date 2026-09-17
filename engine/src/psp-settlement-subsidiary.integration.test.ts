import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  importSettlementBatch,
  parseStripeBalanceTransactions,
  postSettlementBatch,
  PspSettlementError,
} from "./psp-settlement.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "./test-fixtures.ts";

/**
 * F-t06-004: a PSP settlement draft could never post. The UI import form
 * collected the three account UUIDs but never asked for a subsidiary, so the
 * batch stored `subsidiary_id null`; posting then refused with a combined
 * message that blamed the accounts the batch already carried, and the row
 * offered no repair path. These tests pin the repaired lifecycle:
 *  - posting names exactly what is missing (never present accounts);
 *  - an absent subsidiary resolves to the org root exactly like every other
 *    document (posting.ts: docSubId ?? root);
 *  - a stranded draft is repaired by re-importing the same provider
 *    reference with the missing details (the import path fills them in);
 *  - import itself refuses malformed, foreign, and inactive subsidiaries
 *    instead of persisting them to detonate at posting.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

function stripeParsed(externalRef: string, settlementDate: string) {
  return parseStripeBalanceTransactions(
    [
      {
        id: "ch_t06_1",
        type: "charge",
        amount: 250000,
        currency: "CAD",
        fee: 7250,
        net: 242750,
      },
    ],
    externalRef,
    settlementDate,
  );
}

async function batchState(orgId: string, batchId: string) {
  const rows = (await db.execute<{
    status: string;
    subsidiaryId: string | null;
    journalEntryId: string | null;
  }>(sql`
    select status, subsidiary_id as "subsidiaryId",
           journal_entry_id as "journalEntryId"
      from psp_settlement_batches
     where id = ${batchId} and org_id = ${orgId}
  `)).rows;
  return rows[0]!;
}

test(
  "post names only the missing subsidiary and re-import repairs the draft (F-t06-004)",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const secondSub = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, name, base_currency, country, parent_id, tax_ids, is_elimination, is_active, custom)
        values (${secondSub}, ${org.orgId}, 'Second Co', 'CAD', 'CA', ${org.subsidiaryId}, '{}'::jsonb, false, true, '{}'::jsonb)
      `);
      const externalRef = `payout-nosub-${org.orgId}`;
      const accounts = {
        bankAccountId: org.accounts.bank,
        feeAccountId: org.accounts.freight,
        clearingAccountId: org.accounts.clearing,
      };
      const { batchId } = await importSettlementBatch(
        org.orgId,
        actor,
        stripeParsed(externalRef, org.date),
        accounts,
      );
      await assert.rejects(
        postSettlementBatch(org.orgId, batchId, actor),
        (error) => {
          assert.ok(error instanceof PspSettlementError);
          assert.match(error.message, /subsidiary/);
          assert.doesNotMatch(error.message, /bank account/);
          assert.doesNotMatch(error.message, /clearing account/);
          assert.doesNotMatch(error.message, /fee account/);
          return true;
        },
      );
      assert.equal((await batchState(org.orgId, batchId)).status, "draft");

      // Repair: re-importing the same provider reference with the missing
      // subsidiary fills the draft in place (coalesce update path).
      await importSettlementBatch(org.orgId, actor, stripeParsed(externalRef, org.date), {
        ...accounts,
        subsidiaryId: secondSub,
      });
      const { entryId } = await postSettlementBatch(org.orgId, batchId, actor);
      assert.ok(entryId);
      const after = await batchState(org.orgId, batchId);
      assert.equal(after.status, "posted");
      assert.equal(after.journalEntryId, entryId);
      assert.equal(after.subsidiaryId, secondSub);
      const lines = (await db.execute<{ count: number }>(sql`
        select count(*)::int as count from journal_lines
         where entry_id = ${entryId} and org_id = ${org.orgId}
           and subsidiary_id = ${secondSub}
      `)).rows[0]!;
      assert.ok(lines.count > 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a single-entity org posts a subsidiary-less draft to the root (F-t06-004)",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const { batchId } = await importSettlementBatch(
        org.orgId,
        actor,
        stripeParsed(`payout-singlesub-${org.orgId}`, org.date),
        {
          bankAccountId: org.accounts.bank,
          feeAccountId: org.accounts.freight,
          clearingAccountId: org.accounts.clearing,
        },
      );
      const { entryId } = await postSettlementBatch(org.orgId, batchId, actor);
      const after = await batchState(org.orgId, batchId);
      assert.equal(after.status, "posted");
      assert.equal(after.subsidiaryId, org.subsidiaryId);
      const entry = (await db.execute<{ subsidiaryId: string }>(sql`
        select subsidiary_id as "subsidiaryId" from journal_entries
         where id = ${entryId} and org_id = ${org.orgId}
      `)).rows[0]!;
      assert.equal(entry.subsidiaryId, org.subsidiaryId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "import refuses malformed, foreign, and inactive subsidiaries (F-t06-004)",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const accounts = {
        bankAccountId: org.accounts.bank,
        feeAccountId: org.accounts.freight,
        clearingAccountId: org.accounts.clearing,
      };
      await assert.rejects(
        importSettlementBatch(
          org.orgId,
          actor,
          stripeParsed(`payout-badsub-${org.orgId}`, org.date),
          { ...accounts, subsidiaryId: "not-a-uuid" },
        ),
        /not a valid subsidiary reference/,
      );
      await assert.rejects(
        importSettlementBatch(
          org.orgId,
          actor,
          stripeParsed(`payout-foreignsub-${org.orgId}`, org.date),
          { ...accounts, subsidiaryId: randomUUID() },
        ),
        /not a subsidiary of this organization/,
      );
      const inactiveSub = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, name, base_currency, country, parent_id, tax_ids, is_elimination, is_active, custom)
        values (${inactiveSub}, ${org.orgId}, 'Dormant Co', 'CAD', 'CA', ${org.subsidiaryId}, '{}'::jsonb, false, false, '{}'::jsonb)
      `);
      await assert.rejects(
        importSettlementBatch(
          org.orgId,
          actor,
          stripeParsed(`payout-inactivesub-${org.orgId}`, org.date),
          { ...accounts, subsidiaryId: inactiveSub },
        ),
        /is inactive/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

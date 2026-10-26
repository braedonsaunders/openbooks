/**
 * Row guards that storage enforces for every writer, engine or direct SQL:
 * the dunning delivery lifecycle, the price-schedule revision fence, the
 * legacy-reconciliation attestation on performance obligations and the
 * write-once tax filing snapshot. Each refusal is asserted under the
 * guard's own name or message, beside a write the guard admits.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/platform/db";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/testing/fixtures";

const DB = !!process.env.OPENBOOKS_DB_URL;
const ROLLBACK = Symbol("storage-guard-rollback");

/** Driver refusals travel on the cause chain beneath the Drizzle wrapper. */
function refusedBy(pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    const messages: string[] = [];
    let current: unknown = error;
    while (current && typeof current === "object" && messages.length < 6) {
      const candidate = current as { message?: unknown; cause?: unknown };
      if (typeof candidate.message === "string") messages.push(candidate.message);
      current = candidate.cause;
    }
    assert.match(messages.join("\n"), pattern);
    return true;
  };
}

/** Run inside one transaction that always rolls back. */
async function rolledBack(run: () => Promise<void>): Promise<void> {
  await withBypass(() =>
    db.transaction(async () => {
      await run();
      throw ROLLBACK;
    }),
  ).catch((error) => {
    if (error !== ROLLBACK) throw error;
  });
}

/** A refusal aborts its statement; a savepoint keeps the outer transaction usable. */
async function refusedInSavepoint(
  statement: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await db.execute(sql`savepoint guard_probe`);
  await assert.rejects(statement(), refusedBy(pattern));
  await db.execute(sql`rollback to savepoint guard_probe`);
}

test("a dunning log row carries only a known delivery status", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await withBypass(async () => {
      await assert.rejects(
        db.execute(sql`
          insert into dunning_log (id, org_id, document_id, policy_id, stage_id, status)
          values (${randomUUID()}, ${org.orgId}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'bogus')`),
        refusedBy(/dunning_log_status/),
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "a price schedule revision is non-negative and a change reason is never blank",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await rolledBack(async () => {
        const [{ ccy }] = await db.execute<{ ccy: string }>(
          sql`
        select base_currency as ccy from subsidiaries where id = ${org.subsidiaryId}`,
          "objects",
        );
        // Inactive schedules, so the guards under test are the only ones in play.
        const insert = (revision: number, reason: string | null) =>
          db.execute(sql`
        insert into item_price_schedules
          (org_id, item_id, customer_id, currency, effective_from, is_active, revision, change_reason)
        values (${org.orgId}, ${org.items.fifo}, ${org.customerId}, ${ccy}, ${org.date}, false,
                ${revision}, ${reason})`);
        await insert(0, null);
        await insert(1, "list price correction");
        await refusedInSavepoint(
          () => insert(-1, null),
          /item_price_schedule_revision_nonnegative/,
        );
        await refusedInSavepoint(() => insert(2, "   "), /item_price_schedule_reason_present/);
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("a legacy-reconciliation attestation is all or nothing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actor = randomUUID();
  try {
    await rolledBack(async () => {
      const contract = randomUUID();
      await db.execute(sql`
        insert into revenue_contracts
          (id, org_id, customer_id, contract_number, status, starts_on, currency,
           total_transaction_price, created_by, updated_by)
        values (${contract}, ${org.orgId}, ${org.customerId}, 'ATTEST-1', 'active', ${org.date}, 'CAD',
                1200, ${actor}, ${actor})`);
      const insert = (
        description: string,
        attestation: { at: boolean; by: boolean; reason: string | null },
      ) =>
        db.execute(sql`
          insert into performance_obligations
            (id, org_id, contract_id, description, recognition_rule_id, allocated_price, status,
             legacy_reconciled_at, legacy_reconciled_by, legacy_reconciliation_reason, created_by, updated_by)
          values (${randomUUID()}, ${org.orgId}, ${contract}, ${description}, ${org.recognitionRuleId}, 1200, 'open',
                  ${attestation.at ? sql`now()` : sql`null`}, ${attestation.by ? actor : null},
                  ${attestation.reason}, ${actor}, ${actor})`);

      await insert("Unreconciled obligation", { at: false, by: false, reason: null });
      await insert("Reconciled obligation", {
        at: true,
        by: true,
        reason: "verified against the signed January policy memo",
      });
      await refusedInSavepoint(
        () => insert("Half attested", { at: true, by: true, reason: null }),
        /performance_obligations_legacy_reconciliation_shape/,
      );
      await refusedInSavepoint(
        () => insert("Too short a reason", { at: true, by: true, reason: "ok" }),
        /performance_obligations_legacy_reconciliation_shape/,
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stored tax filing changes only by filing it, and never after", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await rolledBack(async () => {
      const [{ ccy }] = await db.execute<{ ccy: string }>(
        sql`
        select base_currency as ccy from subsidiaries where id = ${org.subsidiaryId}`,
        "objects",
      );
      const filingId = randomUUID();
      await db.execute(sql`
        insert into tax_filings
          (id, org_id, form_code, form_name, country, period_from, period_to, version,
           status, submission_channel, boxes, snapshot_hash, functional_currency)
        values (${filingId}, ${org.orgId}, 'TEST_FORM', 'Test return', 'CA', '2026-01-01', '2026-03-31', 1,
                'prepared', 'paper', '[]'::jsonb, ${"a".repeat(64)}, ${ccy})`);

      await refusedInSavepoint(
        () => db.execute(sql`update tax_filings set form_name = 'edited' where id = ${filingId}`),
        /tax filing snapshots are immutable/,
      );
      await refusedInSavepoint(
        () =>
          db.execute(sql`
          update tax_filings
             set status = 'filed', filed_at = now(), filing_reference = 'REF-1', boxes = '[{"box":"1"}]'::jsonb
           where id = ${filingId}`),
        /tax filing snapshots are immutable/,
      );

      const filed = await db.execute(sql`
        update tax_filings set status = 'filed', filed_at = now(), filing_reference = 'REF-1'
         where id = ${filingId}`);
      assert.equal(filed.rowCount, 1, "prepared to filed is the one admitted transition");

      await refusedInSavepoint(
        () =>
          db.execute(sql`update tax_filings set filing_reference = 'REF-2' where id = ${filingId}`),
        /tax filing snapshots are immutable/,
      );
      await refusedInSavepoint(
        () => db.execute(sql`delete from tax_filings where id = ${filingId}`),
        /tax filing snapshots cannot be deleted/,
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

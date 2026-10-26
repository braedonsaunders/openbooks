/// <reference types="node" />

/**
 * Recognition events reference their performance obligation through the
 * tenant-composite key (org_id, obligation_id), so an event can never book
 * revenue for another tenant's obligation, while deleting a tenant's own
 * obligation still cascades to its events.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "@openbooks/engine/testing/fixtures";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; cause?: unknown };
    if (candidate.code) return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

async function seedObligation(org: ScratchOrg, label: string): Promise<string> {
  const contractId = randomUUID();
  const obligationId = randomUUID();
  await db.execute(sql`
    insert into revenue_contracts (id, org_id, customer_id, contract_number)
    values (${contractId}, ${org.orgId}, ${org.customerId}, ${`contract-${label}-${contractId.slice(0, 8)}`})`);
  await db.execute(sql`
    insert into performance_obligations (id, org_id, contract_id, description, recognition_rule_id, allocated_price)
    values (${obligationId}, ${org.orgId}, ${contractId}, ${`Obligation ${label}`}, ${org.recognitionRuleId}, 10)`);
  return obligationId;
}

async function insertEvent(
  orgId: string,
  obligationId: string,
  sourceReference: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into recognition_events (id, org_id, obligation_id, period_month, amount, source_reference)
    values (${id}, ${orgId}, ${obligationId}, '2026-08-01', 10, ${sourceReference})`);
  return id;
}

function refusedByForeignKey(scenario: string) {
  return (error: unknown) => {
    assert.equal(postgresCode(error), "23503", scenario);
    return true;
  };
}

test(
  "recognition events are tenant-coherent with their obligation and cascade within the tenant",
  { skip: !DB, timeout: 60_000 },
  async () => {
    const first = await createScratchOrg();
    const second = await createScratchOrg();
    try {
      const key = await db.execute<{ definition: string }>(
        sql`
        select pg_get_constraintdef(oid) as definition
          from pg_constraint
         where conrelid = 'public.recognition_events'::regclass
           and conname = 'recognition_events_obligation_id_fkey'`,
        "objects",
      );
      assert.equal(key.length, 1, "recognition_events_obligation_id_fkey must exist");
      assert.match(
        key[0]!.definition,
        /^FOREIGN KEY \(org_id, obligation_id\) REFERENCES performance_obligations\(org_id, id\) ON DELETE CASCADE/,
      );

      const firstObligation = await seedObligation(first, "first");
      const secondObligation = await seedObligation(second, "second");

      await assert.rejects(
        insertEvent(first.orgId, secondObligation, "cross-tenant"),
        refusedByForeignKey("the composite key refuses another tenant's obligation"),
      );
      const ownEvent = await insertEvent(first.orgId, firstObligation, "same-tenant");
      await assert.rejects(
        db.execute(
          sql`update recognition_events set obligation_id = ${secondObligation} where id = ${ownEvent}`,
        ),
        refusedByForeignKey("re-pointing an event across tenants is refused"),
      );

      const cascaded = await insertEvent(second.orgId, secondObligation, "cascade");
      await db.execute(sql`delete from performance_obligations where id = ${secondObligation}`);
      const remaining = await db.execute<{ id: string }>(
        sql`
        select id from recognition_events where id = ${cascaded}`,
        "objects",
      );
      assert.equal(remaining.length, 0, "same-tenant obligation deletion cascades its event");
    } finally {
      await dropScratchOrg(second.orgId);
      await dropScratchOrg(first.orgId);
    }
  },
);

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  buildRecognitionSchedule,
  reconcileLegacyObligationProvenance,
} from "./recognition.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const MONTHS_2026 = [
  ["2026-01", "2026-01-01", "2026-01-31"],
  ["2026-02", "2026-02-01", "2026-02-28"],
  ["2026-03", "2026-03-01", "2026-03-31"],
  ["2026-04", "2026-04-01", "2026-04-30"],
  ["2026-05", "2026-05-01", "2026-05-31"],
  ["2026-06", "2026-06-01", "2026-06-30"],
  ["2026-07", "2026-07-01", "2026-07-31"],
  ["2026-08", "2026-08-01", "2026-08-31"],
  ["2026-09", "2026-09-01", "2026-09-30"],
  ["2026-10", "2026-10-01", "2026-10-31"],
  ["2026-11", "2026-11-01", "2026-11-30"],
  ["2026-12", "2026-12-01", "2026-12-31"],
] as const;

const REASON =
  "Schedule verified against the signed policy memo in force at creation; the later in-place rule edit postdates it";

/**
 * H-REVENUE: reconciling a legacy-provenance obligation attests its schedule
 * and lifts the rebuild refusal — a cross-subsidiary write. The obligation's
 * entity is its contract's subsidiary (the same attribution posting uses), so
 * a caller scoped to entity A must be refused exactly like a missing id when
 * they name B's obligation, while A and unrestricted callers proceed.
 */
async function scopedFixture() {
  const org = await createScratchOrg();
  const actorId = randomUUID();
  const subB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`);
  const calId = (await db.execute<{ id: string }>(sql`
    select id from fiscal_calendars where org_id = ${org.orgId} and is_default = true`)).rows[0]!.id;
  for (const [num, name, start, end] of MONTHS_2026.map(([name, start, end], i) => [i + 1, name, start, end] as const)) {
    if (num === 7) continue;
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${org.orgId}, 2026, ${num}, ${name}, ${start}, ${end}, false, ${calId})`);
  }
  const ruleId = randomUUID();
  await db.execute(sql`
    insert into recognition_rules
      (id, org_id, code, name, method, is_forecast, recognition_periods, start_date_source, end_date_source,
       period_offset, start_offset_days, initial_amount_percent, deferred_account_id, recognized_account_id, is_active)
    values (${ruleId}, ${org.orgId}, 'LEGACY-SL-SCOPE', 'Legacy straight line', 'straight_line_even', false, 12,
            'obligation', 'term', 0, 0, '0', ${org.accounts.deferred}, ${org.accounts.recognized}, true)`);
  const obligationIds: Record<"own" | "foreign" | "foreignOpen", string> = {
    own: randomUUID(),
    foreign: randomUUID(),
    foreignOpen: randomUUID(),
  };
  const contracts: Record<keyof typeof obligationIds, string> = {
    own: randomUUID(),
    foreign: randomUUID(),
    foreignOpen: randomUUID(),
  };
  const subs: Record<keyof typeof obligationIds, string> = {
    own: org.subsidiaryId,
    foreign: subB,
    foreignOpen: subB,
  };
  for (const key of Object.keys(obligationIds) as (keyof typeof obligationIds)[]) {
    await db.execute(sql`
      insert into revenue_contracts
        (id, org_id, customer_id, contract_number, status, starts_on, currency, total_transaction_price, subsidiary_id, created_by, updated_by)
      values (${contracts[key]}, ${org.orgId}, ${org.customerId}, ${`LEGACY-SCOPE-${key}`}, 'active', '2026-01-01',
              'CAD', '12000', ${subs[key]}, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into performance_obligations
        (id, org_id, contract_id, description, recognition_rule_id,
         booked_amount, allocated_price, recognition_starts_on, status, created_by, updated_by)
      values (${obligationIds[key]}, ${org.orgId}, ${contracts[key]}, ${`Legacy service ${key}`}, ${ruleId},
              '12000', '12000', '2026-01-01', 'open', ${actorId}, ${actorId})`);
    const build = await buildRecognitionSchedule(obligationIds[key], org.orgId, actorId);
    assert.equal(build.lineCount, 12);
  }
  // The in-place rule edit that marks every obligation on this rule legacy.
  await db.execute(sql`
    update recognition_rules set method = 'point_in_time', updated_at = now()
     where id = ${ruleId} and org_id = ${org.orgId}`);
  await db.execute(sql`
    insert into upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
    values (${org.orgId}, '0297_recognition_rule_versions', 'recognition_rules', ${ruleId}, 'test mark')`);
  return { org, actorId, subA: org.subsidiaryId, subB, obligationIds };
}

async function reconciledAt(orgId: string, obligationId: string): Promise<string | null> {
  return ((await db.execute<{ at: string | null }>(sql`
    select legacy_reconciled_at::text as at from performance_obligations
     where id = ${obligationId} and org_id = ${orgId}`)).rows[0]?.at ?? null);
}

function isUniformNotFound(error: unknown): boolean {
  return error instanceof ScopeNotFoundError && error.message === "not found";
}

test("an entity-A attester cannot lift the legacy refusal on entity B's obligation", { skip: !DB }, async () => {
  const { org, actorId, subA, obligationIds } = await scopedFixture();
  try {
    await assert.rejects(
      reconcileLegacyObligationProvenance(db, org.orgId, obligationIds.foreign, actorId, REASON, new Set([subA])),
      isUniformNotFound,
      "out-of-scope must refuse exactly like a missing obligation",
    );
    assert.equal(await reconciledAt(org.orgId, obligationIds.foreign), null);
  } finally {
    await db.execute(sql`delete from upgrade_legacy_provenance where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("the same attester reconciles their own entity's obligation", { skip: !DB }, async () => {
  const { org, actorId, subA, obligationIds } = await scopedFixture();
  try {
    await reconcileLegacyObligationProvenance(db, org.orgId, obligationIds.own, actorId, REASON, new Set([subA]));
    assert.ok(await reconciledAt(org.orgId, obligationIds.own));
  } finally {
    await db.execute(sql`delete from upgrade_legacy_provenance where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("an unrestricted attester reconciles any entity's obligation", { skip: !DB }, async () => {
  const { org, actorId, obligationIds } = await scopedFixture();
  try {
    await reconcileLegacyObligationProvenance(db, org.orgId, obligationIds.foreignOpen, actorId, REASON, null);
    assert.ok(await reconciledAt(org.orgId, obligationIds.foreignOpen));
  } finally {
    await db.execute(sql`delete from upgrade_legacy_provenance where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("a missing obligation answers exactly like an out-of-scope one", { skip: !DB }, async () => {
  const { org, actorId, subA } = await scopedFixture();
  try {
    await assert.rejects(
      reconcileLegacyObligationProvenance(db, org.orgId, randomUUID(), actorId, REASON, new Set([subA])),
      isUniformNotFound,
      "missing must refuse with the same not-found shape, never a bare error",
    );
  } finally {
    await db.execute(sql`delete from upgrade_legacy_provenance where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../test-fixtures.ts";
import {
  AllocationRunError,
  previewAllocationRun,
} from "./period-run.ts";
import { postProjectGlEntry } from "../project-recognition.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// ---------------------------------------------------------------------------
// F-t06-017: preview fail-closed errors must be typed user errors (422), not
// untyped throws (500). The tester's manual-table driver had no addable
// values (F-t06-016), so the vector resolved empty and the preview died with
// a plain Error that the route could only 500 — and the UI swallowed.
// ---------------------------------------------------------------------------

async function seedManualDriver(orgId: string, dimension = "department"): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into allocation_drivers (id, org_id, key, name, dimension, source_kind, config, is_active, custom)
    values (${id}, ${orgId}, ${`drv-${id.slice(0, 8)}`}, 'Empty manual driver',
            ${dimension}, 'manual', '{}'::jsonb, true, '{}'::jsonb)`);
  return id;
}

async function seedDriverRule(org: ScratchOrg, driverId: string): Promise<string> {
  const ruleId = randomUUID();
  const versionId = randomUUID();
  await db.execute(sql`
    insert into allocation_rules (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
    values (${ruleId}, ${org.orgId}, ${`alloc-${ruleId.slice(0, 8)}`}, 'Empty driver rule', 'period', 100, true, false, '{}'::jsonb)`);
  await db.execute(sql`
    insert into allocation_rule_versions
      (id, org_id, rule_id, version_no, status, effective_from, effective_to,
       book_scope, book_ids, account_scope, dimension_filters, source_measure,
       basis_kind, driver_id, driver_as_of, basis_config,
       target_kind, dynamic_target, impact, residual_policy, solve_method,
       run_policy, run_offset_days, memo_template, published_at)
    values (${versionId}, ${org.orgId}, ${ruleId}, 1, 'draft', '2026-01-01', null,
       'primary', '[]'::jsonb,
       ${JSON.stringify({ kind: "accounts", accountIds: [org.accounts.adjustment] })}::jsonb,
       '{}'::jsonb, 'period_activity',
       'driver', ${driverId}, 'period', '{}'::jsonb,
       'dynamic', ${JSON.stringify({ dimension: "department", minWeight: "0" })}::jsonb,
       'reclass', 'largest_share', 'sequential',
       'manual', 0, 'Allocation {{rule.name}} for {{period.name}}', now())`);
  await db.execute(sql`
    update allocation_rule_versions
       set status = 'published', definition_hash = ${`testhash-${versionId}`}, published_at = now()
     where id = ${versionId} and org_id = ${org.orgId}`);
  await db.execute(sql`
    update allocation_rules set current_version_id = ${versionId}
     where id = ${ruleId} and org_id = ${org.orgId}`);
  return ruleId;
}

test(
  "preview with an empty manual-driver vector fails as a typed user error, not an untyped 500",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      // Pool has postings; the manual driver has no values (F-t06-016 left it
      // unfillable), so the tester hit the empty-vector fail-closed throw.
      await postProjectGlEntry({
        orgId: org.orgId,
        actorId,
        origin: "manual",
        entryNumber: `SEED-${randomUUID()}`,
        postingDate: org.date,
        memo: "Allocation source pool",
        subsidiaryId: org.subsidiaryId,
        currency: "CAD",
        lines: [
          { accountId: org.accounts.adjustment, amount: "1000.0000" },
          { accountId: org.accounts.bank, amount: "-1000.0000" },
        ],
      });
      const driverId = await seedManualDriver(org.orgId);
      const ruleId = await seedDriverRule(org, driverId);
      await assert.rejects(
        previewAllocationRun({
          orgId: org.orgId,
          ruleId,
          periodId: org.periodId,
          bookId: org.bookId,
          actorId,
        }),
        (error: unknown) => {
          assert.ok(error instanceof AllocationRunError, `expected AllocationRunError, got ${String(error)}`);
          assert.equal(error.code, "INVALID");
          return true;
        },
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "preview of an unknown rule fails as NOT_FOUND, not an untyped 500",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await assert.rejects(
        previewAllocationRun({
          orgId: org.orgId,
          ruleId: randomUUID(),
          periodId: org.periodId,
          bookId: org.bookId,
          actorId,
        }),
        (error: unknown) => {
          assert.ok(error instanceof AllocationRunError, `expected AllocationRunError, got ${String(error)}`);
          assert.equal(error.code, "NOT_FOUND");
          return true;
        },
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

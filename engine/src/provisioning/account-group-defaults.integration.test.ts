import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { DEFAULT_BURDEN_GROUPS, DEFAULT_COST_POOL_GROUPS } from "@openbooks/schema";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";
import { ensureAccountGroupDefaults } from "./account-group-defaults.ts";
import { provisionOrganizationDefaults } from "./organization-provisioning.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const EXPECTED_COST_POOL_KEYS = ["direct_cost", "direct_labor", "overhead", "g_and_a", "other"];
const EXPECTED_BURDEN_KEYS = [
  "facilities",
  "admin_wages",
  "insurance",
  "it_software",
  "fleet_equipment",
  "professional",
  "people_safety",
  "financial",
];

type StoredGroup = {
  dimension: string;
  key: string;
  name: string;
  color: string | null;
  sort_order: number;
  match: unknown;
  is_catch_all: boolean;
  is_active: boolean;
};

async function storedGroups(orgId: string): Promise<StoredGroup[]> {
  return (await db.execute<StoredGroup>(sql`
    select dimension, key, name, color, sort_order, match, is_catch_all, is_active
      from account_groups
     where org_id = ${orgId} and dimension in ('cost_pool', 'burden')
     order by dimension, sort_order
  `)).rows;
}

function keysOf(rows: StoredGroup[], dimension: string): string[] {
  return rows.filter((row) => row.dimension === dimension).map((row) => row.key);
}

test("ensure seeds every tenant with the default cost_pool and burden groups", { skip: !DB }, async () => {
  const first = await createScratchOrg();
  const second = await createScratchOrg();
  try {
    await ensureAccountGroupDefaults(first.orgId);
    await ensureAccountGroupDefaults(second.orgId);
    // Per-tenant counts: the old hand-run seeder covered the oldest org
    // only, so the regression asserts both tenants independently.
    for (const orgId of [first.orgId, second.orgId]) {
      const rows = await storedGroups(orgId);
      assert.deepEqual(keysOf(rows, "cost_pool"), EXPECTED_COST_POOL_KEYS, `cost_pool keys for ${orgId}`);
      assert.deepEqual(keysOf(rows, "burden"), EXPECTED_BURDEN_KEYS, `burden keys for ${orgId}`);
      assert.ok(rows.every((row) => row.is_active), "seeded groups start active");
      const directLabor = rows.find((row) => row.key === "direct_labor")!;
      assert.deepEqual(
        directLabor.match,
        DEFAULT_COST_POOL_GROUPS.find((group) => group.key === "direct_labor")!.match,
      );
    }
  } finally {
    await dropScratchOrgReporting(first.orgId);
    await dropScratchOrgReporting(second.orgId);
  }
});

test("re-running ensure preserves operator edits and deactivations, and fills only gaps", { skip: !DB }, async () => {
  const edited = await createScratchOrg();
  const control = await createScratchOrg();
  try {
    await ensureAccountGroupDefaults(edited.orgId);
    await ensureAccountGroupDefaults(control.orgId);

    // An operator customizes the direct_labor rule and deactivates it, and
    // deactivates one burden category — the same edits the Setup API allows.
    await db.execute(sql`
      update account_groups
         set match = '{"namePattern": "operator-custom-rule"}'::jsonb, is_active = false
       where org_id = ${edited.orgId} and dimension = 'cost_pool' and key = 'direct_labor'
    `);
    await db.execute(sql`
      update account_groups set is_active = false
       where org_id = ${edited.orgId} and dimension = 'burden' and key = 'insurance'
    `);
    // ...while another default is entirely absent (a partially seeded org).
    await db.execute(sql`
      delete from account_groups
       where org_id = ${edited.orgId} and dimension = 'cost_pool' and key = 'overhead'
    `);

    await ensureAccountGroupDefaults(edited.orgId);
    await ensureAccountGroupDefaults(control.orgId);

    const rows = await storedGroups(edited.orgId);
    assert.deepEqual(keysOf(rows, "cost_pool"), EXPECTED_COST_POOL_KEYS);
    assert.deepEqual(keysOf(rows, "burden"), EXPECTED_BURDEN_KEYS);
    const directLabor = rows.find((row) => row.key === "direct_labor")!;
    assert.deepEqual(directLabor.match, { namePattern: "operator-custom-rule" });
    assert.equal(directLabor.is_active, false, "a deactivated default stays deactivated");
    const insurance = rows.find((row) => row.key === "insurance")!;
    assert.equal(insurance.is_active, false, "a deactivated burden category stays deactivated");
    assert.deepEqual(
      insurance.match,
      DEFAULT_BURDEN_GROUPS.find((group) => group.key === "insurance")!.match,
      "deactivation preserves the rule for a future reactivation",
    );
    const overhead = rows.find((row) => row.key === "overhead")!;
    assert.equal(overhead.is_active, true);
    assert.deepEqual(
      overhead.match,
      DEFAULT_COST_POOL_GROUPS.find((group) => group.key === "overhead")!.match,
      "a genuinely missing default is inserted",
    );

    const controlRows = await storedGroups(control.orgId);
    assert.equal(controlRows.length, 13, "the untouched tenant is unchanged by a second run");
    assert.ok(controlRows.every((row) => row.is_active));
  } finally {
    await dropScratchOrgReporting(edited.orgId);
    await dropScratchOrgReporting(control.orgId);
  }
});

test("a newly provisioned org has the default cost_pool and burden groups", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await provisionOrganizationDefaults(org.orgId);
    const rows = await storedGroups(org.orgId);
    assert.deepEqual(keysOf(rows, "cost_pool"), EXPECTED_COST_POOL_KEYS);
    assert.deepEqual(keysOf(rows, "burden"), EXPECTED_BURDEN_KEYS);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

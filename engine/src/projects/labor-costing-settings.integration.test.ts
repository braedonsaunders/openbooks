import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { laborCostingSettings } from "./labor-costing.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

// Regression for B-PRJ-09 (read half): laborCostingSettings cast the stored
// settings jsonb components with NO revalidation, so legacy, imported, or
// directly-edited garbage bypassed the strict route parser and reached
// computeCostRate's catch-and-continue, which dropped the burden and
// undercost every affected entry. Stored settings now revalidate through
// the same strict parser and refuse by name.
async function writeSettings(orgId: string, laborCosting: unknown): Promise<void> {
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('laborCosting', ${JSON.stringify(laborCosting)}::jsonb)
     where id = ${orgId}`);
}

test("stored garbage components refuse by name instead of pricing without the burden", async () => {
  const org = await createScratchOrg();
  try {
    await writeSettings(org.orgId, {
      mode: "post",
      hoursPerDay: 8,
      annualHours: 2080,
      components: [{ key: "b", name: "Statutory Burden", kind: "per_hour", value: "bogus" }],
    });
    await assert.rejects(laborCostingSettings(org.orgId), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /component 1/);
      assert.match(error.message, /at most 4 decimals/);
      return true;
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stored unknown component kind refuses by name", async () => {
  const org = await createScratchOrg();
  try {
    await writeSettings(org.orgId, {
      mode: "post",
      hoursPerDay: 8,
      annualHours: 2080,
      components: [{ kind: "annual_bonus", value: 5 }],
    });
    await assert.rejects(laborCostingSettings(org.orgId), /component 1: unknown kind/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stored out-of-range workday refuses by name instead of mispricing overtime", async () => {
  const org = await createScratchOrg();
  try {
    await writeSettings(org.orgId, {
      mode: "post",
      hoursPerDay: "lots",
      annualHours: 2080,
      components: [],
    });
    await assert.rejects(laborCostingSettings(org.orgId), /hoursPerDay must be a number between 0 and 24/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("valid stored settings still resolve, with defaults for absent fields", async () => {
  const org = await createScratchOrg();
  try {
    await writeSettings(org.orgId, {
      mode: "post",
      hoursPerDay: "8.5000",
      annualHours: 2000,
      components: [{ key: "burden", name: "Burden", kind: "percent_of_wage", value: "13" }],
    });
    const settings = await laborCostingSettings(org.orgId);
    assert.equal(settings.mode, "post");
    assert.equal(settings.hoursPerDay, 8.5);
    assert.equal(settings.annualHours, 2000);
    assert.equal(settings.components.length, 1);

    await writeSettings(org.orgId, {});
    const defaults = await laborCostingSettings(org.orgId);
    assert.equal(defaults.mode, "off");
    assert.equal(defaults.hoursPerDay, 8);
    assert.equal(defaults.annualHours, 2080);
    assert.deepEqual(defaults.components, []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { installTaxReturnPacks } from "./seed-tax-forms.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// A state-return install maps only jurisdiction-matched codes, so a
// hand-made US code with no jurisdiction never landed in any box — and the
// install reported counts without naming the excluded codes, leaving the
// filed state return to understate silently. The install now names every
// excluded code with a reason and a remedy.
test("a state install names an unjurisdictioned same-country code with its remedy", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(() => db.execute(sql`
      insert into tax_codes (id, org_id, code, name, country, applies_to, is_active)
      values (${randomUUID()}, ${org.orgId}, 'US-HANDMADE', 'Hand-made US code', 'US', 'both', true)`));
    const [installed] = await withBypassContext(() => installTaxReturnPacks(org.orgId, ["US_NY_ST100"]));
    assert.ok(installed);
    const excluded = installed.excludedCodes.find((row) => row.code === "US-HANDMADE");
    assert.ok(excluded, `expected US-HANDMADE to be named, got ${JSON.stringify(installed.excludedCodes)}`);
    assert.match(excluded.reason, /no jurisdiction assigned/);
    assert.match(excluded.remedy, /US-NY/);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

// A code scoped to another state is excluded for a reason, not by accident:
// it belongs to that jurisdiction's return.
test("a state install names a foreign-state code as another return's scope", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const caId = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into tax_jurisdictions (id, org_id, code, name, country, region, level, tax_type)
      values (${caId}, ${org.orgId}, 'US-CA', 'California', 'US', 'CA', 'state', 'sales_use')`));
    await withBypassContext(() => db.execute(sql`
      insert into tax_codes (id, org_id, code, name, country, region, jurisdiction_id, applies_to, is_active)
      values (${randomUUID()}, ${org.orgId}, 'US-CA-ST', 'California code', 'US', 'CA', ${caId}, 'both', true)`));
    const [installed] = await withBypassContext(() => installTaxReturnPacks(org.orgId, ["US_NY_ST100"]));
    assert.ok(installed);
    const excluded = installed.excludedCodes.find((row) => row.code === "US-CA-ST");
    assert.ok(excluded, `expected US-CA-ST to be named, got ${JSON.stringify(installed.excludedCodes)}`);
    assert.match(excluded.reason, /US-CA/);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

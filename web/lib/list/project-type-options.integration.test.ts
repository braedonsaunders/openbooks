import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// F-t11-003: the projects list rendered a custom type's key ("t11 tm
// verify") instead of its name ("T11 T&M Verify") because the billing
// filter only knew the three static built-ins. The filter now loads tenant
// types (key as value, name as label) so cells and the dropdown resolve
// them; built-ins keep their static translated options. Needs a fixture
// database.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { installTrustedTestDatabaseBypass } = await import("@openbooks/engine/src/testing/database-bypass.ts");
const { BUILTIN_PROJECT_TYPES } = await import("@openbooks/schema");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { entityListSource } = await import("./entity-sources.ts");

installTrustedTestDatabaseBypass();

const DB = !!process.env.OPENBOOKS_DB_URL;

test("the billing filter loads custom type names", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const billing = entityListSource("project")?.quickFilters?.find((filter) => filter.filterKey === "project_type");
    assert.ok(billing?.loadOptions, "the billing filter carries a tenant type loader");
    const builtinTm = BUILTIN_PROJECT_TYPES.find((type) => type.key === "time_and_materials")!;
    await db.execute(sql`
      insert into project_types (id, org_id, key, name, billing_method, invoicing_profile, backup_profile)
      values (${randomUUID()}, ${org.orgId}, 't11_tm_verify', 'T11 T&M Verify', 'time_and_materials',
              ${JSON.stringify(builtinTm.invoicingProfile)}::jsonb,
              ${JSON.stringify(builtinTm.backupProfile)}::jsonb)`);
    const options = await billing.loadOptions(org.orgId, null);
    const custom = options.find((option) => option.value === "t11_tm_verify");
    assert.equal(custom?.label, "T11 T&M Verify", "the custom key resolves to its name");
    const values = options.map((option) => option.value);
    assert.equal(new Set(values).size, values.length, "loader values stay unique for the merge");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { prepareAllSampleCompanyTemplates } from "../sample-companies/service.ts";
import { SAMPLE_COMPANY_PROFILES } from "../sample-companies/catalog.ts";
import { deleteSandbox, createSandbox } from "./lifecycle.ts";
import { assertUuid, loadCatalog, PARENT_FILTER } from "./catalog.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function countRows(table: { name: string; hasOrgId: boolean }, orgId: string): Promise<number> {
  const where = table.hasOrgId
    ? sql`org_id = ${orgId}`
    : sql.raw(PARENT_FILTER[table.name]!(assertUuid(orgId)));
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from ${sql.identifier(table.name)} where ${where}
  `)).rows[0]!.n;
}

test("every simulator-provisioned sample company template clones with matching table counts", { skip: !DB }, async () => {
  // This registry-driven path provisions the same complete SIM data used to
  // prepare product sample templates, rather than hand-seeding a narrow shape.
  const templates = await prepareAllSampleCompanyTemplates();
  assert.deepEqual(
    templates.map((template) => template.industryKey).sort(),
    SAMPLE_COMPANY_PROFILES.map((profile) => profile.industryKey).sort(),
  );
  // Ordinary active-level creation must still open its normal activation
  // period; only runClone's controlled replay suppresses this trigger side
  // effect so it can copy the exact source history below.
  const ordinaryLevelId = randomUUID();
  await db.execute(sql`
    insert into price_levels (id, org_id, code, name)
    values (${ordinaryLevelId}, ${templates[0]!.templateOrgId}, ${`CLONE-REGRESSION-${ordinaryLevelId}`}, 'Clone regression level')
  `);
  const ordinaryHistory = (await db.execute<{ n: number; openedAt: string | null }>(sql`
    select count(*)::int as n, max(opened_at)::text as "openedAt"
      from price_level_activation_history
     where org_id = ${templates[0]!.templateOrgId} and price_level_id = ${ordinaryLevelId}
  `)).rows[0]!;
  assert.equal(ordinaryHistory.n, 1, "ordinary active-level creation opens one history period");
  assert.ok(ordinaryHistory.openedAt, "ordinary active-level history retains its opening instant");
  const catalog = await loadCatalog();
  assert.ok(catalog.tables.length > 0, "sandbox catalog must contain tables to verify");
  const created: string[] = [];
  try {
    for (const template of templates) {
      const sandbox = await createSandbox({
        productionOrgId: template.templateOrgId,
        name: `Clone coverage ${template.profileId}`,
        tier: "full",
        masked: false,
      });
      created.push(sandbox.sandboxId);
      for (const table of catalog.tables) {
        const [sourceRows, cloneRows] = await Promise.all([
          countRows(table, template.templateOrgId),
          countRows(table, sandbox.sandboxOrgId),
        ]);
        assert.equal(
          cloneRows,
          sourceRows,
          `${template.profileId}: ${table.name} row count must match after clone`,
        );
      }
    }
  } finally {
    const cleanupFailures: string[] = [];
    for (const sandboxId of created.reverse()) {
      try {
        await deleteSandbox(sandboxId);
      } catch (error) {
        cleanupFailures.push(`${sandboxId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Failed createSandbox attempts can leave a shell registered before the
    // clone transaction starts. Remove every shell for each generated source.
    for (const template of templates) {
      const shells = (await db.execute<{ id: string }>(sql`
        select id from sandboxes where production_org_id = ${template.templateOrgId}
      `)).rows;
      for (const shell of shells) {
        try {
          await deleteSandbox(shell.id);
        } catch (error) {
          cleanupFailures.push(`${shell.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    assert.deepEqual(cleanupFailures, [], `sandbox cleanup must complete: ${cleanupFailures.join("; ")}`);
  }
});

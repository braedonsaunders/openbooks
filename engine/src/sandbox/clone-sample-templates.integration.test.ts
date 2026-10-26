import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { prepareIndustryDemo } from "../sample-companies/service.ts";
import { SAMPLE_COMPANY_PROFILES } from "../sample-companies/catalog.ts";
import { deleteSandbox, createSandbox } from "./lifecycle.ts";
import { assertUuid, loadCatalog, PARENT_FILTER } from "./catalog.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function countRows(
  table: { name: string; hasOrgId: boolean },
  orgId: string,
): Promise<number> {
  const where = table.hasOrgId
    ? sql`org_id = ${orgId}`
    : sql.raw(PARENT_FILTER[table.name]!(assertUuid(orgId)));
  return (
    await db.execute<{ n: number }>(
      sql`
    select count(*)::int as n from ${sql.identifier(table.name)} where ${where}
  `,
      "objects",
    )
  )[0]!.n;
}

for (const profile of SAMPLE_COMPANY_PROFILES) {
  let prepared: Awaited<ReturnType<typeof prepareIndustryDemo>> | undefined;
  test(
    `${profile.industryKey} simulator template prepares verified native scenarios`,
    { skip: !DB },
    async () => {
      prepared = await prepareIndustryDemo(profile.industryKey);
      assert.equal(prepared.industryKey, profile.industryKey);
      assert.equal(prepared.profileId, profile.profileId);
    },
  );

  test(
    `${profile.industryKey} simulator template clones with matching table counts`,
    { skip: !DB },
    async () => {
      assert.ok(
        prepared,
        "the industry's native template preparation must complete before cloning",
      );
      const templates = [prepared];
      // Ordinary active-level creation must still open its normal activation
      // period; only runClone's controlled replay suppresses this trigger side
      // effect so it can copy the exact source history below.
      const ordinaryLevelId = randomUUID();
      await db.execute(sql`
      insert into price_levels (id, org_id, code, name)
      values (${ordinaryLevelId}, ${templates[0]!.templateOrgId}, ${`CLONE-REGRESSION-${ordinaryLevelId}`}, 'Clone regression level')
    `);
      const ordinaryHistory = (
        await db.execute<{ n: number; openedAt: string | null }>(
          sql`
      select count(*)::int as n, max(opened_at)::text as "openedAt"
        from price_level_activation_history
       where org_id = ${templates[0]!.templateOrgId} and price_level_id = ${ordinaryLevelId}
    `,
          "objects",
        )
      )[0]!;
      assert.equal(ordinaryHistory.n, 1, "ordinary active-level creation opens one history period");
      assert.ok(
        ordinaryHistory.openedAt,
        "ordinary active-level history retains its opening instant",
      );
      const catalog = await loadCatalog();
      assert.ok(catalog.tables.length > 0, "sandbox catalog must contain tables to verify");
      const created: string[] = [];
      let failure: unknown;
      try {
        for (const template of templates) {
          // Templates are not production organizations: only sample provisioning
          // clones them, through the sanctioned template-source authority.
          const sandbox = await createSandbox({
            productionOrgId: template.templateOrgId,
            name: `Clone coverage ${template.profileId}`,
            tier: "full",
            masked: false,
            createdBy: null,
            lifecycleAuthority: { systemReason: "sample company template provisioning" },
            allowTemplateSource: true,
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
      } catch (error) {
        failure = error;
      } finally {
        const cleanupFailures: string[] = [];
        const describe = (error: unknown): string => {
          if (!(error instanceof Error)) return String(error);
          return error.cause instanceof Error
            ? `${error.message} (${error.cause.message})`
            : error.message;
        };
        for (const sandboxId of created.reverse()) {
          try {
            await deleteSandbox(sandboxId);
          } catch (error) {
            cleanupFailures.push(`${sandboxId}: ${describe(error)}`);
          }
        }
        // Failed createSandbox attempts can leave a shell registered before the
        // clone transaction starts. Remove every shell for each generated source.
        for (const template of templates) {
          const shells = await db.execute<{ id: string }>(
            sql`
          select id from sandboxes where production_org_id = ${template.templateOrgId}
        `,
            "objects",
          );
          for (const shell of shells) {
            try {
              await deleteSandbox(shell.id);
            } catch (error) {
              cleanupFailures.push(`${shell.id}: ${describe(error)}`);
            }
          }
        }
        // A clone failure is the finding; cleanup trouble is reported beside it, never instead of it.
        if (failure !== undefined) {
          if (cleanupFailures.length)
            throw new AggregateError(
              [failure, new Error(cleanupFailures.join("; "))],
              `clone coverage failed: ${describe(failure)}`,
            );
          throw failure;
        }
        assert.deepEqual(
          cleanupFailures,
          [],
          `sandbox cleanup must complete: ${cleanupFailures.join("; ")}`,
        );
      }
    },
  );
}

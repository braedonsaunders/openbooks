import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "a full clone copies temporary differences of draft and discarded provision runs",
  { skip: !DB, timeout: 300_000 },
  async () => {
    const org = await createScratchOrg();
    let sandboxId: string | null = null;
    try {
      const runs = await db.execute<{ id: string; status: string }>(
        sql`
          insert into tax_provision_runs
            (org_id, fiscal_year, period_from, period_to, status, version, snapshot_hash, payload)
          values
            (${org.orgId}, 2025, '2025-01-01', '2025-12-31', 'draft', 1, 'discarded-run', '{}'::jsonb),
            (${org.orgId}, 2026, '2026-01-01', '2026-12-31', 'draft', 1, 'draft-run', '{}'::jsonb)
          returning id, status`,
        "objects",
      );
      for (const run of runs) {
        await db.execute(sql`
          insert into temporary_differences
            (org_id, run_id, category, description, difference, rate_percent, tax_effect)
          values (${org.orgId}, ${run.id}, 'fixed_assets', 'Accelerated depreciation', 1000, 26.5, 265)`);
      }
      // Finalizing the first run freezes its differences.
      await db.execute(sql`
        update tax_provision_runs set status = 'discarded'
         where org_id = ${org.orgId} and snapshot_hash = 'discarded-run'`);

      const created = await createSandbox({
        productionOrgId: org.orgId,
        name: `Provision clone ${org.orgId.slice(0, 8)}`,
        tier: "full",
        masked: false,
      });
      sandboxId = created.sandboxId;

      const copied = await db.execute<{ status: string; differences: number }>(
        sql`
          select r.status, count(d.*)::int as differences
            from tax_provision_runs r
            left join temporary_differences d on d.run_id = r.id and d.org_id = r.org_id
           where r.org_id = ${created.sandboxOrgId}
           group by r.status order by r.status`,
        "objects",
      );
      assert.deepEqual(copied, [
        { status: "discarded", differences: 1 },
        { status: "draft", differences: 1 },
      ]);

      // Outside the clone, a finalized run's differences stay immutable.
      await assert.rejects(
        db.execute(sql`
          insert into temporary_differences
            (org_id, run_id, category, description, difference, rate_percent, tax_effect)
          select org_id, id, 'other', 'Late difference', 1, 26.5, 0.27
            from tax_provision_runs
           where org_id = ${created.sandboxOrgId} and status = 'discarded'`),
        (error: unknown) =>
          /immutable after provision finalization/.test(
            String((error as { cause?: unknown }).cause ?? error),
          ),
      );
    } finally {
      if (sandboxId) await deleteSandbox(sandboxId);
      await dropScratchOrg(org.orgId);
    }
  },
);

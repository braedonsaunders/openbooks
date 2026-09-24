import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES, type FinancialProfile } from "@openbooks/schema";
import { recordProjectOverheadAdjustment } from "./overhead-adjustments.ts";
import { resolveProjectFinancials } from "./financials.ts";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const timeAndMaterials = BUILTIN_PROJECT_TYPES.find((entry) =>
  entry.key === "time_and_materials",
)!.financialProfile;
const profileWithZeroCalculatedOverhead: FinancialProfile = {
  ...timeAndMaterials,
  overhead: { method: "per_labor_hour", ratePerHour: "0.0000" },
};

test(
  "a recorded overhead adjustment appears in the project financial result with audit evidence",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Overhead Adjustment Operator", "admin"),
      );
      const projectId = randomUUID();
      await withBypass(() => db.execute(sql`
        insert into projects
          (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values
          (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-OH-ADJ',
           'Overhead adjustment job', ${org.customerId}, 'active', true, '{}'::jsonb)
      `));

      const adjustment = await withOrgContext(org.orgId, () =>
        recordProjectOverheadAdjustment({
          orgId: org.orgId,
          projectId,
          adjustmentDate: org.date,
          amount: "65.4321",
          reason: "approved allocation correction",
          sourceSystem: "overhead-import",
          sourceRef: "period-2026-09-project-1",
          evidence: { approval: "OH-2026-09-17" },
          actorId,
        }),
      );
      assert.equal(adjustment.amount, "65.4321");
      assert.equal(adjustment.existing, false);

      const report = await withOrgContext(org.orgId, () =>
        resolveProjectFinancials(org.orgId, projectId, profileWithZeroCalculatedOverhead),
      );
      assert.equal(report.measures.calculated_overhead, "0.0000");
      assert.equal(report.measures.overhead_adjustment, "65.4321");
      assert.equal(report.measures.overhead, "65.4321");

      const audit = await withOrgContext(org.orgId, async () =>
        (await db.execute<{
          row_id: string;
          actor_id: string | null;
          amount: string | null;
          source_ref: string | null;
        }>(sql`
          select a.row_id, a.actor_id,
                 a.changes #>> '{after,amount}' as amount,
                 a.changes #>> '{after,sourceRef}' as source_ref
            from audit_log a
           where a.org_id = ${org.orgId}
             and a.table_name = 'project_overhead_adjustments'
             and a.row_id = ${adjustment.id}
        `)).rows[0],
      );
      assert.deepEqual(audit, {
        row_id: adjustment.id,
        actor_id: actorId,
        amount: "65.4321",
        source_ref: "period-2026-09-project-1",
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

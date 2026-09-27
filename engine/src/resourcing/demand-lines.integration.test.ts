import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql, type SQL } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { ResourcingRefusal } from "./errors.ts";
import { createDemandLine, deleteDemandLine, updateDemandLine } from "./demand-lines.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

test("demand lines validate, audit each write, and refuse feature-off and missing-row writes", enabled, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Demand planner", "admin"));
    const departmentId = randomUUID();
    const context = { orgId: org.orgId, actorId, allowedSubsidiaryIds: null };
    const draft = {
      ...context, departmentId, jobTitle: "Consultant", firstWeek: "2026-10-04", lastWeek: "2026-10-11",
      hoursPerWeek: "12.5000", note: "quarterly staffing", opportunityId: null,
    };
    const wrote = async (query: SQL) => {
      const result = await db.execute(query);
      assert.equal(result.rowCount, 1);
    };
    await withBypassContext(async () => {
      await wrote(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":true}'::jsonb) where id = ${org.orgId} returning id`);
      await wrote(sql`insert into departments (id, org_id, subsidiary_id, name, is_active) values (${departmentId}, ${org.orgId}, ${org.subsidiaryId}, 'Delivery', true) returning id`);
    });
    const created = await createDemandLine(draft);
    const updated = await updateDemandLine({ ...draft, demandLineId: created.id, jobTitle: "Senior consultant" });
    assert.equal(updated.jobTitle, "Senior consultant");
    await assert.rejects(
      updateDemandLine({ ...draft, demandLineId: randomUUID() }),
      (error: unknown) => error instanceof ScopeNotFoundError,
    );
    const invalid = [
      [{ firstWeek: "2026-10-05" }, "invalid_week_range"],
      [{ firstWeek: "2026-10-18", lastWeek: "2026-10-11" }, "invalid_week_range"],
      [{ hoursPerWeek: "1,25" }, "demand_hours_invalid"],
      [{ hoursPerWeek: "168.0001" }, "demand_hours_out_of_range"],
      [{ jobTitle: "   " }, "demand_job_title_required"],
      [{ opportunityId: randomUUID() }, "demand_opportunity_unknown"],
    ] as const;
    for (const [changes, code] of invalid) {
      await assert.rejects(createDemandLine({ ...draft, ...changes }), (error: unknown) => {
        assert.ok(error instanceof ResourcingRefusal);
        assert.equal(error.status, 422);
        assert.equal(error.code, code);
        return true;
      });
    }
    await deleteDemandLine({ ...context, demandLineId: created.id });
    const actions = await withBypassContext(() => db.execute<{ action: string; count: string }>(sql`
      select action, count(*)::text as count from audit_log
       where org_id = ${org.orgId} and table_name = 'res_demand_lines' and row_id = ${created.id}
       group by action order by action
    `));
    assert.deepEqual(actions.rows, [
      { action: "delete", count: "1" }, { action: "insert", count: "1" }, { action: "update", count: "1" },
    ]);
    await withBypassContext(() => wrote(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":false}'::jsonb) where id = ${org.orgId} returning id`));
    await assert.rejects(createDemandLine(draft), (error: unknown) => {
      assert.ok(error instanceof ResourcingRefusal);
      assert.equal(error.status, 409);
      assert.equal(error.code, "resourcing_feature_disabled");
      return true;
    });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

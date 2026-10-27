import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import { createScratchOrg, dropScratchOrgReporting } from "@openbooks/engine/testing/fixtures";
import { defaultListView } from "@openbooks/customization";
import { readResolvedEntityListPageForView } from "./entity-reader";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

test(
  "a week with time on an out-of-scope project is hidden in full, and only that week",
  enabled,
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const otherSubsidiary = randomUUID();
      const employee = randomUUID();
      const visibleProject = randomUUID();
      const hiddenProject = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
          coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"timeTracking":true,"multiSubsidiary":true}'::jsonb)
          where id=${org.orgId}`);
        await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
          values (${otherSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Other entity', 'CAD', 'CA')`);
        await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
          values(${employee},${org.orgId},'employee','Scoped worker',${org.subsidiaryId},true,'{}'::jsonb)`);
        await db.execute(sql`insert into employee_roles(id,org_id,party_id,is_active)
          values(${randomUUID()},${org.orgId},${employee},true)`);
        await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
          values (${visibleProject},${org.orgId},${org.subsidiaryId},'HOME','Home job',${org.customerId},'active',true,'{}'::jsonb),
                 (${hiddenProject},${org.orgId},${otherSubsidiary},'AWAY','Away job',${org.customerId},'active',true,'{}'::jsonb)`);
        // Weeks start on Sunday: Saturday 04-11 closes the week of 04-05 and
        // Sunday 04-12 opens the next one.
        for (const [day, project] of [
          ["2026-04-06", visibleProject],
          ["2026-04-11", hiddenProject],
          ["2026-04-12", visibleProject],
        ] as const) {
          await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,project_id,worked_on,hours,status,
            is_billable,costing_basis,custom)
            values(${randomUUID()},${org.orgId},${employee},${project},${day}::date,'4.0000','draft',
            false,'actual','{}'::jsonb)`);
        }
      });
      const view = defaultListView("timesheet_week");
      const weeks = async (allowedSubsidiaryIds: Set<string> | null) => {
        const result = await withOrgContext(org.orgId, () =>
          readResolvedEntityListPageForView(
            {
              recordType: "timesheet_week",
              orgId: org.orgId,
              allowedSubsidiaryIds,
              view,
              sort: "week",
              dir: "asc",
              page: 1,
              perPage: 25,
            },
            { inventory: true, crm: false, hrm: false },
          ),
        );
        assert.ok(result.ok, JSON.stringify(result));
        return result.ok ? result.rows.map((row) => String(row.week_start)) : [];
      };

      assert.deepEqual(await weeks(null), ["2026-04-05", "2026-04-12"]);
      assert.deepEqual(
        await weeks(new Set([org.subsidiaryId])),
        ["2026-04-12"],
        "one out-of-scope entry hides its whole week and leaves the neighbouring week",
      );
      assert.deepEqual(await weeks(new Set([org.subsidiaryId, otherSubsidiary])), [
        "2026-04-05",
        "2026-04-12",
      ]);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

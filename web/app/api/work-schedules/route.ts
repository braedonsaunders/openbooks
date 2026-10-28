import { defineRoute } from "@/lib/api/route";
import { workScheduleBodySchema, writeWorkSchedule } from "@/lib/work-schedules-write";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { loadWorkSchedules } from "@openbooks/engine/payroll/work-schedules/operations";
import type { Authz } from "@/lib/authz";
import { subsidiaryVisibleFilter } from "@/lib/subsidiaries";

export const dynamic = "force-dynamic";

function scopedGate(gate: Authz): Authz {
  if (gate.allowedSubsidiaryIds === undefined) {
    return { ...gate, allowedSubsidiaryIds: new Set<string>() };
  }
  return gate;
}

export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: "payroll",
  handler: async ({ authz: gate }) => {
    const authz = scopedGate(gate);
    const scope = authz.allowedSubsidiaryIds;
    const orgId = authz.user.orgId;

    // Schedules carry the employee/subsidiary predicate in the engine loader;
    // the editor's employee picker and subsidiary options narrow the same way,
    // so a restricted caller never sees another subsidiary's workers. Trades
    // and departments are org-wide master data with no entity lineage, so
    // their options stay whole — scoping them would not hide entity data.
    const [schedules, employees, trades, departments, subsidiaries] = await Promise.all([
      loadWorkSchedules(db, orgId, scope),
      db.execute<{ id: string; name: string }>(
        sql`
        select p.id, p.display_name as name
          from employee_roles er
          join parties p on p.id = er.party_id and p.org_id = er.org_id
         where er.org_id = ${orgId}
           ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, scope)}
         order by p.display_name`,
        "objects",
      ),
      db.execute<{ id: string; name: string }>(
        sql`
        select id, name from trades where org_id = ${orgId} order by name`,
        "objects",
      ),
      db.execute<{ id: string; name: string }>(
        sql`
        select id, name from departments where org_id = ${orgId} order by name`,
        "objects",
      ),
      db.execute<{ id: string; name: string }>(
        sql`
        select id, name from subsidiaries where org_id = ${orgId}
          ${subsidiaryVisibleFilter(sql`id`, scope)}
         order by name`,
        "objects",
      ),
    ]);

    return NextResponse.json({
      schedules,
      options: {
        employees,
        trades,
        departments,
        subsidiaries,
      },
    });
  },
});

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "payroll",
  body: workScheduleBodySchema,
  invalidBodyStatus: 422,
  handler: writeWorkSchedule,
});

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

// The timesheet-week list interpolates the employee_party_id structured
// filter — and the employee quick filter — into a uuid column uncast: a
// crafted value (or a saved view holding one) dies as a raw throw and the
// whole page 500s. The builder must fail such filters closed to an empty row
// set. SQL builders and storage are real; only server-only is stubbed.
const { db } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");
const { timesheetWeekWhere } = await import("./timesheet-weeks.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

type Filter = { key: string; operator: string; value?: string | null; to?: string | null };

async function weekCount(
  orgId: string,
  viewFilters: Filter[] = [],
  adhocFilters: Record<string, string> = {},
): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from timesheet_weeks tw
      where ${timesheetWeekWhere({ ...defaultListView("timesheet_week"), filters: viewFilters as never }, { filters: adhocFilters }, orgId, null)}`,
    "objects",
  );
  return rows[0]!.n;
}

test(
  "malformed timesheet-week filters match nothing instead of throwing",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const employeeId = randomUUID();
      await db.execute(sql`insert into parties (id,org_id,kind,display_name,is_active)
      values (${employeeId},${org.orgId},'person','Timesheet filter employee',true)`);
      await db.execute(sql`insert into employee_roles(org_id,party_id,hired_on,is_active)
      values (${org.orgId},${employeeId},'2026-01-01',true)`);
      await db.execute(sql`insert into timesheet_weeks(org_id,employee_party_id,week_start,status)
      values (${org.orgId},${employeeId},'2026-07-12','draft')`);
      assert.equal(
        await weekCount(org.orgId),
        1,
        "the unfiltered register contains the native week",
      );
      assert.equal(
        await weekCount(org.orgId, [], { employee_party_id: employeeId }),
        1,
        "a valid employee filter retains the week",
      );
      assert.equal(
        await weekCount(org.orgId, [
          { key: "employee_party_id", operator: "eq", value: "not-a-uuid" },
        ]),
        0,
        "malformed employee filter matches nothing",
      );
      assert.equal(
        await weekCount(org.orgId, [], { employee_party_id: "not-a-uuid" }),
        0,
        "malformed employee quick filter matches nothing",
      );
      assert.equal(
        await weekCount(org.orgId, [
          {
            key: "employee_party_id",
            operator: "eq",
            value: "00000000-0000-4000-8000-000000000000",
          },
        ]),
        0,
        "well-formed unknown employee stays empty without throwing",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

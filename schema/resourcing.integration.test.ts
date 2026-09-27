import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../engine/src/testing/fixtures.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

function databaseError(error: unknown): { code: string | undefined; message: string } {
  const messages: string[] = [];
  let code: string | undefined;
  let current = error as { cause?: unknown; code?: unknown; message?: unknown } | null;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current.code === "string") code ??= current.code;
    if (typeof current.message === "string") messages.push(current.message);
    current = (current.cause ?? null) as typeof current;
  }
  return { code, message: messages.join("\n") };
}

async function rejectedBy(
  operation: () => Promise<unknown>,
  code: string,
  constraint: string,
): Promise<void> {
  await assert.rejects(operation(), (error: unknown) => {
    const database = databaseError(error);
    assert.equal(database.code, code, database.message);
    assert.ok(database.message.includes(constraint), database.message);
    return true;
  });
}

async function makeOrg() {
  return withBypassContext(() => createScratchOrg());
}

async function removeOrg(orgId: string): Promise<void> {
  await withBypassContext(() => dropScratchOrg(orgId));
}

async function makeProject(orgId: string, name: string, customerId: string | null = null): Promise<string> {
  return withBypassContext(async () => {
    const rows = (await db.execute<{ id: string }>(sql`
      insert into projects (org_id, name, customer_id) values (${orgId}, ${name}, ${customerId}) returning id
    `)).rows;
    return rows[0]!.id;
  });
}

async function makeParty(orgId: string, kind: "employee" | "customer", name: string): Promise<string> {
  return withBypassContext(async () => {
    const rows = (await db.execute<{ id: string }>(sql`
      insert into parties (org_id, kind, display_name) values (${orgId}, ${kind}, ${name}) returning id
    `)).rows;
    return rows[0]!.id;
  });
}

async function makeAssignment(
  orgId: string,
  projectId: string,
  values: { employeePartyId: string | null; jobTitle: string | null; weekStart?: string },
): Promise<string> {
  return withBypassContext(async () => {
    const rows = (await db.execute<{ id: string }>(sql`
      insert into res_assignments
        (org_id, project_id, employee_party_id, job_title, week_start, planned_hours)
      values
        (${orgId}, ${projectId}, ${values.employeePartyId}, ${values.jobTitle}, ${values.weekStart ?? "2026-09-20"}, 32.0000)
      returning id
    `)).rows;
    return rows[0]!.id;
  });
}

test("booking identity prevents duplicate person and case-insensitive role weeks", { skip }, async () => {
  const org = await makeOrg();
  try {
    const projectId = await makeProject(org.orgId, "Northwind Advisory Engagement");
    const employeeId = await makeParty(org.orgId, "employee", "Alex Chen");

    await makeAssignment(org.orgId, projectId, { employeePartyId: employeeId, jobTitle: null });
    await rejectedBy(
      () => makeAssignment(org.orgId, projectId, { employeePartyId: employeeId, jobTitle: null }),
      "23505",
      "res_assignments_booking_key",
    );

    await makeAssignment(org.orgId, projectId, { employeePartyId: null, jobTitle: "Financial Analyst" });
    await rejectedBy(
      () => makeAssignment(org.orgId, projectId, { employeePartyId: null, jobTitle: "financial analyst" }),
      "23505",
      "res_assignments_booking_key",
    );
  } finally {
    await removeOrg(org.orgId);
  }
});

test("booking rows require one subject and a Sunday week", { skip }, async () => {
  const org = await makeOrg();
  try {
    const projectId = await makeProject(org.orgId, "Cedar Ridge Tax Advisory");
    const employeeId = await makeParty(org.orgId, "employee", "Jordan Lee");

    await rejectedBy(
      () => makeAssignment(org.orgId, projectId, {
        employeePartyId: employeeId,
        jobTitle: "Tax Consultant",
      }),
      "23514",
      "res_assignments_subject",
    );
    await rejectedBy(
      () => makeAssignment(org.orgId, projectId, { employeePartyId: null, jobTitle: null }),
      "23514",
      "res_assignments_subject",
    );
    await rejectedBy(
      () => makeAssignment(org.orgId, projectId, {
        employeePartyId: employeeId,
        jobTitle: null,
        weekStart: "2026-09-21",
      }),
      "23514",
      "res_assignments_week_start_sunday",
    );
  } finally {
    await removeOrg(org.orgId);
  }
});

test("organization RLS hides another tenant's assignments", { skip }, async () => {
  const owner = await makeOrg();
  const reader = await makeOrg();
  try {
    const projectId = await makeProject(owner.orgId, "Summit Group Audit");
    const employeeId = await makeParty(owner.orgId, "employee", "Morgan Patel");
    const assignmentId = await makeAssignment(owner.orgId, projectId, {
      employeePartyId: employeeId,
      jobTitle: null,
    });

    const visible = await withOrgContext(reader.orgId, async () => await db.execute<{ id: string }>(sql`
      select id from res_assignments where id = ${assignmentId}
    `));
    assert.deepEqual(visible.rows, [], "a tenant can only read its own assignment rows");
  } finally {
    await removeOrg(owner.orgId);
    await removeOrg(reader.orgId);
  }
});

test("one time entry cannot support two retainer drawdowns", { skip }, async () => {
  const org = await makeOrg();
  try {
    const customerId = await makeParty(org.orgId, "customer", "Bluebird Systems");
    const projectId = await makeProject(org.orgId, "Bluebird Consulting Retainer", customerId);
    const employeeId = await makeParty(org.orgId, "employee", "Casey Morgan");
    const itemRows = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
      insert into items (org_id, kind, name)
      values (${org.orgId}, 'service', 'Advisory Services')
      returning id
    `)).rows);
    const itemId = itemRows[0]!.id;
    const retainerRows = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
      insert into res_retainers
        (org_id, project_id, customer_party_id, kind, total_amount, total_hours,
         unit_rate, starts_on, ends_on, retainer_item_id)
      values
        (${org.orgId}, ${projectId}, ${customerId}, 'hours', 1500.0000, 10.0000,
         150.0000, '2026-09-01', '2026-12-31', ${itemId})
      returning id
    `)).rows);
    const retainerId = retainerRows[0]!.id;
    const firstDrawdown = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
      insert into res_retainer_drawdowns (org_id, retainer_id, week_start, hours, amount)
      values (${org.orgId}, ${retainerId}, '2026-09-20', 1.0000, 150.0000)
      returning id
    `)).rows[0]!.id);
    const secondDrawdown = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
      insert into res_retainer_drawdowns (org_id, retainer_id, week_start, hours, amount)
      values (${org.orgId}, ${retainerId}, '2026-09-27', 1.0000, 150.0000)
      returning id
    `)).rows[0]!.id);
    const timeRows = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id)
      values (${org.orgId}, ${employeeId}, '2026-09-23', 1.0000, ${projectId})
      returning id
    `)).rows);
    const timeEntryId = timeRows[0]!.id;

    await withBypassContext(async () => await db.execute(sql`
      insert into res_retainer_drawdown_entries (org_id, drawdown_id, time_entry_id)
      values (${org.orgId}, ${firstDrawdown}, ${timeEntryId})
    `));
    await rejectedBy(
      () => withBypassContext(async () => await db.execute(sql`
        insert into res_retainer_drawdown_entries (org_id, drawdown_id, time_entry_id)
        values (${org.orgId}, ${secondDrawdown}, ${timeEntryId})
      `)),
      "23505",
      "res_retainer_drawdown_entries_time_entry",
    );
  } finally {
    await removeOrg(org.orgId);
  }
});

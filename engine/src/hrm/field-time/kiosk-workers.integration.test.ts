/**
 * HR-20 kiosk worker list (DB-owned — gated remotely).
 *
 * The terminal's worker picker must offer active employees only — never
 * customers or vendors — and must not silently truncate: the terminal
 * searches the list client-side, so a cap hides workers past it. The
 * service boundary enforces the same rule: identifyByPin and setWorkerPin
 * refuse non-employees with not_employee, so a PIN row alone never makes
 * someone a worker.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../../testing/fixtures.ts";
import { identifyByPin, listKioskWorkers, registerKiosk, revokeKiosk, setWorkerPin } from "./kiosk.ts";
import { FieldTimeError } from "./errors.ts";
import { ScopeNotFoundError, UnrestrictedScopeError } from "../../organization/subsidiary-scope.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableFieldTime(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
      || '{"projects": true, "timeTracking": true, "fieldTime": true, "fieldTimeKiosk": true}'::jsonb)
     where id = ${orgId}`);
}

function refusesCode(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => { throw new Error("expected a refusal"); },
    (error) => {
      assert.ok(error instanceof FieldTimeError, `refusal is a FieldTimeError, got ${String(error)}`);
      return (error as FieldTimeError).code;
    },
  );
}

test("the terminal lists active employees only, with no silent cap", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    // 505 active employees: past the old limit-500 cap, so a truncation
    // would drop the last five and fail the count below.
    const COUNT = 505;
    const employeeIds = Array.from({ length: COUNT }, () => randomUUID());
    const customer = randomUUID();
    const vendor = randomUUID();
    const terminated = randomUUID();
    const inactiveEmployee = randomUUID();
    await withOrg(org.orgId, async () => {
      const partyValues = [
        ...employeeIds.map((id, index) => sql`(${id}, ${org.orgId}, 'person', ${`Worker ${String(index).padStart(4, "0")}`}, true)`),
        sql`(${customer}, ${org.orgId}, 'customer', 'Acme Customer', true)`,
        sql`(${vendor}, ${org.orgId}, 'vendor', 'Supply Vendor', true)`,
        sql`(${terminated}, ${org.orgId}, 'person', 'Gone Worker', true)`,
        sql`(${inactiveEmployee}, ${org.orgId}, 'person', 'Dormant Worker', false)`,
      ];
      for (let at = 0; at < partyValues.length; at += 100) {
        await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active) values ${sql.join(partyValues.slice(at, at + 100), sql`, `)}`);
      }
      // Employment ids are tracked alongside their parties — versions join
      // below by the same handle, never by read-back order.
      const employments: { id: string }[] = employeeIds.map(() => ({ id: randomUUID() }));
      const terminatedEmployment = randomUUID();
      const inactiveEmployment = randomUUID();
      const employmentRows = [
        ...employeeIds.map((id, index) => sql`(${employments[index]!.id}, ${org.orgId}, ${id}, ${org.subsidiaryId}, 1)`),
        sql`(${terminatedEmployment}, ${org.orgId}, ${terminated}, ${org.subsidiaryId}, 1)`,
        sql`(${inactiveEmployment}, ${org.orgId}, ${inactiveEmployee}, ${org.subsidiaryId}, 1)`,
      ];
      for (let at = 0; at < employmentRows.length; at += 100) {
        await db.execute(sql`insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision) values ${sql.join(employmentRows.slice(at, at + 100), sql`, `)}`);
      }
      const versionRows = [
        ...employments.map((employment) => sql`(${org.orgId}, ${employment.id}, 1, 'active', '2020-01-01'::date, null, now())`),
        sql`(${org.orgId}, ${terminatedEmployment}, 1, 'terminated', '2020-01-01'::date, null, now())`,
        sql`(${org.orgId}, ${inactiveEmployment}, 1, 'active', '2020-01-01'::date, null, now())`,
      ];
      for (let at = 0; at < versionRows.length; at += 100) {
        await db.execute(sql`insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at) values ${sql.join(versionRows.slice(at, at + 100), sql`, `)}`);
      }
    });
    const workers = await listKioskWorkers(org.orgId);
    assert.equal(workers.length, COUNT, `expected all ${COUNT} active employees, no cap`);
    const names = new Set(workers.map((worker) => worker.name));
    assert.ok(!names.has("Acme Customer"), "customers must not appear");
    assert.ok(!names.has("Supply Vendor"), "vendors must not appear");
    assert.ok(!names.has("Gone Worker"), "terminated employments must not appear");
    assert.ok(!names.has("Dormant Worker"), "inactive parties must not appear");
    const sorted = [...workers.map((worker) => worker.name)].sort();
    assert.deepEqual(workers.map((worker) => worker.name), sorted, "workers arrive name-ordered for the terminal");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("kiosk PIN identify and PIN set refuse non-employees", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const customer = randomUUID();
    const { kiosk } = await withOrg(org.orgId, async () => {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${customer}, ${org.orgId}, 'customer', 'Acme Customer')`);
      return registerKiosk({ orgId: org.orgId, actorUserId: randomUUID(), name: "Gate", allowedSubsidiaryIds: null });
    });
    assert.equal(
      await refusesCode(() => identifyByPin({ kiosk, employeePartyId: customer, pin: "0000" })),
      "not_employee",
    );
    assert.equal(
      await refusesCode(() => withOrg(org.orgId, () =>
        setWorkerPin({ orgId: org.orgId, actorUserId: randomUUID(), employeePartyId: customer, pin: "4821", allowedSubsidiaryIds: null }))),
      "not_employee",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("kiosk-wide actions refuse restricted scope and PIN resets require every active employer in scope", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const worker = randomUUID();
    const employmentId = randomUUID();
    await withOrg(org.orgId, async () => {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${worker}, ${org.orgId}, 'person', 'Scoped Worker')`);
      await db.execute(sql`insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision) values (${employmentId}, ${org.orgId}, ${worker}, ${org.subsidiaryId}, 1)`);
      await db.execute(sql`insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at) values (${org.orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())`);

      await assert.rejects(
        registerKiosk({ orgId: org.orgId, actorUserId: randomUUID(), name: "Restricted", allowedSubsidiaryIds: new Set([org.subsidiaryId]) }),
        UnrestrictedScopeError,
      );
      const { kiosk } = await registerKiosk({ orgId: org.orgId, actorUserId: randomUUID(), name: "Scoped", allowedSubsidiaryIds: null });
      await assert.rejects(
        setWorkerPin({ orgId: org.orgId, actorUserId: randomUUID(), employeePartyId: worker, pin: "4821", allowedSubsidiaryIds: new Set() }),
        ScopeNotFoundError,
      );
      await assert.rejects(
        // An unassigned kiosk has org-wide effect and cannot be retired by a restricted actor.
        revokeKiosk({ orgId: org.orgId, kioskId: kiosk.id, actorUserId: randomUUID(), allowedSubsidiaryIds: new Set([org.subsidiaryId]) }),
        UnrestrictedScopeError,
      );
      const pins = (await db.execute<{ count: string }>(sql`select count(*)::text as count from worker_clock_pins where org_id = ${org.orgId} and employee_party_id = ${worker}`)).rows[0];
      assert.equal(pins?.count, "0", "the refused PIN reset leaves no credential row");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

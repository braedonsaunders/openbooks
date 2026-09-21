import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { loadDirectory, loadOrgChart } from "./org-chart.ts";

/**
 * HR-19 org-chart DB coverage (integration partition): the tree over
 * line relationships as of a date with span and layers, a vacancy node
 * for a funded-but-empty position, a future-dated manager change reading
 * differently on either side of its effective date, the directory, and
 * the read gate. Proofs are read back from the service shape.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

type Harness = {
  org: ScratchOrg;
  readerId: string;
  ceoEmploymentId: string;
  managerEmploymentId: string;
  employeeEmploymentId: string;
};

async function seedEmployment(
  orgId: string,
  subsidiaryId: string,
  name: string,
  title: string,
): Promise<{ partyId: string; employmentId: string }> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, email, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${name}, ${`${name.replaceAll(" ", ".").toLowerCase()}@scratch.test`}, true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  const assignmentId = randomUUID();
  await db.execute(sql`
    insert into employment_assignments (id, org_id, employment_id, assignment_key)
    values (${assignmentId}, ${orgId}, ${employmentId}, 'primary')
  `);
  await db.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, version_no, job_title, is_primary, effective_from, recorded_at)
    values (${orgId}, ${assignmentId}, ${employmentId}, 1, ${title}, true, '2020-01-01'::date, now())
  `);
  return { partyId, employmentId };
}

async function seedReport(
  orgId: string,
  employmentId: string,
  managerEmploymentId: string,
  effectiveFrom: string,
  effectiveTo: string | null = null,
): Promise<void> {
  // Adjacent effective windows ([a,b) + [b,∞)) keep exactly one live line
  // at any effective point — the storage exclusion's own shape. An
  // overlapping second row would violate reporting_relationships_single_line.
  await db.execute(sql`
    insert into reporting_relationships
      (org_id, employment_id, manager_employment_id, kind, relationship_id, version_no, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, ${managerEmploymentId}, 'line', ${randomUUID()}, 1, ${effectiveFrom}::date, ${effectiveTo}, now())
  `);
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  for (const feature of ["hrm", "hrmOrgChart"]) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
       where id = ${org.orgId}
    `);
  }
  const ceo = await seedEmployment(org.orgId, org.subsidiaryId, "Cora Ceo", "Chief Executive");
  const manager = await seedEmployment(org.orgId, org.subsidiaryId, "Mira Manager", "Manager");
  const employee = await seedEmployment(org.orgId, org.subsidiaryId, "Eddie Employee", "Associate");
  await seedReport(org.orgId, manager.employmentId, ceo.employmentId, "2020-01-01");
  // Future-dated manager change: Eddie reports to Mira until 2026-10-01,
  // then to Cora. Adjacent windows — history stays queryable on both sides.
  await seedReport(org.orgId, employee.employmentId, manager.employmentId, "2020-01-01", "2026-10-01");
  await seedReport(org.orgId, employee.employmentId, ceo.employmentId, "2026-10-01");
  // A funded-but-empty position: open, never assigned.
  const positionId = randomUUID();
  await db.execute(sql`
    insert into positions (id, org_id, position_code) values (${positionId}, ${org.orgId}, 'ENG-2')
  `);
  await db.execute(sql`
    insert into position_versions
      (org_id, position_id, version_no, title, employer_subsidiary_id, planned_fte, status, effective_from, recorded_at)
    values (${org.orgId}, ${positionId}, 1, 'Engineer', ${org.subsidiaryId}, 1.0000, 'open', '2020-01-01'::date, now())
  `);
  const readerId = await createScratchUser(org.orgId, "Reader", "reader_self");
  await db.execute(sql`
    insert into user_permission_overrides (org_id, user_id, permission, effect)
    values (${org.orgId}, ${readerId}, 'hrm.employment.read', 'grant')
    on conflict (user_id, permission) do update set effect = 'grant'
  `);
  return {
    org,
    readerId,
    ceoEmploymentId: ceo.employmentId,
    managerEmploymentId: manager.employmentId,
    employeeEmploymentId: employee.employmentId,
  };
}

test("tree, vacancy, as-of manager change, and directory", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const before = await loadOrgChart({ orgId: h.org.orgId, actorId: h.readerId, asOf: "2026-09-21" });
    assert.equal(before.headcount, 3);
    assert.equal(before.vacancies, 1);
    assert.equal(before.layers, 3);
    assert.equal(before.roots.length, 2); // Cora + the vacancy
    const ceo = before.roots.find((r) => r.name === "Cora Ceo")!;
    assert.equal(ceo.spanOfControl, 1);
    assert.equal(ceo.children[0]!.name, "Mira Manager");
    assert.equal(ceo.children[0]!.children[0]!.name, "Eddie Employee");
    assert.equal(ceo.children[0]!.children[0]!.layer, 2);
    const vacancy = before.roots.find((r) => r.vacant)!;
    assert.match(vacancy.name, /Engineer/);
    assert.equal(vacancy.positionCode, "ENG-2");

    // After the future-dated change Eddie reports to Cora directly.
    const after = await loadOrgChart({ orgId: h.org.orgId, actorId: h.readerId, asOf: "2026-10-02" });
    const ceoAfter = after.roots.find((r) => r.name === "Cora Ceo")!;
    assert.equal(ceoAfter.spanOfControl, 2);
    assert.ok(ceoAfter.children.some((c) => c.name === "Eddie Employee"));

    // Root focus narrows the tree.
    const focused = await loadOrgChart({
      orgId: h.org.orgId,
      actorId: h.readerId,
      asOf: "2026-09-21",
      rootEmploymentId: h.managerEmploymentId,
    });
    assert.equal(focused.roots.length, 1);
    assert.equal(focused.roots[0]!.name, "Mira Manager");

    // Directory carries names, titles, and managers — never pay.
    const directory = await loadDirectory({ orgId: h.org.orgId, actorId: h.readerId, search: "Eddie" });
    assert.equal(directory.length, 1);
    assert.equal(directory[0]!.title, "Associate");
    assert.equal(directory[0]!.managerName, "Mira Manager");
    assert.ok(!("gross" in directory[0]!) && !("netPay" in directory[0]!));

    // No grant, no chart.
    const outsider = await createScratchUser(h.org.orgId, "Outsider", "outsider_self");
    await assert.rejects(
      loadOrgChart({ orgId: h.org.orgId, actorId: outsider, asOf: "2026-09-21" }),
      (e: unknown) => e instanceof HrmAuthorizationError,
    );
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

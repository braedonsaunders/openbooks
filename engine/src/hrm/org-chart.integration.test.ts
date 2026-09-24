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
import { HrmOrgChartError } from "./documents/errors.ts";
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

test("chart and directory are fenced by employer scope and the self-service team", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    for (const feature of ["hrm", "hrmOrgChart"]) {
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
         where id = ${org.orgId}
      `);
    }
    // Second legal entity under the single root.
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
    const ceo = await seedEmployment(org.orgId, org.subsidiaryId, "Cora Ceo", "Chief Executive");
    const manager = await seedEmployment(org.orgId, org.subsidiaryId, "Mira Manager", "Manager");
    // Cross-entity direct report: Eddie works for Second Co, managed by Mira.
    const employee = await seedEmployment(org.orgId, subB, "Eddie Employee", "Associate");
    await seedReport(org.orgId, manager.employmentId, ceo.employmentId, "2020-01-01");
    await seedReport(org.orgId, employee.employmentId, manager.employmentId, "2020-01-01");
    const seedVacancy = async (subsidiary: string, code: string, title: string): Promise<void> => {
      const positionId = randomUUID();
      await db.execute(sql`
        insert into positions (id, org_id, position_code) values (${positionId}, ${org.orgId}, ${code})
      `);
      await db.execute(sql`
        insert into position_versions
          (org_id, position_id, version_no, title, employer_subsidiary_id, planned_fte, status, effective_from, recorded_at)
        values (${org.orgId}, ${positionId}, 1, ${title}, ${subsidiary}, 1.0000, 'open', '2020-01-01'::date, now())
      `);
    };
    await seedVacancy(org.subsidiaryId, "ENG-A", "Engineer A");
    await seedVacancy(subB, "ENG-B", "Engineer B");

    const linkParty = async (userId: string, partyId: string): Promise<void> => {
      await db.execute(sql`update users set party_id = ${partyId} where id = ${userId} and org_id = ${org.orgId}`);
    };
    const grantRead = async (userId: string, permission: string): Promise<void> => {
      await db.execute(sql`
        insert into user_permission_overrides (org_id, user_id, permission, effect)
        values (${org.orgId}, ${userId}, ${permission}, 'grant')
        on conflict (user_id, permission) do update set effect = 'grant'
      `);
    };
    const restrict = async (roleKey: string, subsidiaryIds: string[]): Promise<void> => {
      await db.execute(sql`
        update app_roles set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
         where org_id = ${org.orgId} and key = ${roleKey}`);
    };
    const partyOf = async (employmentId: string): Promise<string> => {
      const row = (await db.execute<{ partyId: string }>(sql`
        select worker_party_id::text as "partyId" from worker_employments
         where org_id = ${org.orgId} and id = ${employmentId}`)).rows[0];
      return row!.partyId;
    };

    // HR reader restricted to the root entity.
    const hrA = await createScratchUser(org.orgId, "Scoped HR", "scoped_hr");
    await grantRead(hrA, "hrm.employment.read");
    await restrict("scoped_hr", [org.subsidiaryId]);
    // Self-service actors linked to their parties.
    const miraSelf = await createScratchUser(org.orgId, "Mira", "mira_self");
    await grantRead(miraSelf, "hrm.self.read");
    await linkParty(miraSelf, await partyOf(manager.employmentId));
    const eddieSelf = await createScratchUser(org.orgId, "Eddie", "eddie_self");
    await grantRead(eddieSelf, "hrm.self.read");
    await linkParty(eddieSelf, await partyOf(employee.employmentId));

    // Restricted HR sees the root entity only: no Eddie, no Second Co vacancy.
    const hrChart = await loadOrgChart({ orgId: org.orgId, actorId: hrA, asOf: "2026-09-21" });
    assert.equal(hrChart.headcount, 2);
    assert.equal(hrChart.vacancies, 1);
    const hrNames = [hrChart.roots.flatMap((r) => [r.name, ...r.children.map((c) => c.name)])].flat();
    assert.ok(hrNames.includes("Cora Ceo") && hrNames.includes("Mira Manager"));
    assert.ok(!hrNames.includes("Eddie Employee"));
    assert.ok(hrChart.roots.some((r) => r.vacant && r.name.includes("Engineer A")));
    assert.ok(!hrChart.roots.some((r) => r.vacant && r.name.includes("Engineer B")));
    const hrDirectory = await loadDirectory({ orgId: org.orgId, actorId: hrA });
    assert.deepEqual(hrDirectory.map((d) => d.name).sort(), ["Cora Ceo", "Mira Manager"]);
    assert.ok(hrDirectory.every((d) => d.email?.includes("@scratch.test")));

    // Mira's self-service chart is herself plus her direct report — never
    // the whole org, never vacancies, and her invisible manager hangs
    // nothing above her.
    const miraChart = await loadOrgChart({ orgId: org.orgId, actorId: miraSelf, asOf: "2026-09-21" });
    assert.equal(miraChart.headcount, 2);
    assert.equal(miraChart.vacancies, 0);
    assert.equal(miraChart.roots.length, 1);
    assert.equal(miraChart.roots[0]!.name, "Mira Manager");
    assert.deepEqual(miraChart.roots[0]!.children.map((c) => c.name), ["Eddie Employee"]);
    // Focusing an out-of-view root answers not-found, never the row.
    await assert.rejects(
      loadOrgChart({ orgId: org.orgId, actorId: miraSelf, asOf: "2026-09-21", rootEmploymentId: ceo.employmentId }),
      (e: unknown) => e instanceof HrmOrgChartError,
    );

    // Eddie sees only himself in both surfaces, with his work email.
    const eddieChart = await loadOrgChart({ orgId: org.orgId, actorId: eddieSelf, asOf: "2026-09-21" });
    assert.equal(eddieChart.headcount, 1);
    assert.equal(eddieChart.roots[0]!.name, "Eddie Employee");
    const eddieDirectory = await loadDirectory({ orgId: org.orgId, actorId: eddieSelf });
    assert.equal(eddieDirectory.length, 1);
    assert.equal(eddieDirectory[0]!.name, "Eddie Employee");
    assert.equal(eddieDirectory[0]!.email, "eddie.employee@scratch.test");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("impossible calendar dates refuse by name before any database read", async () => {
  // 2023-02-30 passes the YYYY-MM-DD shape and Date.parse normalizes it
  // into March, so the old check waved it through to the CTE's asOf::date
  // cast, which failed as a raw database error. The shared strict parser
  // refuses it as a named VALIDATION (400 at the route) up front — no org,
  // actor, or database is touched.
  for (const asOf of ["2023-02-30", "2023-13-01", "2023-00-10", "not-a-date"]) {
    await assert.rejects(
      loadOrgChart({ orgId: "00000000-0000-0000-0000-000000000000", actorId: "00000000-0000-0000-0000-000000000000", asOf }),
      (e: unknown) => {
        assert.ok(e instanceof HrmOrgChartError);
        assert.equal((e as HrmOrgChartError).code, "VALIDATION");
        assert.match((e as Error).message, /civil date/);
        return true;
      },
    );
  }
});

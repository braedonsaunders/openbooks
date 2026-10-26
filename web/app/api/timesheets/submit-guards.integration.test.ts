import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The submit guards live in the week's server helper (route/route.ts pins the
// wiring statically, as the neighbouring submit-atomicity test does); the
// guard semantics are proven here against a scratch database.
// The week's server helper pulls `server-only` through its import graph; in
// the spawned child (plain node, no Next compiler) that marker package
// throws on evaluation, so resolve it to an empty module — the same stub
// the report-catalog suites register in-process.
const serverOnlyLoader = `data:text/javascript,${encodeURIComponent(`
  import { registerHooks } from "node:module";
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "server-only") {
        return { shortCircuit: true, url: "data:text/javascript,export default {}" };
      }
      return nextResolve(specifier, context);
    },
  });
`)}`;

function runIntegrationSource(source: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      serverOnlyLoader,
      "--import",
      "tsx",
      "--import",
      "./engine/src/testing/database-bypass.ts",
      "--input-type=module",
      "-e",
      source,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 180_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const SEED = `
  import { randomUUID } from "node:crypto";
  import { sql } from "drizzle-orm";
  import { db, withOrgTransaction } from "./engine/src/platform/db.ts";
  import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
  import {
    createScratchOrg,
    dropScratchOrg,
    seedFlowActors,
    seedApprovalFlow,
  } from "./engine/src/testing/fixtures.ts";
  import { assertWeekSubmittable } from "./web/app/api/timesheets/_lib.ts";

  const { routeSubjectSubmission } = await import("./engine/src/flows/submission-policy.ts");
  installTrustedTestDatabaseBypass();

  async function seedSubmittedWeek() {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const employeeId = randomUUID();
    const headerId = randomUUID();
    await db.execute(sql\`
      insert into parties
        (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values
        (\${employeeId}, \${org.orgId}, 'employee', 'Submit Guard',
         \${org.subsidiaryId}, true, '{}'::jsonb)
    \`);
    await db.execute(sql\`
      insert into timesheet_weeks
        (id, org_id, employee_party_id, week_start, status,
         created_by, updated_by)
      values
        (\${headerId}, \${org.orgId}, \${employeeId}, '2026-07-12',
         'submitted', \${actorId}, \${actorId})
    \`);
    return { org, actorId, employeeId, headerId };
  }

  async function seedOpenGate(fixture) {
    await seedApprovalFlow(fixture.org.orgId, {subjectKind:"timesheet_week", mode:"any", preventSelfApproval:false,
      assignees:[{type:"user",userId:fixture.actorId}]});
    await withOrgTransaction(fixture.org.orgId,()=>routeSubjectSubmission({orgId:fixture.org.orgId,
      actorId:fixture.actorId,subjectKind:"timesheet_week",subjectId:fixture.headerId}));
  }

  async function cleanup(fixture) {
    try { await dropScratchOrg(fixture.org.orgId); }
    finally { await (await import("@openbooks/jobs")).closeJobConnections(); }
  }

`;

test("resubmitting a week owned by pending gates is refused", () => {
  runIntegrationSource(`
      ${SEED}
      const fixture = await seedSubmittedWeek();
      try {
        await seedOpenGate(fixture);
        await assert.rejects(
          withOrgTransaction(fixture.org.orgId, () =>
            assertWeekSubmittable(fixture.org.orgId, fixture.headerId, 2),
          ),
          /pending approval workflow/i,
        );
      } finally {
        await cleanup(fixture);
      }
    `);
});

test("submitting a week with no draft or rejected entries is refused", () => {
  runIntegrationSource(`
      ${SEED}
      const fixture = await seedSubmittedWeek();
      try {
        await assert.rejects(
          withOrgTransaction(fixture.org.orgId, () =>
            assertWeekSubmittable(fixture.org.orgId, fixture.headerId, 0),
          ),
          /nothing to submit/i,
        );
      } finally {
        await cleanup(fixture);
      }
    `);
});

test("a first submission with movable entries and no open gates passes", () => {
  runIntegrationSource(`
      ${SEED}
      const fixture = await seedSubmittedWeek();
      try {
        await withOrgTransaction(fixture.org.orgId, () =>
          assertWeekSubmittable(fixture.org.orgId, fixture.headerId, 3),
        );
      } finally {
        await cleanup(fixture);
      }
    `);
});

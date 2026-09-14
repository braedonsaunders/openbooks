import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

// The submit guards live in the week's server helper (route/route.ts pins the
// wiring statically, as the neighbouring submit-atomicity test does); the
// guard semantics are proven here against a scratch database.
const serverOnlyLoader = `data:text/javascript,${encodeURIComponent(`
  import { registerHooks } from "node:module";
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "server-only") {
        return {
          url: "data:text/javascript,export {}",
          format: "module",
          shortCircuit: true,
        };
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
      "./engine/src/test-database-bypass.ts",
      "--input-type=module",
      "-e",
      source,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const SEED = `
  import { randomUUID } from "node:crypto";
  import { sql } from "drizzle-orm";
  import { db, withOrgTransaction } from "./engine/src/db.ts";
  import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
  import {
    createScratchOrg,
    dropScratchOrg,
    seedFlowActors,
  } from "./engine/src/test-fixtures.ts";
  import { assertWeekSubmittable } from "./web/app/api/timesheets/_lib.ts";

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
    const flowId = randomUUID();
    const runId = randomUUID();
    await db.execute(sql\`
      insert into flows (id, org_id, name, subject_kind, enabled, graph)
      values (\${flowId}, \${fixture.org.orgId}, 'Timesheet approvals',
              'timesheet_week', true, '{}'::jsonb)
    \`);
    await db.execute(sql\`
      insert into flow_runs
        (id, org_id, flow_id, subject_kind, subject_id, trigger, status)
      values (\${runId}, \${fixture.org.orgId}, \${flowId},
              'timesheet_week', \${fixture.headerId}, 'on_submit', 'waiting')
    \`);
    await db.execute(sql\`
      insert into flow_gates
        (org_id, flow_id, run_id, node_id, subject_kind, subject_id,
         title, assignee_user_id, group_key, quorum, status)
      values (\${fixture.org.orgId}, \${flowId}, \${runId}, 'gate-1',
              'timesheet_week', \${fixture.headerId}, 'Manager approval',
              \${fixture.actorId}, 'gate-1', 'any', 'pending')
    \`);
  }

  async function cleanup(fixture) {
    await db.execute(sql\`delete from flow_gates where org_id = \${fixture.org.orgId}\`);
    await db.execute(sql\`delete from flow_runs where org_id = \${fixture.org.orgId}\`);
    await db.execute(sql\`delete from flows where org_id = \${fixture.org.orgId}\`);
    await db.execute(sql\`delete from time_entries where org_id = \${fixture.org.orgId}\`);
    await dropScratchOrg(fixture.org.orgId);
  }
`;

test(
  "resubmitting a week owned by pending gates is refused",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
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
  },
);

test(
  "submitting a week with no draft or rejected entries is refused",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
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
  },
);

test(
  "a first submission with movable entries and no open gates passes",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
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
  },
);

test("the submit route gates dispatch on the guard", () => {
  const route = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "submit/route.ts"),
    "utf8",
  );
  const transaction = route.indexOf("withOrgTransaction(orgId, async () =>");
  const guard = route.indexOf("assertWeekSubmittable(");
  const dispatch = route.indexOf("runRecordFlows(");
  assert.ok(transaction >= 0 && guard > transaction, "guard must run inside the submit transaction");
  assert.ok(guard < dispatch, "guard must precede flow dispatch");
  assert.match(route, /assertWeekSubmittable\(orgId, header\.id,/);
});

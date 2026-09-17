import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

// Same child-process harness as time-approval-atomicity.integration.test.ts:
// web/lib modules import `server-only`, so the approval service runs in a
// child with that marker stubbed (trusted integration process only).
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
  import { db } from "./engine/src/db.ts";
  import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
  import {
    createScratchOrg,
    dropScratchOrg,
    seedFlowActors,
  } from "./engine/src/test-fixtures.ts";
  import { approveSubmittedTimeEntries } from "./web/lib/time-approval.ts";

  installTrustedTestDatabaseBypass();

  async function seedWeek({ withSubmittedEntry }) {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const employeeId = randomUUID();
    const headerId = randomUUID();
    await db.execute(sql\`
      insert into parties
        (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values
        (\${employeeId}, \${org.orgId}, 'employee', 'Guard Worker',
         \${org.subsidiaryId}, true, '{}'::jsonb)
    \`);
    await db.execute(sql\`
      insert into timesheet_weeks
        (id, org_id, employee_party_id, week_start, status,
         created_by, updated_by)
      values
        (\${headerId}, \${org.orgId}, \${employeeId}, '2026-07-12',
         'draft', \${actorId}, \${actorId})
    \`);
    let timeEntryId = null;
    if (withSubmittedEntry) {
      timeEntryId = randomUUID();
      await db.execute(sql\`
        insert into time_entries
          (id, org_id, employee_party_id, worked_on, hours,
           status, is_billable, costing_basis, custom, created_by, updated_by)
        values
          (\${timeEntryId}, \${org.orgId}, \${employeeId}, '2026-07-15',
           '4.0000', 'submitted', false, 'actual', '{}'::jsonb,
           \${actorId}, \${actorId})
      \`);
      await db.execute(sql\`
        update timesheet_weeks set status = 'submitted'
         where id = \${headerId}
      \`);
    }
    return { org, actorId, employeeId, headerId, timeEntryId };
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
`;

test(
  "approval refuses a week with nothing submitted instead of stamping it approved",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    runIntegrationSource(`
      ${SEED}
      const fixture = await seedWeek({ withSubmittedEntry: false });
      try {
        await assert.rejects(
          approveSubmittedTimeEntries({
            orgId: fixture.org.orgId,
            actorId: fixture.actorId,
            employeePartyId: fixture.employeeId,
            weekStart: "2026-07-12",
          }),
          /no submitted entries|nothing submitted/i,
        );
        const header = await db.execute(sql\`
          select status from timesheet_weeks where id = \${fixture.headerId}
        \`);
        assert.equal(header.rows[0].status, "draft");
      } finally {
        await dropScratchOrg(fixture.org.orgId);
      }
    `);
  },
);

test(
  "a second approval names the prior approval instead of misreporting an unsubmitted week",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    // F-t08-009: re-approving an approved week failed with a causeless
    // conflict — nothing identified the prior approval (who/when) or named
    // the way back (reopen/amend). The refusal must carry both.
    runIntegrationSource(`
      ${SEED}
      const fixture = await seedWeek({ withSubmittedEntry: true });
      try {
        await approveSubmittedTimeEntries({
          orgId: fixture.org.orgId,
          actorId: fixture.actorId,
          employeePartyId: fixture.employeeId,
          weekStart: "2026-07-12",
        });
        await assert.rejects(
          approveSubmittedTimeEntries({
            orgId: fixture.org.orgId,
            actorId: fixture.actorId,
            employeePartyId: fixture.employeeId,
            weekStart: "2026-07-12",
          }),
          /already approved by .+ on \\d{4}-\\d{2}-\\d{2}.*reopen or amend/i,
        );
      } finally {
        await dropScratchOrg(fixture.org.orgId);
      }
    `);
  },
);

test(
  "direct approval refuses a week owned by pending flow gates",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    runIntegrationSource(`
      ${SEED}
      const fixture = await seedWeek({ withSubmittedEntry: true });
      try {
        await seedOpenGate(fixture);
        await assert.rejects(
          approveSubmittedTimeEntries({
            orgId: fixture.org.orgId,
            actorId: fixture.actorId,
            employeePartyId: fixture.employeeId,
            weekStart: "2026-07-12",
          }),
          /pending approval|approval workflow|open gate/i,
        );
        const entry = await db.execute(sql\`
          select status from time_entries where id = \${fixture.timeEntryId}
        \`);
        assert.equal(entry.rows[0].status, "submitted");
        const header = await db.execute(sql\`
          select status from timesheet_weeks where id = \${fixture.headerId}
        \`);
        assert.equal(header.rows[0].status, "submitted");
      } finally {
        await db.execute(sql\`
          delete from flow_gates where org_id = \${fixture.org.orgId}
        \`);
        await db.execute(sql\`
          delete from flow_runs where org_id = \${fixture.org.orgId}
        \`);
        await db.execute(sql\`
          delete from flows where org_id = \${fixture.org.orgId}
        \`);
        await db.execute(sql\`
          delete from time_entries where org_id = \${fixture.org.orgId}
        \`);
        await dropScratchOrg(fixture.org.orgId);
      }
    `);
  },
);

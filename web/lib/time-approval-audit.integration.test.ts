import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

// Same child-process harness as time-approval-guards.integration.test.ts:
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

  async function seedSubmittedWeek() {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const employeeId = randomUUID();
    const headerId = randomUUID();
    const projectId = randomUUID();
    const timeEntryId = randomUUID();
    await db.execute(sql\`
      insert into parties
        (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values
        (\${employeeId}, \${org.orgId}, 'employee', 'Audit Worker',
         \${org.subsidiaryId}, true, '{}'::jsonb)
    \`);
    await db.execute(sql\`
      insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status,
         is_active, custom)
      values
        (\${projectId}, \${org.orgId}, \${org.subsidiaryId},
         'JOB-APPROVAL-AUDIT', 'Approval audit job',
         \${org.customerId}, 'active', true, '{}'::jsonb)
    \`);
    await db.execute(sql\`
      insert into timesheet_weeks
        (id, org_id, employee_party_id, week_start, status,
         created_by, updated_by)
      values
        (\${headerId}, \${org.orgId}, \${employeeId}, '2026-07-12',
         'submitted', \${actorId}, \${actorId})
    \`);
    await db.execute(sql\`
      insert into time_entries
        (id, org_id, employee_party_id, worked_on, hours, project_id,
         status, cost_rate, cost_rate_currency, cost_rate_subsidiary_id,
         costing_basis, is_billable, custom, created_by, updated_by)
      values
        (\${timeEntryId}, \${org.orgId}, \${employeeId}, '2026-07-15',
         '4.0000', \${projectId}, 'submitted', '30.0000', 'CAD',
         \${org.subsidiaryId}, 'actual', false, '{}'::jsonb,
         \${actorId}, \${actorId})
    \`);
    return { org, actorId, employeeId, headerId, timeEntryId };
  }

  async function cleanup(fixture) {
    await db.execute(sql\`
      delete from time_entries where org_id = \${fixture.org.orgId}
    \`);
    await dropScratchOrg(fixture.org.orgId);
  }
`;

test(
  "approving a submitted week writes actor-attributed before/after audit evidence",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    runIntegrationSource(`
      ${SEED}
      const fixture = await seedSubmittedWeek();
      try {
        await approveSubmittedTimeEntries({
          orgId: fixture.org.orgId,
          actorId: fixture.actorId,
          employeePartyId: fixture.employeeId,
          weekStart: "2026-07-12",
        });
        const audit = await db.execute(sql\`
          select action, actor_id as "actorId", changes
            from audit_log
           where org_id = \${fixture.org.orgId}
             and table_name = 'timesheet_weeks'
             and row_id = \${fixture.headerId}
        \`);
        assert.equal(audit.rows.length, 1, "approval must leave exactly one audit row for the week");
        assert.equal(audit.rows[0].action, "update");
        assert.equal(audit.rows[0].actorId, fixture.actorId);
        const changes = audit.rows[0].changes;
        assert.equal(changes.before.status, "submitted");
        assert.equal(changes.after.status, "approved");
        assert.ok(
          Array.isArray(changes.entryIds) && changes.entryIds.includes(fixture.timeEntryId),
          "evidence must name the approved entries",
        );
      } finally {
        await cleanup(fixture);
      }
    `);
  },
);

test(
  "a failed approval leaves no orphan audit evidence behind",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    runIntegrationSource(`
      ${SEED}
      const fixture = await seedSubmittedWeek();
      try {
        // Arm configured financial effects, then remove the period cover so
        // the posting fails after the approval UPDATE (same shape as the
        // atomicity fixture): the whole unit — including any audit evidence —
        // must roll back together.
        await db.execute(sql\`
          update orgs
             set settings = settings || \${JSON.stringify({
               laborCosting: { mode: "post", hoursPerDay: 8, annualHours: 2080, components: [] },
               controlAccounts: {
                 ar: fixture.org.accounts.ar,
                 ap: fixture.org.accounts.ap,
                 bank: fixture.org.accounts.bank,
                 laborWip: fixture.org.accounts.cogs,
                 laborClearing: fixture.org.accounts.clearing,
               },
             })}::jsonb
           where id = \${fixture.org.orgId}
        \`);
        await db.execute(sql\`
          delete from accounting_periods where org_id = \${fixture.org.orgId}
        \`);
        await assert.rejects(
          approveSubmittedTimeEntries({
            orgId: fixture.org.orgId,
            actorId: fixture.actorId,
            employeePartyId: fixture.employeeId,
            weekStart: "2026-07-12",
          }),
          /no accounting period covers/,
        );
        const audit = await db.execute(sql\`
          select count(*)::int as n from audit_log
           where org_id = \${fixture.org.orgId}
        \`);
        assert.equal(audit.rows[0].n, 0, "rolled-back approval must not leave audit rows");
      } finally {
        await cleanup(fixture);
      }
    `);
  },
);

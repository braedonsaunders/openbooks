import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/platform/db.ts";

// Same child-process harness as time-approval-audit.integration.test.ts:
// web/lib modules import `server-only`, so the amendment service runs in a
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
      "./engine/src/testing/database-bypass.ts",
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
  import { db } from "./engine/src/platform/db.ts";
  import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
  import {
    createScratchOrg,
    dropScratchOrg,
    seedActiveEmployment,
    seedFlowActors,
  } from "./engine/src/testing/fixtures.ts";
  import { amendTimeEntry } from "./web/lib/time-amendment.ts";

  installTrustedTestDatabaseBypass();

  async function seedWeek(status) {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const employeeId = randomUUID();
    const headerId = randomUUID();
    const timeEntryId = randomUUID();
    await db.execute(sql\`
      insert into parties
        (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values
        (\${employeeId}, \${org.orgId}, 'employee', 'Amend Worker',
         \${org.subsidiaryId}, true, '{}'::jsonb)
    \`);
    await seedActiveEmployment(org.orgId, employeeId);
    await db.execute(sql\`
      insert into employee_roles (id, org_id, party_id, is_active)
      values (\${randomUUID()}, \${org.orgId}, \${employeeId}, true)
    \`);
    await db.execute(sql\`
      insert into timesheet_weeks
        (id, org_id, employee_party_id, week_start, status,
         created_by, updated_by)
      values
        (\${headerId}, \${org.orgId}, \${employeeId}, '2026-07-12',
         \${status === 'approved' ? 'approved' : 'draft'}, \${actorId}, \${actorId})
    \`);
    await db.execute(sql\`
      insert into time_entries
        (id, org_id, employee_party_id, worked_on, hours,
         status, is_billable, costing_basis, custom, created_by, updated_by)
      values
        (\${timeEntryId}, \${org.orgId}, \${employeeId}, '2026-07-15',
         '4.0000', \${status}, false, 'actual', '{}'::jsonb,
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
  "amending an approved entry writes actor-attributed before/after audit evidence",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    runIntegrationSource(`
      ${SEED}
      const fixture = await seedWeek('approved');
      try {
        const result = await amendTimeEntry(fixture.org.orgId, fixture.actorId, fixture.timeEntryId);
        const audit = await db.execute(sql\`
          select action, actor_id as "actorId", changes
            from audit_log
           where org_id = \${fixture.org.orgId}
             and table_name = 'time_entries'
             and row_id = \${result.id}
        \`);
        assert.equal(audit.rows.length, 1, "amendment must leave exactly one audit row for the contra entry");
        assert.equal(audit.rows[0].action, "insert");
        assert.equal(audit.rows[0].actorId, fixture.actorId);
        const changes = audit.rows[0].changes;
        assert.equal(changes.amendsEntryId, fixture.timeEntryId);
        assert.equal(changes.before.status, "approved");
        assert.equal(changes.after.status, "draft");
      } finally {
        await cleanup(fixture);
      }
    `);
  },
);

test(
  "a refused amendment leaves no audit evidence behind",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    runIntegrationSource(`
      ${SEED}
      const fixture = await seedWeek('draft');
      try {
        await assert.rejects(
          amendTimeEntry(fixture.org.orgId, fixture.actorId, fixture.timeEntryId),
          /only an approved entry/,
        );
        const audit = await db.execute(sql\`
          select count(*)::int as n from audit_log
           where org_id = \${fixture.org.orgId}
        \`);
        assert.equal(audit.rows[0].n, 0, "refused amendment must not leave audit rows");
      } finally {
        await cleanup(fixture);
      }
    `);
  },
);

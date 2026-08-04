import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

test(
  "weekly time approval rolls back when configured financial effects cannot post",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    const source = `
      import assert from "node:assert/strict";
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
      const org = await createScratchOrg();
      try {
        const actorId = (await seedFlowActors(org.orgId)).adminId;
        const employeeId = randomUUID();
        const projectId = randomUUID();
        const timeEntryId = randomUUID();
        await db.execute(sql\`
          update orgs
             set settings = settings || \${JSON.stringify({
               laborCosting: { mode: "post", hoursPerDay: 8, annualHours: 2080, components: [] },
               controlAccounts: {
                 ar: org.accounts.ar,
                 ap: org.accounts.ap,
                 bank: org.accounts.bank,
                 laborWip: org.accounts.cogs,
                 laborClearing: org.accounts.clearing,
               },
             })}::jsonb
           where id = \${org.orgId}
        \`);
        await db.execute(sql\`
          insert into parties
            (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
          values
            (\${employeeId}, \${org.orgId}, 'employee', 'Approval Worker',
             \${org.subsidiaryId}, true, '{}'::jsonb)
        \`);
        await db.execute(sql\`
          insert into projects
            (id, org_id, subsidiary_id, code, name, customer_id, status,
             is_active, custom)
          values
            (\${projectId}, \${org.orgId}, \${org.subsidiaryId},
             'JOB-APPROVAL-ROLLBACK', 'Approval rollback job',
             \${org.customerId}, 'active', true, '{}'::jsonb)
        \`);
        await db.execute(sql\`
          insert into time_entries
            (id, org_id, employee_party_id, worked_on, hours, project_id,
             status, cost_rate, cost_rate_currency, cost_rate_subsidiary_id,
             costing_basis, is_billable, custom, created_by, updated_by)
          values
            (\${timeEntryId}, \${org.orgId}, \${employeeId}, \${org.date},
             '4.0000', \${projectId}, 'submitted', '30.0000', 'CAD',
             \${org.subsidiaryId}, 'actual', false, '{}'::jsonb,
             \${actorId}, \${actorId})
        \`);

        // Force the configured labor post to fail after the approval UPDATE.
        // The service must roll the UPDATE back with the failed journal.
        await db.execute(sql\`
          delete from accounting_periods where org_id = \${org.orgId}
        \`);
        await assert.rejects(
          approveSubmittedTimeEntries({
            orgId: org.orgId,
            actorId,
            employeePartyId: employeeId,
            from: "2026-07-13",
            to: "2026-07-19",
          }),
          /no accounting period covers/,
        );

        const entry = await db.execute(sql\`
          select status, approved_by, approved_at, cost_journal_entry_id
            from time_entries
           where id = \${timeEntryId}
        \`);
        assert.deepEqual(entry.rows[0], {
          status: "submitted",
          approved_by: null,
          approved_at: null,
          cost_journal_entry_id: null,
        });
        const journals = await db.execute(sql\`
          select count(*)::int as count
            from journal_entries
           where org_id = \${org.orgId} and origin = 'labor_burden'
        \`);
        assert.equal(journals.rows[0].count, 0);
      } finally {
        await db.execute(sql\`
          delete from time_entries where org_id = \${org.orgId}
        \`);
        await dropScratchOrg(org.orgId);
      }
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
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
  },
);

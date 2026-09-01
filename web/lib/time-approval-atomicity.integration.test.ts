import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

// Run the child with React's normal Node condition so Next's navigation
// boundary receives the full React API (the react-server export omits
// createContext). The production modules still import server-only as a
// marker; replace that marker only inside this trusted integration process.
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
            weekStart: "2026-07-12",
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
    runIntegrationSource(source);
  },
);

test(
  "weekly approval commits or rolls back its header, rate snapshots, and journals together",
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

      async function seedApprovalFixture(label) {
        const org = await createScratchOrg();
        const actorId = (await seedFlowActors(org.orgId)).adminId;
        const employeeId = randomUUID();
        const projectId = randomUUID();
        const timeEntryId = randomUUID();
        const headerId = randomUUID();

        await db.execute(sql\`
          update orgs
             set settings = settings || \${JSON.stringify({
               laborCosting: {
                 mode: "post",
                 hoursPerDay: 8,
                 annualHours: 2080,
                 components: [],
               },
               controlAccounts: {
                 ar: org.accounts.ar,
                 ap: org.accounts.ap,
                 bank: org.accounts.bank,
                 laborWip: org.accounts.cogs,
                 laborClearing: org.accounts.clearing,
               },
               overheadApplication: {
                 mode: "net_zero_pair",
                 accountId: org.accounts.adjustment,
               },
             })}::jsonb
           where id = \${org.orgId}
        \`);
        await db.execute(sql\`
          update items set default_rate = '125.0000'
           where org_id = \${org.orgId} and id = \${org.items.service}
        \`);
        await db.execute(sql\`
          insert into parties
            (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
          values
            (\${employeeId}, \${org.orgId}, 'employee', \${'Approval Worker ' + label},
             \${org.subsidiaryId}, true, '{}'::jsonb)
        \`);
        await db.execute(sql\`
          insert into projects
            (id, org_id, subsidiary_id, code, name, customer_id, status,
             is_active, custom)
          values
            (\${projectId}, \${org.orgId}, \${org.subsidiaryId},
             \${'JOB-APPROVAL-' + label}, \${'Approval job ' + label},
             \${org.customerId}, 'active', true, '{}'::jsonb)
        \`);
        await db.execute(sql\`
          insert into labor_cost_rates
            (id, org_id, employee_party_id, currency, rate, basis,
             annual_hours, effective_from, is_active)
          values
            (\${randomUUID()}, \${org.orgId}, \${employeeId}, 'CAD', '30.0000',
             'hour', '2080.0000', '2026-07-01', true)
        \`);
        await db.execute(sql\`
          insert into overhead_rates
            (id, org_id, method, rate_kind, rate_percent, effective_from)
          values
            (\${randomUUID()}, \${org.orgId}, 'standard', 'per_hour',
             '12.5000', '2026-07-01')
        \`);
        await db.execute(sql\`
          insert into timesheet_weeks
            (id, org_id, employee_party_id, week_start, status,
             submitted_by, submitted_at, created_by, updated_by)
          values
            (\${headerId}, \${org.orgId}, \${employeeId}, '2026-07-12',
             'submitted', \${actorId}, now(), \${actorId}, \${actorId})
        \`);
        await db.execute(sql\`
          insert into time_entries
            (id, org_id, employee_party_id, worked_on, hours, item_id, project_id,
             status, is_billable, costing_basis, custom, created_by, updated_by)
          values
            (\${timeEntryId}, \${org.orgId}, \${employeeId}, \${org.date},
             '4.0000', \${org.items.service}, \${projectId}, 'submitted', true,
             'actual', '{}'::jsonb, \${actorId}, \${actorId})
        \`);

        return { org, actorId, employeeId, timeEntryId, headerId };
      }

      const failed = await seedApprovalFixture('ROLLBACK');
      try {
        // The trigger fires only on this owned header and verifies that every
        // entry/effect write is visible before it injects the final failure.
        await db.execute(sql\`drop trigger if exists time_approval_header_fault_trg on timesheet_weeks\`);
        await db.execute(sql\`drop function if exists time_approval_header_fault()\`);
        await db.execute(sql.raw(\`
          create function time_approval_header_fault() returns trigger
          language plpgsql as $fault$
          begin
            if not exists (
              select 1 from time_entries
               where id = '\${failed.timeEntryId}'::uuid
                 and status = 'approved'
                 and cost_rate is not null
                 and labor_cost_rate_id is not null
                 and bill_rate is not null
                 and cost_journal_entry_id is not null
                 and overhead_journal_entry_id is not null
            ) then
              raise exception 'approval effects were not visible before header update';
            end if;
            raise exception 'injected timesheet header update failure';
          end
          $fault$;
          create trigger time_approval_header_fault_trg
            before update on timesheet_weeks
            for each row when (new.id = '\${failed.headerId}'::uuid and new.status = 'approved')
            execute function time_approval_header_fault();
        \`));

        await assert.rejects(
          approveSubmittedTimeEntries({
            orgId: failed.org.orgId,
            actorId: failed.actorId,
            employeePartyId: failed.employeeId,
            weekStart: '2026-07-12',
          }),
          (error) => /injected timesheet header update failure/.test(
            String(error?.cause?.message ?? error?.message),
          ),
        );

        const rolledBackEntry = await db.execute(sql\`
          select status, approved_by, approved_at, cost_rate, labor_cost_rate_id,
                 bill_rate, cost_journal_entry_id, overhead_journal_entry_id
            from time_entries where id = \${failed.timeEntryId}
        \`);
        assert.deepEqual(rolledBackEntry.rows[0], {
          status: 'submitted',
          approved_by: null,
          approved_at: null,
          cost_rate: null,
          labor_cost_rate_id: null,
          bill_rate: null,
          cost_journal_entry_id: null,
          overhead_journal_entry_id: null,
        });
        const rolledBackHeader = await db.execute(sql\`
          select status, approved_by, approved_at
            from timesheet_weeks where id = \${failed.headerId}
        \`);
        assert.deepEqual(rolledBackHeader.rows[0], {
          status: 'submitted',
          approved_by: null,
          approved_at: null,
        });
        const rolledBackJournals = await db.execute(sql\`
          select count(*)::int as count from journal_entries
           where org_id = \${failed.org.orgId}
             and origin in ('labor_burden', 'overhead_applied')
        \`);
        assert.equal(rolledBackJournals.rows[0].count, 0);
      } finally {
        await db.execute(sql\`drop trigger if exists time_approval_header_fault_trg on timesheet_weeks\`);
        await db.execute(sql\`drop function if exists time_approval_header_fault()\`);
        await db.execute(sql\`delete from time_entries where org_id = \${failed.org.orgId}\`);
        await dropScratchOrg(failed.org.orgId);
      }

      const committed = await seedApprovalFixture('COMMIT');
      try {
        const ids = await approveSubmittedTimeEntries({
          orgId: committed.org.orgId,
          actorId: committed.actorId,
          employeePartyId: committed.employeeId,
          weekStart: '2026-07-12',
        });
        assert.deepEqual(ids, [committed.timeEntryId]);

        const committedEntry = await db.execute(sql\`
          select status, approved_by, approved_at is not null as approved_at,
                 cost_rate::text, labor_cost_rate_id is not null as labor_rate_snapshot,
                 bill_rate::text, bill_rate_source_rate::text,
                 cost_journal_entry_id is not null as labor_journal,
                 overhead_journal_entry_id is not null as overhead_journal
            from time_entries where id = \${committed.timeEntryId}
        \`);
        assert.deepEqual(committedEntry.rows[0], {
          status: 'approved',
          approved_by: committed.actorId,
          approved_at: true,
          cost_rate: '30.0000',
          labor_rate_snapshot: true,
          bill_rate: '125.0000',
          bill_rate_source_rate: '125.0000',
          labor_journal: true,
          overhead_journal: true,
        });
        const committedHeader = await db.execute(sql\`
          select status, approved_by, approved_at is not null as approved_at
            from timesheet_weeks where id = \${committed.headerId}
        \`);
        assert.deepEqual(committedHeader.rows[0], {
          status: 'approved',
          approved_by: committed.actorId,
          approved_at: true,
        });
        const committedJournals = await db.execute(sql\`
          select origin from journal_entries
           where org_id = \${committed.org.orgId}
             and origin in ('labor_burden', 'overhead_applied')
           order by origin
        \`);
        assert.deepEqual(committedJournals.rows, [
          { origin: 'labor_burden' },
          { origin: 'overhead_applied' },
        ]);
      } finally {
        await db.execute(sql\`delete from time_entries where org_id = \${committed.org.orgId}\`);
        await dropScratchOrg(committed.org.orgId);
      }
    `;
    runIntegrationSource(source);
  },
);

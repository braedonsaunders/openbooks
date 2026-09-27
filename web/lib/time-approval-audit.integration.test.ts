import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/platform/db.ts";

// Same child-process harness as time-approval-guards.integration.test.ts:
// web/lib modules import `server-only`, so the approval service runs in a
// child resolved under the react-server condition (trusted integration process only).
function runIntegrationSource(source: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
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
    // The approval pins past the employment guard; without this the audit
    // assertions below would stop at employee_not_found.
    await seedActiveEmployment(org.orgId, employeeId);
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
          allowedSubsidiaryIds: null,
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
               laborCosting: { mode: "post", hoursPerDay: "8", annualHours: "2080", components: [] },
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
            allowedSubsidiaryIds: null,
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

const consolidatedRows = [
  { label: "time amendment", register: async () => {
        const { randomUUID } = await import("node:crypto");
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, seedFlowActors, seedActiveEmployment, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { ScopeNotFoundError } = await import('@openbooks/engine/src/organization/subsidiary-scope.ts')
        const { pinTimesheetEntryEmployee, weekStart } = await import('../app/api/timesheets/_lib.ts')
        const { amendLockedWeek, amendTimeEntry } = await import('./time-amendment')
        const { approveSubmittedTimeEntries } = await import('./time-approval')
        
        /**
         * An amendment is the exact financial negation of the consumed original. It
         * must carry the original's approval-time snapshots (bill rate, cost rate,
         * costing basis, task) so approving it re-derives nothing: today's rate books
         * and wages must not leak into a correction of yesterday's evidence, and an
         * amendment of ESTIMATED time must not post a phantom negative overhead pair.
         */
        test('an amendment carries the original snapshots and approves as an exact contra', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const actor = (await seedFlowActors(org.orgId)).adminId
              const employee = randomUUID(), project = randomUUID(), task = randomUUID(), original = randomUUID()
              // Week of the fixture date (2026-07-15 is a Wednesday; the week starts Sunday 2026-07-12).
              const week = '2026-07-12'
              await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
                overheadApplication: { mode: 'net_zero_pair', accountId: org.accounts.adjustment },
              })}::jsonb where id = ${org.orgId}`)
              // Today's resolvers would produce DIFFERENT numbers than the snapshots:
              // item default 125 vs snapshot 100, wage 50 vs snapshot cost 30.
              await db.execute(sql`update items set default_rate = '125.0000' where org_id = ${org.orgId} and id = ${org.items.service}`)
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
                values (${employee}, ${org.orgId}, 'employee', 'Amended worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
              await seedActiveEmployment(org.orgId, employee)
              await db.execute(sql`insert into labor_cost_rates (id, org_id, employee_party_id, currency, rate, basis, annual_hours, effective_from, is_active)
                values (${randomUUID()}, ${org.orgId}, ${employee}, 'CAD', '50.0000', 'hour', '2080.0000', '2026-01-01', true)`)
              await db.execute(sql`insert into overhead_rates (id, org_id, method, rate_kind, rate_percent, effective_from)
                values (${randomUUID()}, ${org.orgId}, 'standard', 'per_hour', '12.5000', '2026-01-01')`)
              await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
                values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'AMEND', 'Amendment contra', ${org.customerId}, 'active', true, '{}'::jsonb)`)
              await db.execute(sql`insert into project_tasks (id, org_id, project_id, name) values (${task}, ${org.orgId}, ${project}, 'Phase 1')`)
              await db.execute(sql`insert into time_entries
                (id, org_id, employee_party_id, worked_on, hours, item_id, project_id, project_task_id, status, is_billable, memo_is_private,
                 bill_rate, bill_rate_currency, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, costing_basis, payroll_batch_ref, custom, created_by, updated_by)
                values (${original}, ${org.orgId}, ${employee}, ${org.date}, '4.0000', ${org.items.service}, ${project}, ${task}, 'approved', true, true,
                        '100.0000', 'CAD', '30.0000', 'CAD', ${org.subsidiaryId}, 'estimated', 'PAY-2026-07', '{}'::jsonb, ${actor}, ${actor})`)
              await db.execute(sql`insert into timesheet_weeks (id, org_id, employee_party_id, week_start, status, approved_by, approved_at, created_by, updated_by)
                values (${randomUUID()}, ${org.orgId}, ${employee}, ${week}, 'approved', ${actor}, now(), ${actor}, ${actor})`)
        
              const { id: amendment } = await amendTimeEntry(org.orgId, actor, original, null)
              const snapshot = async () => (await db.execute<Record<string, unknown>>(sql`
                select hours::text as hours, bill_rate::text as bill_rate, cost_rate::text as cost_rate, costing_basis,
                       project_task_id, memo_is_private, field_ticket_id, status, overhead_journal_entry_id
                  from time_entries where org_id = ${org.orgId} and id = ${amendment}`)).rows[0]!
              assert.deepEqual(await snapshot(), {
                hours: '-4.0000', bill_rate: '100.0000', cost_rate: '30.0000', costing_basis: 'estimated',
                project_task_id: task, memo_is_private: true, field_ticket_id: null, status: 'draft', overhead_journal_entry_id: null,
              })
        
              // Approve the amendment through the real approval path (snapshots + overhead pair).
              await db.execute(sql`update time_entries set status = 'submitted' where org_id = ${org.orgId} and id = ${amendment}`)
              await db.execute(sql`update timesheet_weeks set status = 'submitted' where org_id = ${org.orgId} and employee_party_id = ${employee} and week_start = ${week}`)
              const approved = await approveSubmittedTimeEntries({ orgId: org.orgId, actorId: actor, employeePartyId: employee, weekStart: week, allowedSubsidiaryIds: null })
              assert.deepEqual(approved, [amendment])
        
              const after = await snapshot()
              assert.equal(after.status, 'approved')
              assert.equal(after.bill_rate, '100.0000', 'approval must not re-price the amendment from today\'s rate book')
              assert.equal(after.cost_rate, '30.0000', 'approval must not re-cost the amendment from today\'s wage')
              assert.equal(after.overhead_journal_entry_id, null, 'estimated time never carries the net-zero overhead pair')
              const net = (await db.execute<{ bill: string; cost: string }>(sql`
                select coalesce(sum(hours * coalesce(bill_rate, 0)), 0)::text as bill, coalesce(sum(hours * coalesce(cost_rate, 0)), 0)::text as cost
                  from time_entries where org_id = ${org.orgId} and id in (${original}, ${amendment})`)).rows[0]!
              assert.deepEqual(net, { bill: '0.00000000', cost: '0.00000000' })
              const overheadJournals = (await db.execute<{ n: number }>(sql`
                select count(*)::int as n from journal_entries where org_id = ${org.orgId} and origin = 'overhead_applied'`)).rows[0]!.n
              assert.equal(overheadJournals, 0)
            } finally {
              await db.execute(sql`delete from time_entries where org_id = ${org.orgId}`)
              await dropScratchOrg(org.orgId)
            }
          })
        })
        
        /**
         * Only approved history may be amended. A contra against a still-editable
         * entry points at a row the weekly save can delete or replace, orphaning the
         * offset into phantom negative hours. Draft, submitted, and rejected entries
         * are corrected by saving, not by amending.
         */
        test('amending an editable entry is refused and writes no offset', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const actor = (await seedFlowActors(org.orgId)).adminId
              const employee = randomUUID(), project = randomUUID()
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
                values (${employee}, ${org.orgId}, 'employee', 'Editable worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
              // Employed: the editable-entry refusal below must prove the amendment
              // rule, not a missing employment.
              await seedActiveEmployment(org.orgId, employee)
              await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
                values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'EDITABLE', 'Editable job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
              await db.execute(sql`insert into timesheet_weeks (id, org_id, employee_party_id, week_start, status, created_by, updated_by)
                values (${randomUUID()}, ${org.orgId}, ${employee}, '2026-07-12', 'draft', ${actor}, ${actor})`)
              for (const status of ['draft', 'submitted', 'rejected']) {
                const entry = randomUUID()
                await db.execute(sql`insert into time_entries
                  (id, org_id, employee_party_id, worked_on, hours, project_id, status, is_billable, custom, created_by, updated_by)
                  values (${entry}, ${org.orgId}, ${employee}, ${org.date}, '8.0000', ${project}, ${status}, true, '{}'::jsonb, ${actor}, ${actor})`)
                await assert.rejects(
                  amendTimeEntry(org.orgId, actor, entry, null),
                  /only an approved entry can be amended/,
                  status,
                )
              }
              const offsets = (await db.execute<{ n: number }>(sql`
                select count(*)::int as n from time_entries
                 where org_id = ${org.orgId} and amends_entry_id is not null`)).rows[0]!.n
              assert.equal(offsets, 0, 'no offset may be written for an editable entry')
            } finally {
              await db.execute(sql`delete from time_entries where org_id = ${org.orgId}`)
              await dropScratchOrg(org.orgId)
            }
          })
        })
        
        test('amending a project-linked entry refuses while Projects is disabled', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const actor = (await seedFlowActors(org.orgId)).adminId
              const employee = randomUUID(), project = randomUUID(), original = randomUUID()
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
                values (${employee}, ${org.orgId}, 'employee', 'Gated worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
              await db.execute(sql`insert into employee_roles (id, org_id, party_id, is_active)
                values (${randomUUID()}, ${org.orgId}, ${employee}, true)`)
              await db.execute(sql`insert into timesheet_weeks (id, org_id, employee_party_id, week_start, status, created_by, updated_by) values (${randomUUID()}, ${org.orgId}, ${employee}, '2026-07-12', 'draft', ${actor}, ${actor})`)
              await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
                values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'GATED', 'Gated job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
              await db.execute(sql`insert into time_entries
                (id, org_id, employee_party_id, worked_on, hours, project_id, status, is_billable, custom, created_by, updated_by)
                values (${original}, ${org.orgId}, ${employee}, ${org.date}, '8.0000', ${project}, 'approved', true, '{}'::jsonb, ${actor}, ${actor})`)
              // The contra would land as a draft project-linked entry — a new
              // Projects disable-blocker — so it must refuse instead.
              await db.execute(sql`update orgs set settings = jsonb_set(settings,'{features,projects}','false'::jsonb) where id = ${org.orgId}`)
              await assert.rejects(
                amendTimeEntry(org.orgId, actor, original, null),
                /Projects feature is disabled/,
              )
              const offsets = (await db.execute<{ n: number }>(sql`
                select count(*)::int as n from time_entries
                 where org_id = ${org.orgId} and amends_entry_id = ${original}`)).rows[0]!.n
              assert.equal(offsets, 0, 'the refused amendment writes no contra entry')
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
        
        test('an amendment rechecks employee scope under the transaction lock', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const actor = (await seedFlowActors(org.orgId)).adminId
              const employee = randomUUID(), original = randomUUID(), subsidiaryB = randomUUID()
              await db.execute(sql`insert into subsidiaries
                (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
                values (${subsidiaryB}, ${org.orgId}, ${org.subsidiaryId}, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`)
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
                values (${employee}, ${org.orgId}, 'employee', 'Scope recheck worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
              await seedActiveEmployment(org.orgId, employee)
              await db.execute(sql`insert into time_entries
                (id, org_id, employee_party_id, worked_on, hours, status, is_billable, custom, created_by, updated_by)
                values (${original}, ${org.orgId}, ${employee}, ${org.date}, '8.0000', 'approved', false, '{}'::jsonb, ${actor}, ${actor})`)
              await db.execute(sql`insert into timesheet_weeks
                (id, org_id, employee_party_id, week_start, status, created_by, updated_by)
                values (${randomUUID()}, ${org.orgId}, ${employee}, ${weekStart(org.date)}, 'approved', ${actor}, ${actor})`)
        
              const allowed = new Set([org.subsidiaryId])
              assert.equal(await pinTimesheetEntryEmployee(org.orgId, original, allowed), employee)
              await db.execute(sql`update parties set subsidiary_id = ${subsidiaryB} where org_id = ${org.orgId} and id = ${employee}`)
              // Every amendment writer must enforce the subject's current subsidiary
              // under its own transaction lock, regardless of which editor path calls it.
              const amendmentWriters = [
                ['entry amendment', () => amendTimeEntry(org.orgId, actor, original, allowed)],
                ['locked-week amendment', () => amendLockedWeek(org.orgId, actor, employee, weekStart(org.date), allowed)],
              ] as const
              for (const [name, write] of amendmentWriters) {
                await assert.rejects(write(), (error: unknown) => error instanceof ScopeNotFoundError, name)
              }
              const offsets = (await db.execute<{ n: number }>(sql`
                select count(*)::int as n from time_entries where org_id = ${org.orgId} and amends_entry_id = ${original}`)).rows[0]!.n
              assert.equal(offsets, 0, 'a rehomed source never produces an out-of-scope contra')
            } finally {
              await db.execute(sql`delete from time_entries where org_id = ${org.orgId}`)
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
] as const;

for (const row of consolidatedRows) await row.register();

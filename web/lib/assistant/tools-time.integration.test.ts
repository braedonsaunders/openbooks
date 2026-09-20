import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';

const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
    }
    return nextResolve(path, context);
  }
  return nextResolve(specifier, context);
} });

const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { executeAssistantTool } = await import('./registry');

function userFor(orgId: string, name: string): SessionUser {
  const userId = randomUUID();
  return {
    id: userId,
    orgId,
    name,
    email: `${name.replaceAll(' ', '.').toLowerCase()}@scratch.test`,
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
}

const TIME_PERMS = ['assistant.use', 'time.read'];
const PROJECT_PERMS = ['assistant.use', 'projects.read'];

async function enableFeature(orgId: string, key: string) {
  await withBypassContext(() => db.execute(sql`
    update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||jsonb_build_object(${key}::text,true))
    where id=${orgId}
  `));
}

/** Employee + submitted week, approved billable project time, and a field ticket. */
async function seedTime(org: { orgId: string; subsidiaryId: string }) {
  const { orgId } = org;
  const rootSubsidiary = org.subsidiaryId;
  const employee = randomUUID();
  const hiddenSubsidiary = randomUUID();
  const hiddenEmployee = randomUUID();
  const project = randomUUID();
  const ticketDoc = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination)
      values (${hiddenSubsidiary},${orgId},${rootSubsidiary},'Hidden time entity','CAD','CA',true,false)
    `);
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom, subsidiary_id)
      values (${employee}, ${orgId}, 'employee', 'Harbour Foreman', true, '{}'::jsonb, ${rootSubsidiary}),
             (${hiddenEmployee}, ${orgId}, 'employee', 'Hidden Worker', true, '{}'::jsonb, ${hiddenSubsidiary})
    `);
    await db.execute(sql`
      insert into projects(id,org_id,name,subsidiary_id,is_active)
      values (${project},${orgId},'Harbourview Tower',${rootSubsidiary},true)
    `);
    await db.execute(sql`
      insert into timesheet_weeks(id,org_id,employee_party_id,week_start,status)
      values (${randomUUID()},${orgId},${employee},'2026-09-13','submitted')
    `);
    await db.execute(sql`
      insert into time_entries(id,org_id,employee_party_id,worked_on,hours,status,is_billable,project_id,billing_status,cost_rate,bill_rate)
      values (${randomUUID()},${orgId},${employee},'2026-09-14','8','submitted',true,${project},'unbilled','50','100'),
             (${randomUUID()},${orgId},${employee},'2026-09-15','8','approved',true,${project},'unbilled','50','100')
    `);
    await db.execute(sql`
      insert into documents(id,org_id,kind,document_number,document_date,currency,total,open_balance,status,subsidiary_id,project_id)
      values (${ticketDoc},${orgId},'field_ticket','FT-1001','2026-09-14','CAD','0','0','draft',${rootSubsidiary},${project})
    `);
    await db.execute(sql`
      insert into field_tickets(document_id,org_id,period,period_start,period_end,foreman_party_id)
      values (${ticketDoc},${orgId},'weekly','2026-09-13','2026-09-19',${employee})
    `);
  });
  return { employee, hiddenEmployee, project, ticketDoc };
}

test('time assistant reads: week, search, project time, unbilled, tickets', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  await enableFeature(org.orgId, 'fieldTickets');
  try {
    const seed = await seedTime(org);
    const timeAuthz = {
      user: userFor(org.orgId, 'Time scope reader'),
      permissions: new Set(TIME_PERMS),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    };
    const projectAuthz = {
      user: userFor(org.orgId, 'Project time reader'),
      permissions: new Set(PROJECT_PERMS),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    };
    await withOrgContext(org.orgId, async () => {
      const week = await executeAssistantTool(timeAuthz, 'get_timesheet_week', {
        employeePartyId: seed.employee,
        week: '2026-09-16',
      });
      assert.equal(week.ok, true, JSON.stringify(week));
      assert.ok(week.ok);
      const weekData = week.data as { status: string; weekTotalHours: number; rows: unknown[] };
      assert.equal(weekData.status, 'submitted');
      assert.equal(weekData.weekTotalHours, 16);

      const hiddenWeek = await executeAssistantTool(timeAuthz, 'get_timesheet_week', {
        employeePartyId: seed.hiddenEmployee,
        week: '2026-09-16',
      });
      assert.deepEqual(hiddenWeek, { ok: false, error: 'employee_not_found' });

      const search = await executeAssistantTool(timeAuthz, 'search_timesheets', { status: 'submitted' });
      assert.equal(search.ok, true, JSON.stringify(search));
      assert.ok(search.ok);
      const searchData = search.data as { totalWeeks: number; totalHours: number };
      assert.equal(searchData.totalWeeks, 1);
      assert.equal(searchData.totalHours, 16);

      const projectTime = await executeAssistantTool(projectAuthz, 'project_time', {
        projectId: seed.project,
        dimension: 'employee',
        dimensionId: seed.employee,
      });
      assert.equal(projectTime.ok, true, JSON.stringify(projectTime));
      assert.ok(projectTime.ok);

      const unbilled = await executeAssistantTool(projectAuthz, 'unbilled_time', { projectId: seed.project });
      assert.equal(unbilled.ok, true, JSON.stringify(unbilled));
      assert.ok(unbilled.ok);
      // One approved 8h line at bill 100 / cost 50 is available to bill.
      assert.deepEqual(unbilled.data, {
        projectId: seed.project,
        revenue: 800,
        cost: 400,
        hours: 8,
        timeEntryCount: 1,
        costLineCount: 0,
        href: '/projects',
      });

      const tickets = await executeAssistantTool(timeAuthz, 'list_field_tickets', {});
      assert.equal(tickets.ok, true, JSON.stringify(tickets));
      assert.ok(tickets.ok);
      assert.equal((tickets.data as { total: number }).total, 1);

      const ticket = await executeAssistantTool(timeAuthz, 'get_field_ticket', { ticketId: seed.ticketDoc });
      assert.equal(ticket.ok, true, JSON.stringify(ticket));
      assert.ok(ticket.ok);
      assert.equal((ticket.data as { ticket: { documentNumber: string } }).ticket.documentNumber, 'FT-1001');
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('time assistant reads isolate orgs and honor the feature flags', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await withBypassContext(() => createScratchOrg());
  const orgB = await withBypassContext(() => createScratchOrg());
  await enableFeature(orgA.orgId, 'fieldTickets');
  try {
    const seedA = await seedTime(orgA);
    const timeAuthzA = {
      user: userFor(orgA.orgId, 'Time org reader'),
      permissions: new Set(TIME_PERMS),
      allowedSubsidiaryIds: null as Set<string> | null,
    };
    await withOrgContext(orgA.orgId, async () => {
      const cross = await executeAssistantTool(
        { ...timeAuthzA, user: { ...timeAuthzA.user, orgId: orgB.orgId } },
        'get_timesheet_week',
        { employeePartyId: seedA.employee, week: '2026-09-16' },
      );
      assert.deepEqual(cross, { ok: false, error: 'employee_not_found' });

      const crossTicket = await executeAssistantTool(
        { ...timeAuthzA, user: { ...timeAuthzA.user, orgId: orgB.orgId } },
        'get_field_ticket',
        { ticketId: seedA.ticketDoc },
      );
      // fieldTickets defaults off: org B has no ticket surface at all.
      assert.deepEqual(crossTicket, { ok: false, error: 'fieldTickets_feature_disabled' });
    });
    await withBypassContext(() => db.execute(sql`
      update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||'{"timeTracking":false}'::jsonb)
      where id=${orgA.orgId}
    `));
    await withOrgContext(orgA.orgId, async () => {
      const off = await executeAssistantTool(timeAuthzA, 'search_timesheets', {});
      assert.deepEqual(off, { ok: false, error: 'timeTracking_feature_disabled' });
    });
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

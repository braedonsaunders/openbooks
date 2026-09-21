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

const EXPENSE_PERMS = ['assistant.use', 'expenses.read'];

async function enableFeature(orgId: string, key: string) {
  await withBypassContext(() => db.execute(sql`
    update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||jsonb_build_object(${key}::text,true))
    where id=${orgId}
  `));
}

/** Draft + pending + posted-reimbursed reports, and one hidden-subsidiary report. */
async function seedExpenses(org: {
  orgId: string; subsidiaryId: string; bookId: string; periodId: string;
  accounts: Record<"ar" | "revenue", string>;
}) {
  const { orgId } = org;
  const rootSubsidiary = org.subsidiaryId;
  const employee = randomUUID();
  const hiddenSubsidiary = randomUUID();
  const hiddenEmployee = randomUUID();
  const hiddenReport = randomUUID();
  const draftReport = randomUUID();
  const pendingReport = randomUUID();
  const postedReport = randomUUID();
  const entry = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination)
    values (${hiddenSubsidiary},${orgId},${rootSubsidiary},'Hidden expense entity','CAD','CA',true,false)
  `));
  await withBypassContext(() => db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom, subsidiary_id)
    values (${employee}, ${orgId}, 'employee', 'Harbour Engineer', true, '{}'::jsonb, ${rootSubsidiary}),
           (${hiddenEmployee}, ${orgId}, 'employee', 'Hidden Spender', true, '{}'::jsonb, ${hiddenSubsidiary})
  `));
  await withBypassContext(() => db.execute(sql`
    insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,open_balance)
    values (${draftReport},${orgId},'expense_report','draft','EXP-1001',${rootSubsidiary},${employee},'2026-09-01','CAD','100','0','100','100'),
           (${pendingReport},${orgId},'expense_report','pending_approval','EXP-1002',${rootSubsidiary},${employee},'2026-09-05','CAD','200','0','200','200'),
           (${postedReport},${orgId},'expense_report','draft','EXP-1003',${rootSubsidiary},${employee},'2026-08-10','CAD','300','0','300','0'),
           (${hiddenReport},${orgId},'expense_report','draft','EXP-1004',${hiddenSubsidiary},${hiddenEmployee},'2026-09-01','CAD','400','0','400','400')
  `));
  // Post EXP-1003 through a real balanced entry so its open balance reads reimbursed.
  await withBypassContext(() => db.execute(sql`
    insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,source_document_id)
    values (${entry},${orgId},${org.bookId},${rootSubsidiary},${entry},'2026-08-10',${org.periodId},'draft',${postedReport})
  `));
  await withBypassContext(() => db.execute(sql`
    insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,party_id,is_open_item)
    values (${randomUUID()},${orgId},${entry},1,${org.accounts.revenue},${rootSubsidiary},'300','CAD','300','1',${employee},false),
           (${randomUUID()},${orgId},${entry},2,${org.accounts.ar},${rootSubsidiary},'-300','CAD','-300','1',${employee},false)
  `));
  await withBypassContext(() => db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`));
  await withBypassContext(() => db.execute(sql`update documents set status = 'approved' where id = ${postedReport}`));
  await withBypassContext(() => db.execute(sql`
    update documents set status = 'posted', posted_entry_id = ${entry}, posting_period_id = ${org.periodId} where id = ${postedReport}
  `));
  return { employee, draftReport, pendingReport, postedReport, hiddenReport };
}

test('expense assistant reads: list, detail, overview, approvals', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  await enableFeature(org.orgId, 'expenses');
  try {
    const seed = await seedExpenses(org);
    const restricted = {
      user: userFor(org.orgId, 'Expense scope reader'),
      permissions: new Set(EXPENSE_PERMS),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    };
    await withOrgContext(org.orgId, async () => {
      const list = await executeAssistantTool(restricted, 'list_expense_reports', {});
      assert.equal(list.ok, true, JSON.stringify(list));
      assert.ok(list.ok);
      const listData = list.data as {
        total: number;
        byStatus: { status: string; count: number; total: number; openBalance: number }[];
      };
      assert.equal(listData.total, 3);
      assert.deepEqual(listData.byStatus, [
        { status: 'draft', currency: 'CAD', count: 1, total: 100, openBalance: 100 },
        { status: 'pending_approval', currency: 'CAD', count: 1, total: 200, openBalance: 200 },
        { status: 'posted', currency: 'CAD', count: 1, total: 300, openBalance: 0 },
      ]);

      const hidden = await executeAssistantTool(restricted, 'get_expense_report', { reportId: seed.hiddenReport });
      assert.deepEqual(hidden, { ok: false, error: 'expense_report_not_found' });

      const detail = await executeAssistantTool(restricted, 'get_expense_report', { reportId: seed.postedReport });
      assert.equal(detail.ok, true, JSON.stringify(detail));
      assert.ok(detail.ok);
      const report = (detail.data as { report: { documentNumber: string; reimbursed: boolean; openBalance: number } }).report;
      assert.equal(report.documentNumber, 'EXP-1003');
      assert.equal(report.reimbursed, true);
      assert.equal(report.openBalance, 0);

      const pending = await executeAssistantTool(restricted, 'get_expense_report', { reportId: seed.pendingReport });
      assert.equal(pending.ok, true, JSON.stringify(pending));
      assert.ok(pending.ok);
      assert.equal((pending.data as { report: { reimbursed: boolean } }).report.reimbursed, false);

      const overview = await executeAssistantTool(restricted, 'expense_overview', {});
      assert.equal(overview.ok, true, JSON.stringify(overview));
      assert.ok(overview.ok);
      const pipeline = (overview.data as { pipeline: { draftCount: number; pendingCount: number } }).pipeline;
      // The hub readout is org-wide like the screen: both drafts count, hidden included.
      assert.equal(pipeline.draftCount, 2);
      assert.equal(pipeline.pendingCount, 1);

      const approvals = await executeAssistantTool(restricted, 'expense_approvals', {});
      assert.equal(approvals.ok, true, JSON.stringify(approvals));
      assert.ok(approvals.ok);
      // No approval doorway: the queue reads empty rather than forbidden.
      assert.deepEqual(approvals.data, { returned: 0, total: 0, approvals: [], href: '/inbox' });
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('expense assistant reads isolate orgs and honor the feature flag', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  await enableFeature(orgA.orgId, 'expenses');
  await enableFeature(orgB.orgId, 'expenses');
  try {
    const seedA = await seedExpenses(orgA);
    const authzA = {
      user: userFor(orgA.orgId, 'Expense org reader'),
      permissions: new Set(EXPENSE_PERMS),
      allowedSubsidiaryIds: null as Set<string> | null,
    };
    await withOrgContext(orgA.orgId, async () => {
      const cross = await executeAssistantTool(
        { ...authzA, user: { ...authzA.user, orgId: orgB.orgId } },
        'get_expense_report',
        { reportId: seedA.draftReport },
      );
      assert.deepEqual(cross, { ok: false, error: 'expense_report_not_found' });
    });
    await withBypassContext(() => db.execute(sql`
      update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||'{"expenses":false}'::jsonb)
      where id=${orgA.orgId}
    `));
    await withOrgContext(orgA.orgId, async () => {
      const off = await executeAssistantTool(authzA, 'list_expense_reports', {});
      assert.deepEqual(off, { ok: false, error: 'expenses_feature_disabled' });
    });
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

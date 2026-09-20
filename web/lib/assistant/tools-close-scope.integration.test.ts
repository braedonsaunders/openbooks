import assert from 'node:assert/strict';
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
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { ensureCloseDefaults } = await import("@openbooks/engine/src/close/defaults.ts");
const { executeAssistantTool } = await import('./registry');

function userFor(orgId: string, userId: string): SessionUser {
  return {
    id: userId,
    orgId,
    name: 'Close reader',
    email: 'close-scope@scratch.test',
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
}

test('close assistant reads return the cockpit state for an org-wide close.read caller', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const defaults = await withOrgContext(org.orgId, () => ensureCloseDefaults(org.orgId, actors.adminId));
    const inserted = (await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into close_runs
        (org_id, period_id, book_id, blueprint_id, reporting_package_id, status,
         current_stage, target_close_date, scope, started_at, started_by, created_by, updated_by)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${defaults.blueprintId},
              ${defaults.reportingPackageId}, 'in_progress', 'review', current_date + 30,
              '{}'::jsonb, now(), ${actors.adminId}, ${actors.adminId}, ${actors.adminId})
      returning id
    `)));
    const runId = inserted.rows[0]!.id;
    await withBypassContext(() => db.execute(sql`
      insert into close_run_tasks
        (org_id, run_id, key, title, workstream, task_type, completion_mode, gate_type, status, sort_order)
      values
        (${org.orgId}, ${runId}, 'reconcile-cash', 'Reconcile cash', 'close', 'checklist', 'manual', 'none', 'done', 1),
        (${org.orgId}, ${runId}, 'accrue-payroll', 'Accrue payroll', 'close', 'checklist', 'manual', 'none', 'open', 2)
    `));
    await withBypassContext(() => db.execute(sql`
      insert into close_exceptions
        (org_id, run_id, code, category, severity, status, title, message)
      values (${org.orgId}, ${runId}, 'UNRECONCILED', 'banking', 'critical', 'open', 'Cash unreconciled', 'One account is out by a dollar')
    `));
    await withBypassContext(() => db.execute(sql`
      insert into close_signoffs (org_id, run_id, signoff_type, decision, signed_by)
      values (${org.orgId}, ${runId}, 'review', 'approved', ${actors.adminId})
    `));
    await withBypassContext(() => db.execute(sql`
      insert into period_locks (org_id, period_id, book_id, module, state, reason)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, 'gl', 'closed', 'scope-fixture')
    `));
    await withBypassContext(() => db.execute(sql`
      insert into close_reopen_requests (org_id, period_id, book_id, modules, reason, requested_by)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, '["gl"]'::jsonb, 'correct a misposting', ${actors.adminId})
    `));
    const authz = {
      user: userFor(org.orgId, actors.adminId),
      permissions: new Set(['assistant.use', 'close.read', 'close.reopen', 'periods.manage']),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(org.orgId, async () => {
      const status = await executeAssistantTool(authz, 'get_close_run_status', { runId });
      assert.equal(status.ok, true, JSON.stringify(status));
      assert.ok(status.ok);
      const data = status.data as {
        status: string; tasksByStatus: Record<string, number>;
        openExceptions: { severity: string }[]; signoffs: { decision: string }[];
        locks: { module: string; state: string; subsidiary: null; reopenExpiresAt: null; reason: string }[]; href: string;
      };
      assert.equal(data.status, 'in_progress');
      assert.deepEqual(data.tasksByStatus, { done: 1, open: 1 });
      assert.equal(data.openExceptions.length, 1);
      assert.equal(data.openExceptions[0]!.severity, 'critical');
      assert.equal(data.signoffs.length, 1);
      assert.equal(data.signoffs[0]!.decision, 'approved');
      assert.equal(data.locks.length, 1);
      assert.equal(data.locks[0]!.module, 'gl');
      assert.equal(data.locks[0]!.state, 'closed');
      assert.equal(data.locks[0]!.subsidiary, null);
      assert.equal(data.locks[0]!.reopenExpiresAt, null);
      assert.equal(data.locks[0]!.reason, 'scope-fixture');
      assert.equal(data.href, `/close?run=${runId}`);

      const locks = await executeAssistantTool(authz, 'list_period_locks', {});
      assert.equal(locks.ok, true, JSON.stringify(locks));
      assert.ok(locks.ok);
      assert.equal((locks.data as { total: number }).total, 1);

      const reopens = await executeAssistantTool(authz, 'list_period_reopen_requests', {});
      assert.equal(reopens.ok, true, JSON.stringify(reopens));
      assert.ok(reopens.ok);
      const reopenData = reopens.data as { total: number; requests: { modules: string[]; status: string }[] };
      assert.equal(reopenData.total, 1);
      assert.deepEqual(reopenData.requests[0]!.modules, ['gl']);
      assert.equal(reopenData.requests[0]!.status, 'requested');
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('close assistant reads fail closed for restricted-subsidiary and unpermitted callers', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const defaults = await withOrgContext(org.orgId, () => ensureCloseDefaults(org.orgId, actors.adminId));
    const inserted = (await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into close_runs
        (org_id, period_id, book_id, blueprint_id, reporting_package_id, status,
         current_stage, target_close_date, scope, started_at, started_by, created_by, updated_by)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${defaults.blueprintId},
              ${defaults.reportingPackageId}, 'in_progress', 'review', current_date + 30,
              '{}'::jsonb, now(), ${actors.adminId}, ${actors.adminId}, ${actors.adminId})
      returning id
    `)));
    const runId = inserted.rows[0]!.id;
    // A restricted-subsidiary caller holds close.read but the cockpit scope
    // rule (guardCloseScope) denies them — the tools must agree.
    const restricted = {
      user: userFor(org.orgId, actors.adminId),
      permissions: new Set(['assistant.use', 'close.read', 'close.reopen', 'periods.manage']),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    };
    // An org-wide caller without the close permission family.
    const unpermitted = {
      user: userFor(org.orgId, actors.adminId),
      permissions: new Set(['assistant.use']),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(org.orgId, async () => {
      for (const caller of [restricted, unpermitted]) {
        assert.deepEqual(await executeAssistantTool(caller, 'get_close_run_status', { runId }), { ok: false, error: 'forbidden' });
        assert.deepEqual(await executeAssistantTool(caller, 'list_period_locks', {}), { ok: false, error: 'forbidden' });
        assert.deepEqual(await executeAssistantTool(caller, 'list_period_reopen_requests', {}), { ok: false, error: 'forbidden' });
      }
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('close run status in another org reads as missing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const first = await withBypassContext(() => createScratchOrg());
  const second = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(first.orgId));
    const defaults = await withOrgContext(first.orgId, () => ensureCloseDefaults(first.orgId, actors.adminId));
    const inserted = (await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into close_runs
        (org_id, period_id, book_id, blueprint_id, reporting_package_id, status,
         current_stage, target_close_date, scope, started_at, started_by, created_by, updated_by)
      values (${first.orgId}, ${first.periodId}, ${first.bookId}, ${defaults.blueprintId},
              ${defaults.reportingPackageId}, 'in_progress', 'review', current_date + 30,
              '{}'::jsonb, now(), ${actors.adminId}, ${actors.adminId}, ${actors.adminId})
      returning id
    `)));
    const runId = inserted.rows[0]!.id;
    const otherActors = await withBypassContext(() => seedFlowActors(second.orgId));
    const authz = {
      user: userFor(second.orgId, otherActors.adminId),
      permissions: new Set(['assistant.use', 'close.read']),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(second.orgId, async () => {
      assert.deepEqual(await executeAssistantTool(authz, 'get_close_run_status', { runId }), { ok: false, error: 'close_run_not_found' });
    });
  } finally {
    await dropScratchOrg(first.orgId);
    await dropScratchOrg(second.orgId);
  }
});

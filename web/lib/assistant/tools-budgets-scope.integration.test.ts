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
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { executeAssistantTool } = await import('./registry');
const { applicationTool, executeApplicationTool } = await import('../application/tool-catalog.ts');
type ApplicationContext = import('../application/context.ts').ApplicationContext;

function userFor(orgId: string, userId: string): SessionUser {
  return {
    id: userId, orgId, name: 'Budget reader', email: 'budget-scope@scratch.test',
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false, envKind: 'production',
    productionOrgId: orgId, homeOrgId: orgId, homeUserId: userId,
  };
}

function appCtx(orgId: string, userId: string, permissions: string[], allowed: Set<string> | null = null): ApplicationContext {
  return {
    authz: { user: userFor(orgId, userId), permissions: new Set(permissions), allowedSubsidiaryIds: allowed },
    source: 'api', requestId: randomUUID(), apiKeyId: null,
  };
}

async function seedScenario(
  orgId: string, bookId: string, subsidiaryId: string, revenueId: string, cogsId: string, periodId: string,
  status = 'draft',
): Promise<string> {
  const id = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${id}, ${orgId}, ${bookId}, 2026, ${`Plan ${status}`}, 'budget', 'draft')
    `);
    if (status !== 'draft') {
      // The scenario guard requires approved scenarios to carry lines, each
      // flip must bump the revision by exactly one, and approval runs through
      // pending_approval (draft -> pending_approval -> approved).
      await seedLines(orgId, id, subsidiaryId, revenueId, cogsId, periodId);
      for (const next of ['pending_approval', status]) {
        await db.execute(sql`update budget_scenarios set status = ${next}, revision = revision + 1 where id = ${id} and org_id = ${orgId}`);
        if (next === status) break;
      }
    }
  });
  return id;
}

async function seedLines(orgId: string, scenarioId: string, subsidiaryId: string, revenueId: string, cogsId: string, periodId: string) {
  await withBypassContext(() => db.execute(sql`
    insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, note)
    values (${orgId}, ${scenarioId}, ${revenueId}, ${periodId}, ${subsidiaryId}, '1000.0000', 'seed revenue'),
           (${orgId}, ${scenarioId}, ${cogsId}, ${periodId}, ${subsidiaryId}, '400.0000', null)
  `));
}

test('budget workspace read reuses the page loader; writes are revision-checked', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const scenarioId = await seedScenario(
      org.orgId, org.bookId, org.subsidiaryId, org.accounts.revenue, org.accounts.cogs, org.periodId,
    );
    await seedLines(org.orgId, scenarioId, org.subsidiaryId, org.accounts.revenue, org.accounts.cogs, org.periodId);
    const reader = {
      user: userFor(org.orgId, actors.adminId),
      permissions: new Set(['assistant.use', 'budgets.read']),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(org.orgId, async () => {
      const workspace = await executeAssistantTool(reader, 'get_budget_workspace', { scenarioId });
      assert.equal(workspace.ok, true, JSON.stringify(workspace));
      assert.ok(workspace.ok);
      const data = workspace.data as {
        scenario: { status: string; revision: number };
        totalAccounts: number; cells: { accountId: string; amount: string }[]; sliceTotal: string;
      };
      assert.equal(data.scenario.status, 'draft');
      assert.equal(data.scenario.revision, 1);
      assert.ok(data.totalAccounts >= 2);
      assert.equal(data.cells.length, 2);
      assert.equal(Number(data.sliceTotal), -600);

      // The governed write bumps the revision and stores exact decimals.
      const writer = appCtx(org.orgId, actors.adminId, ['budgets.manage']);
      const written = await executeApplicationTool(applicationTool('update_budget_cells')!, writer, {
        scenarioId, expectedRevision: 1,
        cells: [
          { accountId: org.accounts.revenue, periodId: org.periodId, amount: '1200.0000', note: 'raised target' },
          { accountId: org.accounts.cogs, periodId: org.periodId, amount: '400.0000' },
        ],
        idempotencyKey: 'a05-budget-write-1',
      }) as { replayed: boolean; result: { revision: number } };
      assert.equal(written.replayed, false);
      assert.equal(written.result.revision, 2);

      // Replaying the exact command replays instead of double-writing.
      const replayed = await executeApplicationTool(applicationTool('update_budget_cells')!, writer, {
        scenarioId, expectedRevision: 1,
        cells: [
          { accountId: org.accounts.revenue, periodId: org.periodId, amount: '1200.0000', note: 'raised target' },
          { accountId: org.accounts.cogs, periodId: org.periodId, amount: '400.0000' },
        ],
        idempotencyKey: 'a05-budget-write-1',
      }) as { replayed: boolean };
      assert.equal(replayed.replayed, true);

      const reread = await executeAssistantTool(reader, 'get_budget_workspace', { scenarioId });
      assert.ok(reread.ok);
      const cells = (reread.data as { cells: { accountId: string; amount: string; note: string | null }[] }).cells;
      assert.equal(cells.find((c) => c.accountId === org.accounts.revenue)?.amount, '1200.0000');
      assert.equal(cells.find((c) => c.accountId === org.accounts.revenue)?.note, 'raised target');

      // A stale revision is refused instead of last-writer-wins.
      await assert.rejects(
        executeApplicationTool(applicationTool('update_budget_cells')!, writer, {
          scenarioId, expectedRevision: 1,
          cells: [{ accountId: org.accounts.revenue, periodId: org.periodId, amount: '1.0000' }],
          idempotencyKey: 'a05-budget-stale-1',
        }),
        /revision_conflict/,
      );
    });

    // A restricted-subsidiary caller reads the same planning cells the page
    // shows (the page applies no subsidiary scoping to budgets).
    const restricted = {
      user: userFor(org.orgId, actors.adminId),
      permissions: new Set(['assistant.use', 'budgets.read', 'budgets.manage']),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    };
    await withOrgContext(org.orgId, async () => {
      const workspace = await executeAssistantTool(restricted, 'get_budget_workspace', { scenarioId });
      assert.equal(workspace.ok, true, JSON.stringify(workspace));
      assert.ok(workspace.ok);
      assert.equal((workspace.data as { cells: unknown[] }).cells.length, 2);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('budget writes refuse locked scenarios, bad scope, and foreign orgs', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const other = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const draftId = await seedScenario(
      org.orgId, org.bookId, org.subsidiaryId, org.accounts.revenue, org.accounts.cogs, org.periodId, 'draft',
    );
    const approvedId = await seedScenario(
      org.orgId, org.bookId, org.subsidiaryId, org.accounts.revenue, org.accounts.cogs, org.periodId, 'approved',
    );
    const stranger = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${stranger}, ${org.orgId}, ${org.subsidiaryId}, 'Stranger Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    `));
    const writer = appCtx(org.orgId, actors.adminId, ['budgets.manage']);
    const cell = { accountId: org.accounts.revenue, periodId: org.periodId, amount: '10.0000' };
    // The tool reads through the pooled handle like the route does: without
    // the request's org scope its feature-flag and root-entity reads deny by
    // default, so run every subject call inside the caller's org boundary.
    const asOrg = (orgId: string, call: () => Promise<unknown>) => withOrgContext(orgId, call);
    // Approved scenarios are locked by the service and its trigger.
    await assert.rejects(
      asOrg(org.orgId, () => executeApplicationTool(applicationTool('update_budget_cells')!, writer, {
        scenarioId: approvedId, expectedRevision: 1, cells: [cell], idempotencyKey: 'a05-budget-locked-1',
      })),
      /budget_is_locked/,
    );
    // No budgets.manage permission.
    await assert.rejects(
      asOrg(org.orgId, () => executeApplicationTool(applicationTool('update_budget_cells')!, appCtx(org.orgId, actors.adminId, []), {
        scenarioId: draftId, expectedRevision: 1, cells: [cell], idempotencyKey: 'a05-budget-noperm-1',
      })),
      /forbidden/,
    );
    // Explicit entity outside the caller's scope.
    await assert.rejects(
      asOrg(org.orgId, () => executeApplicationTool(
        applicationTool('update_budget_cells')!,
        appCtx(org.orgId, actors.adminId, ['budgets.manage'], new Set([stranger])),
        {
          scenarioId: draftId, expectedRevision: 1,
          cells: [{ ...cell, subsidiaryId: org.subsidiaryId }],
          idempotencyKey: 'a05-budget-scope-1',
        },
      )),
      /forbidden/,
    );
    // Omitted entity resolves to the root, which is outside this scope.
    await assert.rejects(
      asOrg(org.orgId, () => executeApplicationTool(
        applicationTool('update_budget_cells')!,
        appCtx(org.orgId, actors.adminId, ['budgets.manage'], new Set([stranger])),
        { scenarioId: draftId, expectedRevision: 1, cells: [cell], idempotencyKey: 'a05-budget-scope-2' },
      )),
      /forbidden/,
    );
    // Another org's scenario reads as missing.
    const otherActors = await withBypassContext(() => seedFlowActors(other.orgId));
    await assert.rejects(
      asOrg(other.orgId, () => executeApplicationTool(
        applicationTool('update_budget_cells')!,
        appCtx(other.orgId, otherActors.adminId, ['budgets.manage']),
        { scenarioId: draftId, expectedRevision: 1, cells: [cell], idempotencyKey: 'a05-budget-cross-1' },
      )),
      /not_found/,
    );
    // Module off matches the routes' fence.
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"budgets":false}'::jsonb, true)
       where id = ${org.orgId}
    `));
    try {
      await assert.rejects(
        asOrg(org.orgId, () => executeApplicationTool(applicationTool('update_budget_cells')!, writer, {
          scenarioId: draftId, expectedRevision: 1, cells: [cell], idempotencyKey: 'a05-budget-off-1',
        })),
        /budget not found/,
      );
      const reader = {
        user: userFor(org.orgId, actors.adminId),
        permissions: new Set(['assistant.use', 'budgets.read']),
        allowedSubsidiaryIds: null,
      };
      await withOrgContext(org.orgId, async () => {
        assert.deepEqual(await executeAssistantTool(reader, 'get_budget_workspace', { scenarioId: draftId }), {
          ok: false, error: 'budgets_feature_disabled',
        });
      });
    } finally {
      await withBypassContext(() => db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"budgets":true}'::jsonb, true)
         where id = ${org.orgId}
      `));
    }
  } finally {
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(other.orgId);
  }
});

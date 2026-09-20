import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';
import type { Authz } from '../authz';

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
const { db, withBypassContext, withOrgContext } = await import('../../../engine/src/platform/db.ts');
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '../../../engine/src/testing/fixtures.ts'
);
const { createDriver, createDriverValue } = await import(
  '../../../engine/src/allocations/driver-admin.ts'
);
const { postProjectGlEntry } = await import('../../../engine/src/projects/recognition.ts');
const { executeAssistantTool } = await import('./registry');

const DB = !!process.env.OPENBOOKS_DB_URL;

// Assistant allocation tools against the real engine: every tool calls the
// same service the Setup screens and API routes call, under the same gates
// (allocations feature + allocations.read, actor subsidiary scope), and the
// preview explains without posting anything to the ledger.

function reader(orgId: string, userId: string, permissions: string[], allowedSubsidiaryIds: Set<string> | null): Authz {
  const user: SessionUser = {
    id: userId,
    orgId,
    name: 'Allocation tools reader',
    email: 'alloc-tools@scratch.test',
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
  return { user, permissions: new Set(permissions), allowedSubsidiaryIds };
}

const FULL = ['assistant.use', 'allocations.read', 'allocations.manage'];

async function enableAllocations(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,allocations}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

interface Seed {
  orgId: string;
  actorId: string;
  ruleId: string;
  versionId: string;
  deptId: string;
  driverId: string;
  periodId: string;
  bookId: string;
  subsidiaryId: string;
  journalCount: number;
}

/** One published period sweep (fixed 100% to a department) over a real posted pool. */
async function seed(): Promise<Seed> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  await withBypassContext(() => enableAllocations(org.orgId));
  const ruleId = randomUUID();
  const versionId = randomUUID();
  const deptId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into allocation_rules (id, org_id, key, name, mode, created_by, updated_by)
      values (${ruleId}, ${org.orgId}, 'tool-sweep', 'Tool sweep', 'period', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into allocation_rule_versions
        (id, org_id, rule_id, version_no, status, effective_from, account_scope, created_by, updated_by)
      values
        (${versionId}, ${org.orgId}, ${ruleId}, 1, 'draft', '2020-01-01',
         ${JSON.stringify({ kind: 'accounts', accountIds: [org.accounts.adjustment] })}::jsonb,
         ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into departments (id, org_id, name, is_active, custom)
      values (${deptId}, ${org.orgId}, 'Tool Dept', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into allocation_rule_targets
        (id, org_id, version_id, sequence, department_id, fixed_percent, is_remainder, label, custom)
      values (${randomUUID()}, ${org.orgId}, ${versionId}, 1, ${deptId}, '100.0000', false, 'Tool Dept', '{}'::jsonb)`);
    await db.execute(sql`
      update allocation_rule_versions
         set status = 'published', definition_hash = 'hash-tool', published_at = now()
       where id = ${versionId} and org_id = ${org.orgId}`);
    await db.execute(sql`
      update allocation_rules set current_version_id = ${versionId}
       where id = ${ruleId} and org_id = ${org.orgId}`);
  });
  const driver = await withOrgContext(org.orgId, () =>
    createDriver(org.orgId, actorId, {
      key: 'tool-manual',
      name: 'Tool manual',
      dimension: 'department',
      sourceKind: 'manual',
    }));
  await withOrgContext(org.orgId, () =>
    createDriverValue(org.orgId, actorId, driver.id, {
      dimensionValueId: deptId,
      effectiveFrom: '2020-01-01',
      value: '3.0000',
    }));
  await withOrgContext(org.orgId, () => postProjectGlEntry({
    orgId: org.orgId,
    actorId,
    origin: 'manual',
    entryNumber: `TOOL-SEED-${randomUUID()}`,
    postingDate: org.date,
    memo: 'Tool sweep pool',
    subsidiaryId: org.subsidiaryId,
    currency: 'CAD',
    lines: [
      { accountId: org.accounts.adjustment, amount: '100.0000' },
      { accountId: org.accounts.bank, amount: '-100.0000' },
    ],
  }));
  const journals = await withOrgContext(org.orgId, () => db.execute<{ n: string }>(sql`
    select count(*) as n from journal_entries where org_id = ${org.orgId}`));
  return {
    orgId: org.orgId, actorId, ruleId, versionId, deptId, driverId: driver.id,
    periodId: org.periodId, bookId: org.bookId, subsidiaryId: org.subsidiaryId,
    journalCount: Number(journals.rows[0]?.n ?? 0),
  };
}

async function journalCount(orgId: string): Promise<number> {
  const rows = await withOrgContext(orgId, () => db.execute<{ n: string }>(sql`
    select count(*) as n from journal_entries where org_id = ${orgId}`));
  return Number(rows.rows[0]?.n ?? 0);
}

test('feature-off hides every allocation tool', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const userId = randomUUID();
  try {
    await withOrgContext(org.orgId, async () => {
      const authz = reader(org.orgId, userId, FULL, null);
      for (const [name, args] of [
        ['list_allocation_rules', {}],
        ['get_allocation_rule', { ruleId: randomUUID() }],
        ['list_allocation_drivers', {}],
        ['preview_driver_vector', { driverId: randomUUID(), period: 'this_fiscal_year_to_date' }],
        ['preview_allocation', { ruleId: randomUUID(), period: 'this_fiscal_year_to_date' }],
        ['list_allocation_runs', {}],
        ['explain_allocation', { journalEntryId: randomUUID() }],
      ] as const) {
        assert.deepEqual(await executeAssistantTool(authz, name, args), {
          ok: false, error: 'allocations_feature_disabled',
        }, name);
      }
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('rules read: list, get by key and id, stable addressing errors', { skip: !DB }, async () => {
  const s = await seed();
  try {
    await withOrgContext(s.orgId, async () => {
      const authz = reader(s.orgId, s.actorId, FULL, null);
      const listed = await executeAssistantTool(authz, 'list_allocation_rules', { mode: 'period' });
      assert.equal(listed.ok, true, JSON.stringify(listed));
      const rules = (listed.data as { rules: { key: string; mode: string; currentVersion: unknown }[] }).rules;
      assert.ok(rules.some((rule) => rule.key === 'tool-sweep' && rule.mode === 'period'));
      assert.ok(rules.every((rule) => rule.currentVersion !== undefined));

      const byKey = await executeAssistantTool(authz, 'get_allocation_rule', { ruleKey: 'tool-sweep' });
      assert.equal(byKey.ok, true, JSON.stringify(byKey));
      const detail = byKey.data as {
        rule: { id: string; key: string };
        currentVersion: { targets: { label: string | null }[]; targetTotal: number } | null;
        timeline: { versionNo: number; status: string }[];
      };
      assert.equal(detail.rule.id, s.ruleId);
      assert.equal(detail.currentVersion?.targetTotal, 1);
      assert.equal(detail.currentVersion?.targets[0]?.label, 'Tool Dept');
      assert.deepEqual(detail.timeline.map((entry) => entry.versionNo), [1]);

      const byId = await executeAssistantTool(authz, 'get_allocation_rule', { ruleId: s.ruleId });
      assert.equal(byId.ok, true, JSON.stringify(byId));
      assert.equal((byId.data as typeof detail).rule.key, 'tool-sweep');

      assert.deepEqual(await executeAssistantTool(authz, 'get_allocation_rule', { ruleKey: 'missing' }), {
        ok: false, error: 'allocation_rule_not_found',
      });
      assert.deepEqual(await executeAssistantTool(authz, 'get_allocation_rule', { ruleId: randomUUID() }), {
        ok: false, error: 'allocation_rule_not_found',
      });
      assert.deepEqual(await executeAssistantTool(authz, 'get_allocation_rule', {}), {
        ok: false, error: 'rule_id_or_key_required',
      });
      assert.deepEqual(
        await executeAssistantTool(authz, 'get_allocation_rule', { ruleId: s.ruleId, ruleKey: 'tool-sweep' }),
        { ok: false, error: 'rule_id_or_key_required' },
      );
    });
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test('drivers read: list gate, manual vector preview by key and period', { skip: !DB }, async () => {
  const s = await seed();
  try {
    await withOrgContext(s.orgId, async () => {
      const authz = reader(s.orgId, s.actorId, FULL, null);
      const listed = await executeAssistantTool(authz, 'list_allocation_drivers', {});
      assert.equal(listed.ok, true, JSON.stringify(listed));
      const drivers = (listed.data as { drivers: { key: string }[] }).drivers;
      assert.ok(drivers.some((driver) => driver.key === 'tool-manual'));

      const noManage = reader(s.orgId, s.actorId, ['assistant.use', 'allocations.read'], null);
      assert.deepEqual(await executeAssistantTool(noManage, 'list_allocation_drivers', { includeInactive: true }), {
        ok: false, error: 'forbidden',
      });

      const preview = await executeAssistantTool(authz, 'preview_driver_vector', {
        driverKey: 'tool-manual', periodId: s.periodId,
      });
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const vector = preview.data as {
        driver: { key: string }; total: string;
        vector: { id: string; label: string; value: string; share: string }[];
        truncated: boolean;
      };
      assert.equal(vector.driver.key, 'tool-manual');
      assert.equal(vector.truncated, false);
      assert.equal(vector.vector.length, 1);
      assert.equal(vector.vector[0]?.id, s.deptId);
      assert.equal(vector.vector[0]?.label, 'Tool Dept');
      assert.equal(vector.vector[0]?.value, '3.0000');
      assert.equal(vector.vector[0]?.share, '1.0000');
      assert.equal(vector.total, '3.0000');

      assert.deepEqual(await executeAssistantTool(authz, 'preview_driver_vector', {
        driverKey: 'missing', periodId: s.periodId,
      }), { ok: false, error: 'allocation_driver_not_found' });
      assert.deepEqual(await executeAssistantTool(authz, 'preview_driver_vector', { driverKey: 'tool-manual' }), {
        ok: false, error: 'period_id_or_preset_required',
      });
    });
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test('preview explains the sweep without posting to the ledger', { skip: !DB }, async () => {
  const s = await seed();
  try {
    await withOrgContext(s.orgId, async () => {
      const authz = reader(s.orgId, s.actorId, FULL, null);
      const before = await journalCount(s.orgId);
      assert.equal(before, s.journalCount);
      const preview = await executeAssistantTool(authz, 'preview_allocation', {
        ruleKey: 'tool-sweep', periodId: s.periodId,
      });
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const run = preview.data as {
        runId: string; status: string; sourceTotal: string; allocatedTotal: string; residual: string;
        sources: { amount: string }[]; targets: { amount: string; share: string }[]; lines: unknown[];
        note: string;
      };
      assert.equal(run.status, 'previewed');
      assert.equal(run.sourceTotal, run.allocatedTotal);
      assert.equal(run.residual, '0.0000');
      assert.ok(run.sources.length >= 1);
      assert.equal(run.targets.length, 1);
      assert.equal(run.targets[0]?.amount, run.sourceTotal);
      assert.equal(run.targets[0]?.share, '1.0000000000');
      assert.ok(run.lines.length >= 1);
      assert.match(run.note, /nothing was posted/);
      assert.equal(await journalCount(s.orgId), before);

      // The stored preview is listed and explainable by its run anchor.
      const runs = await executeAssistantTool(authz, 'list_allocation_runs', { ruleId: s.ruleId });
      assert.equal(runs.ok, true, JSON.stringify(runs));
      const body = runs.data as { total: number; runs: { id: string; status: string }[] };
      assert.equal(body.total, 1);
      assert.equal(body.runs[0]?.id, run.runId);

      const explained = await executeAssistantTool(authz, 'explain_allocation', { runId: run.runId });
      assert.equal(explained.ok, true, JSON.stringify(explained));
      assert.deepEqual((explained.data as { anchor: unknown }).anchor, { kind: 'run', id: run.runId });

      // Addressing failures stay stable tool errors, never throws.
      assert.deepEqual(await executeAssistantTool(authz, 'preview_allocation', {
        ruleKey: 'missing', periodId: s.periodId,
      }), { ok: false, error: 'allocation_rule_not_found' });
      assert.deepEqual(await executeAssistantTool(authz, 'explain_allocation', {}), {
        ok: false, error: 'provide exactly one of runId, journalEntryId, documentId',
      });
      assert.deepEqual(await executeAssistantTool(authz, 'explain_allocation', {
        runId: run.runId, journalEntryId: randomUUID(),
      }), { ok: false, error: 'provide exactly one of runId, journalEntryId, documentId' });
    });
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test('restricted callers only see runs inside their subsidiary scope', { skip: !DB }, async () => {
  const s = await seed();
  try {
    await withOrgContext(s.orgId, async () => {
      const full = reader(s.orgId, s.actorId, FULL, null);
      const preview = await executeAssistantTool(full, 'preview_allocation', {
        ruleKey: 'tool-sweep', periodId: s.periodId, subsidiaryId: s.subsidiaryId,
      });
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const runId = (preview.data as { runId: string }).runId;

      const inside = reader(s.orgId, s.actorId, FULL, new Set([s.subsidiaryId]));
      const seen = await executeAssistantTool(inside, 'list_allocation_runs', {});
      assert.equal(seen.ok, true, JSON.stringify(seen));
      assert.equal((seen.data as { total: number }).total, 1);
      const explained = await executeAssistantTool(inside, 'explain_allocation', { runId });
      assert.equal(explained.ok, true, JSON.stringify(explained));

      const outside = reader(s.orgId, s.actorId, FULL, new Set());
      const hidden = await executeAssistantTool(outside, 'list_allocation_runs', {});
      assert.equal(hidden.ok, true, JSON.stringify(hidden));
      assert.equal((hidden.data as { total: number }).total, 0);
      assert.deepEqual(await executeAssistantTool(outside, 'explain_allocation', { runId }), {
        ok: false, error: 'allocation_run_not_found',
      });
      // Pinning a subsidiary outside the caller's scope is refused.
      assert.deepEqual(await executeAssistantTool(outside, 'preview_allocation', {
        ruleKey: 'tool-sweep', periodId: s.periodId, subsidiaryId: s.subsidiaryId,
      }), { ok: false, error: 'forbidden' });
    });
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

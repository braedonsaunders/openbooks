import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from './auth';

// Agent-pack visibility (b06): continuous_close_findings narrows to the
// caller's readable packs and never leaks across orgs. Fixture mirrors
// open-items-scope.integration (stubbed server-only/auth, scratch orgs).
// NOTE: only accounting|finance rows are seeded — the ai_work_items storage
// CHECK still rejects newer pack keys until the widening migration lands, so
// new-pack visibility is pinned by continuous-close-agents.test.ts until then.
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __b06AgentsScope: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__b06AgentsScope.user}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { getAuthz } = await import('./authz');
const { executeAssistantTool } = await import('./assistant/registry');
const { applyFindingAnalyses } = await import('./assistant/continuous-close-agent');

async function seedFinding(orgId: string, agentKey: string, fingerprint: string): Promise<string> {
  return withBypassContext(async () => {
  const id = randomUUID();
  await db.execute(sql`insert into ai_work_items
    (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, confidence, materiality, summary)
    values (${id}, ${orgId}, ${agentKey}, 'unmatched_bank_activity', 'test', ${fingerprint}, 'warning', '0.9', '1500', '{}'::jsonb)`);
  return id;
  });
}

async function asUser(orgId: string, name: string, roleKey: string, perms: string[]): Promise<void> {
  return withBypassContext(async () => {
  const actor = await createScratchUser(orgId, name, roleKey);
  await db.execute(sql`update app_roles set permissions=${JSON.stringify(perms)}::jsonb where org_id=${orgId} and key=${roleKey}`);
  state.user = { id: actor, orgId, name, email: `${roleKey}@scratch.test`, roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor };
  });
}

test('agent findings stay inside the caller org', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await withBypassContext(() => createScratchOrg());
  const orgB = await withBypassContext(() => createScratchOrg());
  try {
    await seedFinding(orgA.orgId, 'accounting', 'fp-a-1');
    await seedFinding(orgB.orgId, 'accounting', 'fp-b-1');
    await asUser(orgB.orgId, 'Org B reader', 'b06_reader', ['assistant.use', 'gl.read']);
    await withOrgContext(orgB.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      const res = await executeAssistantTool(authz, 'continuous_close_findings', {});
      assert.equal(res.ok, true);
      const data = (res as { ok: true; data: { items: unknown[] } }).data;
      assert.equal(data.items.length, 1, 'org B reader sees only the org B finding');
    });
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

test('agent findings narrow to the caller readable packs', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const findingId = await seedFinding(org.orgId, 'accounting', 'fp-narrow-1');
    // AR clerk: assistant doorway open and the collections pack readable, but
    // no collections rows are seeded (the storage CHECK still rejects newer
    // pack keys) — the list is empty and the accounting finding stays closed.
    await asUser(org.orgId, 'AR clerk', 'b06_ar_clerk', ['assistant.use', 'ar.read']);
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      const list = await executeAssistantTool(authz, 'continuous_close_findings', {});
      assert.equal(list.ok, true);
      assert.equal((list as { ok: true; data: { items: unknown[] } }).data.items.length, 0);
      const one = await executeAssistantTool(authz, 'get_continuous_close_finding', { findingId });
      assert.equal(one.ok, false, 'AR clerk cannot open the accounting finding');
    });
    // Ledger reader: gl.read opens the accounting pack in both tools.
    await asUser(org.orgId, 'Ledger reader', 'b06_gl_reader', ['assistant.use', 'gl.read']);
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      const list = await executeAssistantTool(authz, 'continuous_close_findings', {});
      assert.equal(list.ok, true);
      assert.equal((list as { ok: true; data: { items: unknown[] } }).data.items.length, 1);
      const one = await executeAssistantTool(authz, 'get_continuous_close_finding', { findingId });
      assert.equal(one.ok, true);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('a superseded enrichment analysis is reported, never counted as applied', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // The overlap defect's silent half: the first enrichment's work-item UPDATE
  // matched zero rows (the fingerprint had moved on under a second run) and
  // the analysis was discarded while counted as applied. Each UPDATE must
  // check its affected row count: a lost update lands in
  // supersededFindingIds, leaves the stored summary untouched, and is never
  // counted in applied.
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const runA = randomUUID();
    const runB = randomUUID();
    await withBypassContext(async () => {
      for (const runId of [runA, runB]) {
        await db.execute(sql`insert into ai_agent_runs
          (id, org_id, agent_key, trigger, status, detector_version)
          values (${runId}, ${org.orgId}, 'accounting', 'manual', 'completed', 'test')`);
      }
      await db.execute(sql`insert into ai_work_items
        (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, confidence, materiality, summary, last_detected_run_id)
        values (${randomUUID()}, ${org.orgId}, 'accounting', 'unmatched_bank_activity', 'test',
                'fp-superseded-1', 'warning', '0.9', '1500', '{}'::jsonb, ${runA})`);
    });
    const found = await withBypassContext(async () =>
      await db.execute<{ id: string }>(sql`select id from ai_work_items
         where org_id = ${org.orgId} and fingerprint = 'fp-superseded-1'`));
    const findingId = found.rows[0]!.id;
    const analysis = {
      findingId,
      headline: 'stale analysis',
      explanation: '',
      rootCauses: [],
      recommendations: [],
      citations: [],
    };

    // runB's analysis targets a finding runA owns: zero rows, reported loss.
    const stale = await withOrgContext(org.orgId, () => applyFindingAnalyses(org.orgId, runB, [analysis]));
    assert.equal(stale.applied, 0, 'a zero-row write is never counted as applied');
    assert.deepEqual(stale.supersededFindingIds, [findingId], 'the lost update is reported by id');

    const stored = await withBypassContext(async () =>
      await db.execute<{ summary: Record<string, unknown> }>(sql`select summary from ai_work_items
         where id = ${findingId}`));
    const summary = stored.rows[0]!.summary;
    assert.equal('aiAnalysis' in summary, false, 'the lost update wrote nothing');

    // The owning run's analysis still applies exactly once.
    const fresh = await withOrgContext(org.orgId, () => applyFindingAnalyses(org.orgId, runA, [analysis]));
    assert.equal(fresh.applied, 1);
    assert.deepEqual(fresh.supersededFindingIds, []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('pack readers the workbench admits keep their assistant doorway (payroll)', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const findingId = await seedFinding(org.orgId, 'payroll', 'fp-payroll-1');
    // Payroll clerk: payroll.read makes the payroll pack workbench-readable
    // (AGENT_READ_PERMS), so the assistant finding tools must admit the
    // doorway too and narrow to the payroll pack inside execute.
    await asUser(org.orgId, 'Payroll clerk', 'b06_payroll_clerk', ['assistant.use', 'payroll.read']);
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      const list = await executeAssistantTool(authz, 'continuous_close_findings', {});
      assert.equal(list.ok, true, 'payroll clerk passes the findings doorway');
      assert.equal((list as { ok: true; data: { items: unknown[] } }).data.items.length, 1);
      const one = await executeAssistantTool(authz, 'get_continuous_close_finding', { findingId });
      assert.equal(one.ok, true, 'payroll clerk opens the payroll finding');
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

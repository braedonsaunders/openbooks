import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../../../lib/auth';

// Findings list-source proofs (c01): the sort/dir contract the workbench
// table binds to — rank default, column sorts both directions, stable paging,
// tenant isolation, and the URL parse feeding the read model end to end.
// Same stubbed harness as the agents home loader test.
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __c01FindingsSort: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return (key, values)=>values && typeof values.count === 'number' ? `${values.count} records` : key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__c01FindingsSort.user}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { getAuthz } = await import('../../../lib/authz');
const { loadAgentInbox } = await import('../../../lib/agents/inbox');
const { parseAgentFindingsParams } = await import('../../../lib/list/agent-findings');
const { dateTime } = await import('../../../lib/format');
const { loadAgents, agentsSpec } = await import('./view');

const FIRST = new Date(Date.now() - 10 * 86_400_000).toISOString();
const T1 = new Date(Date.now() - 3 * 86_400_000).toISOString();
const T2 = new Date(Date.now() - 2 * 86_400_000).toISOString();
const T3 = new Date(Date.now() - 1 * 86_400_000).toISOString();

async function seedFinding(orgId: string, row: { materiality: string; severity: string; lastDetected: string; dueAt?: string }): Promise<string> {
  const id = randomUUID();
  // Fixture seeding runs under bypass (exactly what the pooled fixture path
  // does): the shared cluster enforces RLS and CI's superuser role hides it.
  await withBypassContext(() => db.execute(sql`insert into ai_work_items
    (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, status,
     confidence, materiality, summary, first_detected_at, last_detected_at, due_at)
    values (${id}, ${orgId}, 'accounting', 'unmatched_bank_activity', 'test', ${`fp-${id}`},
      ${row.severity}, 'open', '1', ${row.materiality}, '{}'::jsonb,
      ${FIRST}::timestamptz, ${row.lastDetected}::timestamptz,
      ${row.dueAt ?? null}::timestamptz)`));
  return id;
}

async function asReader(orgId: string) {
  const actor = await withBypassContext(async () => {
    const id = await createScratchUser(orgId, 'Reader', 'c01_sort_reader');
    await db.execute(sql`update app_roles set permissions=${JSON.stringify(['assistant.use', 'gl.read'])}::jsonb where org_id=${orgId} and key='c01_sort_reader'`);
    return id;
  });
  state.user = { id: actor, orgId, name: 'Reader', email: 'c01sort@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor };
}

test('findings sort by rank, columns, and page deterministically', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const other = await withBypassContext(() => createScratchOrg());
  try {
    // Same age factor for all three, so rank == materiality order (A > C > B).
    const aId = await seedFinding(org.orgId, { materiality: '5000', severity: 'info', lastDetected: T1 });
    const bId = await seedFinding(org.orgId, { materiality: '1000', severity: 'critical', lastDetected: T3 });
    const cId = await seedFinding(org.orgId, { materiality: '2000', severity: 'warning', lastDetected: T2 });
    await seedFinding(other.orgId, { materiality: '999999', severity: 'critical', lastDetected: T3 });
    await asReader(org.orgId);
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

      assert.deepEqual(ids((await loadAgentInbox(authz, {})).rows), [aId, cId, bId], 'default is rank desc');
      assert.deepEqual(ids((await loadAgentInbox(authz, { sort: 'rank', dir: 'asc' })).rows), [bId, cId, aId]);
      assert.deepEqual(ids((await loadAgentInbox(authz, { sort: 'detected', dir: 'desc' })).rows), [bId, cId, aId]);
      assert.deepEqual(ids((await loadAgentInbox(authz, { sort: 'detected', dir: 'asc' })).rows), [aId, cId, bId]);
      assert.deepEqual(ids((await loadAgentInbox(authz, { sort: 'materiality', dir: 'desc' })).rows), [aId, cId, bId]);
      assert.deepEqual(ids((await loadAgentInbox(authz, { sort: 'materiality', dir: 'asc' })).rows), [bId, cId, aId]);
      assert.deepEqual(ids((await loadAgentInbox(authz, { sort: 'severity', dir: 'desc' })).rows), [bId, cId, aId]);
      assert.deepEqual(ids((await loadAgentInbox(authz, { sort: 'severity', dir: 'asc' })).rows), [aId, cId, bId]);
      assert.deepEqual(
        ids((await loadAgentInbox(authz, { sort: 'nope' as never, dir: 'sideways' as never })).rows),
        [aId, cId, bId],
        'unknown sort/dir fall back to rank desc',
      );

      // Stable paging over the rank order; the other org never leaks in.
      const page = await loadAgentInbox(authz, { limit: 2, offset: 1 });
      assert.equal(page.total, 3);
      assert.deepEqual(ids(page.rows), [cId, bId]);

      // The URL contract feeds the read model end to end.
      const parsed = parseAgentFindingsParams({ sort: 'severity', dir: 'asc' });
      assert.deepEqual(ids((await loadAgentInbox(authz, parsed.filters)).rows), [aId, cId, bId]);
    });
  } finally {
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(other.orgId);
  }
});

test('workbench loader serves the list source sort, filters, and row shape', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const moment = Date.now();
    const hourAgo = new Date(moment - 3_600_000).toISOString();
    const threeDaysAgo = new Date(moment - 3 * 86_400_000).toISOString();
    const lowId = await seedFinding(org.orgId, { materiality: '100', severity: 'info', lastDetected: threeDaysAgo });
    const highId = await seedFinding(org.orgId, { materiality: '900', severity: 'critical', lastDetected: hourAgo });
    // Past-due while open: feeds the overdue KPI and the due column.
    const lateId = await seedFinding(org.orgId, {
      materiality: '10', severity: 'warning', lastDetected: threeDaysAgo,
      dueAt: new Date(moment - 86_400_000).toISOString(),
    });
    await asReader(org.orgId);
    await withOrgContext(org.orgId, async () => {
      // Rank default: the heavier finding leads.
      const ranked = await loadAgents({});
      assert.deepEqual(ranked.rows.map((r) => r.id), [highId, lowId, lateId]);
      assert.equal(ranked.sort, 'rank');
      assert.equal(ranked.dir, 'desc');
      assert.ok((ranked.rows[0]?.age ?? '').length > 0, 'age renders a relative label');
      assert.equal(ranked.rows[0]?.assigneeLabel, 'assignment.unassigned');
      assert.equal(ranked.rows[0]?.due, '');
      assert.equal(ranked.rows.find((r) => r.id === lateId)?.dueOverdueLabel, 'facets.overdue');
      assert.equal(ranked.rows.find((r) => r.id === lateId)?.due, dateTime(new Date(moment - 86_400_000).toISOString()));
      assert.equal(ranked.rows[0]?.dueOverdueLabel, '');
      assert.deepEqual(ranked.sinceOptions.map((o) => o.value), ['day', 'week']);
      assert.equal(ranked.triageHint, 'triage.hint');
      // Header KPIs: open count, proposals, overdue with the bad tone, and
      // the never label with no runs recorded.
      assert.deepEqual(ranked.kpis.map((k) => k.label), ['kpis.open', 'kpis.proposals', 'kpis.overdue', 'kpis.lastRun']);
      assert.equal(ranked.kpis[0]?.value, '3');
      assert.deepEqual(ranked.kpis[2], { label: 'kpis.overdue', value: '1', tone: 'bad' });
      assert.equal(ranked.kpis[3]?.value, 'kpis.never');
      // Tabs keep their keys with the Activity door out to Setup.
      assert.equal(ranked.tabs.find((tab) => tab.key === 'activity')?.href, '/admin/setup/agents/activity');

      // Column sort through the URL flips the order.
      const byMateriality = await loadAgents({ sort: 'materiality', dir: 'asc' });
      assert.deepEqual(byMateriality.rows.map((r) => r.id), [lateId, lowId, highId]);
      assert.equal(byMateriality.sort, 'materiality');

      // Unknown sort falls back to rank; the since window narrows by age.
      const fallback = await loadAgents({ sort: 'nope' });
      assert.deepEqual(fallback.rows.map((r) => r.id), [highId, lowId, lateId]);
      const day = await loadAgents({ since: 'day' });
      assert.deepEqual(day.rows.map((r) => r.id), [highId]);
      const week = await loadAgents({ since: 'week' });
      assert.equal(week.total, 3);
      const spec = agentsSpec(week);
      JSON.stringify(spec);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

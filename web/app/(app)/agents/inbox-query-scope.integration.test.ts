import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../../../lib/auth';

// F-t11-005: a URL-loaded free-text filter must not zero the KPI tiles —
// tiles keep global (query-independent) scope, the same count the UI-applied
// filter shows. Same stubbed harness as the agents home loader test.
process.env.SESSION_SECRET ??= "b06-lane-test-secret-must-be-32+chars!!!!";

const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __t11QueryTiles: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return (key, values)=>values && typeof values.count === 'number' ? `${values.count} records` : key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__t11QueryTiles.user}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withOrgContext, withBypassContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { loadAgents } = await import('./view');

async function seedFinding(orgId: string, note: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into ai_work_items
    (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, status,
     confidence, materiality, summary, first_detected_at, last_detected_at)
    values (${id}, ${orgId}, 'accounting', 'unmatched_bank_activity', 'test', ${`fp-${id}`},
      'warning', 'open', '1', '1000', ${JSON.stringify({ note })}::jsonb,
      now()::timestamptz, now()::timestamptz)`);
  return id;
}

async function asReader(orgId: string) {
  const actor = await createScratchUser(orgId, 'Reader', 't11_tiles_reader');
  await db.execute(sql`update app_roles set permissions=${JSON.stringify(['assistant.use', 'gl.read'])}::jsonb where org_id=${orgId} and key='t11_tiles_reader'`);
  state.user = { id: actor, orgId, name: 'Reader', email: 't11tiles@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor };
}

test('F-t11-005: URL search filter leaves the KPI tiles at global scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // Scratch bootstrap + fixture seeds run under bypass (cluster-safe fixture
  // path); the loader under test runs org-scoped like production.
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      await seedFinding(org.orgId, 'alpha bravo');
      await seedFinding(org.orgId, 'charlie delta');
      await asReader(org.orgId);
    });
    await withOrgContext(org.orgId, async () => {
      const unfiltered = await loadAgents({});
      assert.equal(unfiltered.total, 2);
      assert.equal(unfiltered.kpis[0]?.value, '2');

      // A query matching nothing filters the rows but must not zero the tiles.
      const filtered = await loadAgents({ q: 'zzz-no-such-finding' });
      assert.equal(filtered.total, 0, 'the query itself filters rows');
      assert.equal(filtered.kpis[0]?.value, '2', 'OPEN FINDINGS tile keeps global scope under q');
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

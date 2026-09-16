import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../../../lib/auth';

// Agents home loader proofs (b06): the page serves the shared inbox snapshot
// with facet options, and the drawer opens from ?item= through the same
// detail loader the JSON endpoint uses. Spec construction is asserted over
// the loader's own output (no hand-built fixture).
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __b06AgentsHome: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return (key, values)=>values && typeof values.count === 'number' ? `${values.count} records` : key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__b06AgentsHome.user}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { loadAgents, agentsSpec } = await import('./view');

async function seedFinding(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into ai_work_items
    (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, confidence, materiality, summary)
    values (${id}, ${orgId}, 'accounting', 'unmatched_bank_activity', 'test', ${`fp-${id}`},
      'warning', '1', '1000', '{}'::jsonb)`);
  return id;
}

async function asUser(orgId: string, name: string, roleKey: string, perms: string[]) {
  const actor = await createScratchUser(orgId, name, roleKey);
  await db.execute(sql`update app_roles set permissions=${JSON.stringify(perms)}::jsonb where org_id=${orgId} and key=${roleKey}`);
  state.user = { id: actor, orgId, name, email: `${roleKey}@scratch.test`, roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor };
}

test('agents home serves the ranked snapshot with facets', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const findingId = await seedFinding(org.orgId);
    await asUser(org.orgId, 'Reader', 'b06_home_reader', ['assistant.use', 'gl.read']);
    await withOrgContext(org.orgId, async () => {
      const data = await loadAgents({});
      assert.equal(data.total, 1);
      assert.equal(data.rows[0]?.id, findingId);
      assert.equal(data.rows[0]?.href, `/agents?item=${findingId}`);
      assert.ok(data.packOptions.some((o) => o.value === 'accounting' && o.count === 1));
      assert.equal(data.triage.rows.length, 1);
      assert.equal(data.triage.canWrite, false);
      assert.equal(data.itemDrawerOpen, false);
      // The spec builds over the loader's own output and serializes (the
      // ModuleView wire format) without throwing.
      const spec = agentsSpec(data);
      assert.equal((spec as { route: string }).route, '/agents');
      JSON.stringify(spec);

      const withDrawer = await loadAgents({ item: findingId });
      assert.equal(withDrawer.itemDrawerOpen, true);
      assert.equal(withDrawer.itemDrawer?.item.id, findingId);
      assert.equal(withDrawer.itemDrawer?.proposal, null, 'reader cannot write, so no card');
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

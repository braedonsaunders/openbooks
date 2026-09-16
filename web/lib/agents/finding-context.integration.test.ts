import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';

// Finding-context handoff proofs (b06): scoped evidence section for a
// readable finding, null for unknown ids and unreadable packs.
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __b06FindingContext: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__b06FindingContext.user}' };
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
const { getAuthz } = await import('../authz');
const { loadFindingContext } = await import('./finding-context');

async function asUser(orgId: string, name: string, roleKey: string, perms: string[]) {
  const actor = await createScratchUser(orgId, name, roleKey);
  await db.execute(sql`update app_roles set permissions=${JSON.stringify(perms)}::jsonb where org_id=${orgId} and key=${roleKey}`);
  state.user = { id: actor, orgId, name, email: `${roleKey}@scratch.test`, roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor };
}

test('finding context is scoped to the readable pack', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const id = randomUUID();
    await db.execute(sql`insert into ai_work_items
      (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, confidence, materiality, summary)
      values (${id}, ${org.orgId}, 'accounting', 'unmatched_bank_activity', 'test', 'fp-ctx-1',
        'warning', '0.8', '2500', '{"accountName":"Bank"}'::jsonb)`);
    await db.execute(sql`insert into ai_work_item_evidence (id, org_id, work_item_id, kind, source_type, source_id, data)
      values (${randomUUID()}, ${org.orgId}, ${id}, 'bank_transaction', 'bank_transaction', ${randomUUID()},
        '{"amount":"2500.00"}'::jsonb)`);
    await asUser(org.orgId, 'Reader', 'b06_ctx_reader', ['assistant.use', 'gl.read']);
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      const context = await loadFindingContext(authz, id);
      assert.ok(context);
      assert.match(context.section, /## Finding context/);
      assert.match(context.section, /untrusted data/);
      assert.match(context.section, /2500/);
      assert.match(context.section, new RegExp(`/agents\\?item=${id}`));
      assert.match(context.section, /bank_transaction/);
      const missing = await loadFindingContext(authz, randomUUID());
      assert.equal(missing, null);
    });
    // AR clerk cannot read the accounting pack: no context, plain turn.
    await asUser(org.orgId, 'AR clerk', 'b06_ctx_ar', ['assistant.use', 'ar.read']);
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      assert.equal(await loadFindingContext(authz, id), null);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

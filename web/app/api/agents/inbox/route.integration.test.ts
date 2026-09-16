import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../../../../lib/auth';

// Workbench JSON API contract (b06): GET /api/agents/inbox is a thin adapter
// over loadAgentInbox and GET item reuses the shared detail loader. Same
// stubbed-session harness as the inbox integration tests; real scratch orgs.
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __b06ApiInbox: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__b06ApiInbox.user}' };
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
const { GET: getInbox } = await import('./route');
const { GET: getItem } = await import('../../continuous-close/items/[id]/route');

async function seedFinding(orgId: string, summary: unknown = {}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into ai_work_items
    (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, confidence, materiality, summary)
    values (${id}, ${orgId}, 'accounting', 'unmatched_bank_activity', 'test', ${`fp-${id}`},
      'warning', '1', '1000', ${JSON.stringify(summary)}::jsonb)`);
  return id;
}

async function asUser(orgId: string, name: string, roleKey: string, perms: string[]) {
  const actor = await createScratchUser(orgId, name, roleKey);
  await db.execute(sql`update app_roles set permissions=${JSON.stringify(perms)}::jsonb where org_id=${orgId} and key=${roleKey}`);
  state.user = { id: actor, orgId, name, email: `${roleKey}@scratch.test`, roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor };
}

const READER = ['assistant.use', 'gl.read'];

test('inbox feed lists, filters, and stays in-org', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  try {
    await seedFinding(orgA.orgId);
    await seedFinding(orgA.orgId, { proposedCommand: { tool: 'x', input: {}, label: 'X' } });
    await seedFinding(orgB.orgId);
    await asUser(orgA.orgId, 'Reader', 'b06_api_reader', READER);
    await withOrgContext(orgA.orgId, async () => {
      const all = await (await getInbox(new Request('https://x/api/agents/inbox'))).json();
      assert.equal(all.ok, true);
      assert.equal(all.total, 2, 'org B finding is invisible through the route');
      const proposed = await (await getInbox(new Request('https://x/api/agents/inbox?hasProposal=true'))).json();
      assert.equal(proposed.total, 1);
      // Unknown packs drop out; malformed paging falls back to defaults.
      const narrowed = await (await getInbox(
        new Request('https://x/api/agents/inbox?packs=collections,nope&limit=bogus'),
      )).json();
      assert.equal(narrowed.ok, true);
      assert.equal(narrowed.total, 0, 'no collections rows seeded');
    });
    // No assistant.use: the doorway refuses.
    await asUser(orgA.orgId, 'NoAI', 'b06_api_noai', ['gl.read']);
    await withOrgContext(orgA.orgId, async () => {
      const res = await getInbox(new Request('https://x/api/agents/inbox'));
      assert.equal(res.status, 403);
    });
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

test('item feed returns the shared detail or fails closed', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  try {
    const mine = await seedFinding(orgA.orgId);
    const theirs = await seedFinding(orgB.orgId);
    await asUser(orgA.orgId, 'Reader', 'b06_api_reader2', READER);
    await withOrgContext(orgA.orgId, async () => {
      const hit = await (await getItem(new Request('https://x/'), { params: Promise.resolve({ id: mine }) })).json();
      assert.equal(hit.ok, true);
      assert.equal(hit.item.id, mine);
      assert.equal(hit.canWrite, false, 'reader lacks assistant.write');
      const cross = await getItem(new Request('https://x/'), { params: Promise.resolve({ id: theirs }) });
      assert.equal(cross.status, 404, 'cross-org item fails closed as not found');
      const bad = await getItem(new Request('https://x/'), { params: Promise.resolve({ id: 'nope' }) });
      assert.equal(bad.status, 400);
    });
    // AR clerk: doorway open, accounting pack unreadable — same 404.
    await asUser(orgA.orgId, 'AR clerk', 'b06_api_ar', ['assistant.use', 'ar.read']);
    await withOrgContext(orgA.orgId, async () => {
      const res = await getItem(new Request('https://x/'), { params: Promise.resolve({ id: mine }) });
      assert.equal(res.status, 404);
    });
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../../../../lib/auth';

// Briefing API contract (b06): the cached narrative is per-day-per-user,
// generation without a configured model refuses honestly, and email needs a
// cached copy first. Same stubbed-session harness; real scratch orgs.
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __b06Briefing: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__b06Briefing.user}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { businessToday } = await import('@openbooks/engine/src/business-date.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { createConversation, appendMessage } = await import('../../../../lib/ai-conversations');
const { getAuthz } = await import('../../../../lib/authz');
const { GET, POST } = await import('./route');

async function asUser(orgId: string, name: string, roleKey: string, perms: string[]) {
  const actor = await createScratchUser(orgId, name, roleKey);
  await db.execute(sql`update app_roles set permissions=${JSON.stringify(perms)}::jsonb where org_id=${orgId} and key=${roleKey}`);
  state.user = { id: actor, orgId, name, email: `${roleKey}@scratch.test`, roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor };
}

const READER = ['assistant.use', 'gl.read'];
const post = (action: unknown) =>
  new Request('https://x/api/agents/briefing', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });

test('briefing cache is per-day-per-user; generation needs AI', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await asUser(org.orgId, 'Reader', 'b06_brief_reader', READER);
    await withOrgContext(org.orgId, async () => {
      const empty = await (await GET()).json();
      assert.equal(empty.ok, true);
      assert.equal(empty.briefing, null, 'no briefing cached yet');
      assert.equal(empty.aiEnabled, false, 'scratch org has no model configured');
      assert.equal(empty.role, 'controller');

      const gen = await POST(post('generate'));
      assert.equal(gen.status, 503, 'no model: honest refusal, not an empty narrative');

      const send = await POST(post('send'));
      assert.equal(send.status, 404, 'nothing cached to email');

      // Seed today's cached copy directly, then a second user.
      const authz = await getAuthz();
      assert.ok(authz);
      const today = await businessToday(org.orgId);
      const conversationId = await createConversation(authz, 'briefing', `briefing ${today}`);
      await appendMessage(authz, {
        conversationId,
        role: 'assistant',
        content: 'Cached briefing text.',
        data: { v: 1, kind: 'briefing', date: today, role: 'controller' },
      });
      const hit = await (await GET()).json();
      assert.equal(hit.briefing?.text, 'Cached briefing text.');
    });
    // A second user in the same org sees none of the first user's cache.
    await asUser(org.orgId, 'Reader2', 'b06_brief_reader2', READER);
    await withOrgContext(org.orgId, async () => {
      const other = await (await GET()).json();
      assert.equal(other.briefing, null, 'briefing cache is per user');
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

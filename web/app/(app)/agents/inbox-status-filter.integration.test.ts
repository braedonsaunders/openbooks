import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../../../lib/auth';

// F-t11-006: triaged findings must stay discoverable — the Status filter
// offers every lifecycle state (not just the open ones), while the default
// inbox still shows actionable (open + in review) findings.
process.env.SESSION_SECRET ??= "b06-lane-test-secret-must-be-32+chars!!!!";

const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __t11StatusFilter: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return (key, values)=>values && typeof values.count === 'number' ? `${values.count} records` : key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__t11StatusFilter.user}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withOrgContext, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { loadAgents } = await import('./view');

async function seedFinding(orgId: string, status: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into ai_work_items
    (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, status,
     confidence, materiality, summary, first_detected_at, last_detected_at)
    values (${id}, ${orgId}, 'accounting', 'unmatched_bank_activity', 'test', ${`fp-${id}`},
      'warning', ${status}, '1', '1000', '{}'::jsonb,
      now()::timestamptz, now()::timestamptz)`);
  return id;
}

async function asReader(orgId: string) {
  const actor = await createScratchUser(orgId, 'Reader', 't11_status_reader');
  await db.execute(sql`update app_roles set permissions=${JSON.stringify(['assistant.use', 'gl.read'])}::jsonb where org_id=${orgId} and key='t11_status_reader'`);
  state.user = { id: actor, orgId, name: 'Reader', email: 't11status@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor };
}

test('F-t11-006: Status filter surfaces resolved and dismissed findings', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // Scratch bootstrap + fixture seeds run under bypass (cluster-safe fixture
  // path); the loader under test runs org-scoped like production.
  const org = await withBypassContext(() => createScratchOrg());
  let openId = '', reviewId = '', resolvedId = '', dismissedId = '';
  try {
    await withBypassContext(async () => {
      openId = await seedFinding(org.orgId, 'open');
      reviewId = await seedFinding(org.orgId, 'in_review');
      resolvedId = await seedFinding(org.orgId, 'resolved');
      dismissedId = await seedFinding(org.orgId, 'dismissed');
      await asReader(org.orgId);
    });
    await withOrgContext(org.orgId, async () => {
      const data = await loadAgents({});
      const byValue = new Map(data.statusOptions.map((o) => [o.value, o.count]));
      assert.deepEqual(
        [...byValue.keys()].sort(),
        ['dismissed', 'in_review', 'open', 'resolved'],
        'every lifecycle state is offered',
      );
      assert.equal(byValue.get('resolved'), 1);
      assert.equal(byValue.get('dismissed'), 1);

      // The default inbox stays actionable: triaged work needs the filter.
      const defaultIds = data.rows.map((r) => r.id).sort();
      assert.deepEqual(defaultIds, [openId, reviewId].sort());

      // …and the filter reaches each triaged state.
      const resolved = await loadAgents({ status: 'resolved' });
      assert.deepEqual(resolved.rows.map((r) => r.id), [resolvedId]);
      const dismissed = await loadAgents({ status: 'dismissed' });
      assert.deepEqual(dismissed.rows.map((r) => r.id), [dismissedId]);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

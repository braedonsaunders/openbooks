import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../../../lib/auth';

// Viewer-bound proposal tokens need the signing secret before the engine env
// snapshot loads (same seam as proposals.test.ts).
process.env.SESSION_SECRET ??= "b06-lane-test-secret-must-be-32+chars!!!!";

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

test('proposals lane resolves viewer-signed cards', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const UID = '11111111-2222-4333-8444-555555555555';
    const goodId = await seedFinding(org.orgId, {
      proposedCommand: {
        tool: 'match_bank_line',
        input: { reconciliationId: UID, statementLineId: UID, journalLineIds: [UID], idempotencyKey: 'b06-lane-01' },
        label: 'Match to entry',
      },
    });
    // Assistant-side tool name: visible in the lane, but with no Apply card.
    const strangeId = await seedFinding(org.orgId, {
      proposedCommand: { tool: 'draft_journal_entry', input: {}, label: 'Draft' },
    });
    await asUser(org.orgId, 'Teller', 'b06_lane_teller', ['assistant.use', 'assistant.write', 'gl.read', 'banking.reconcile']);
    await withOrgContext(org.orgId, async () => {
      const inbox = await loadAgents({});
      assert.equal(inbox.showInbox, true);
      assert.equal(inbox.showLane, false);
      assert.equal(inbox.tabs.find((tab) => tab.key === 'proposals')?.active, false);

      const lane = await loadAgents({ proposals: 'true' });
      assert.equal(lane.showLane, true);
      assert.equal(lane.showInbox, false);
      assert.equal(lane.tabs.find((tab) => tab.key === 'proposals')?.active, true);
      assert.equal(lane.lane.length, 2);
      const good = lane.lane.find((card) => card.id === goodId);
      assert.ok(good?.proposal, 'catalog command resolves to a signed card');
      assert.equal(good?.proposal?.toolName, 'match_bank_line');
      assert.ok(good?.proposal?.confirmToken, 'token minted for this viewer');
      const strange = lane.lane.find((card) => card.id === strangeId);
      assert.ok(strange, 'unresolvable carrier stays visible');
      assert.equal(strange?.proposal, null);
      const spec = agentsSpec(lane);
      JSON.stringify(spec);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

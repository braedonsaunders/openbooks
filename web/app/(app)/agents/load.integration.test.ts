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
const { businessToday } = await import('@openbooks/engine/src/business-date.ts');
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

test('briefing tab serves cache state without the inbox', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await seedFinding(org.orgId);
    await asUser(org.orgId, 'Reader', 'b06_brief_tab', ['assistant.use', 'gl.read']);
    await withOrgContext(org.orgId, async () => {
      const data = await loadAgents({ briefing: 'true' });
      assert.equal(data.showBriefing, true);
      assert.equal(data.showInbox, false);
      assert.equal(data.showProposals, false);
      assert.equal(data.hasBriefing, false, 'nothing cached today');
      assert.equal(data.briefingText, null);
      assert.equal(data.briefingEmpty, true);
      assert.equal(data.briefingActions.aiEnabled, false);
      assert.equal(data.tabs.find((tab) => tab.key === 'briefing')?.active, true);
      const spec = agentsSpec(data);
      JSON.stringify(spec);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('briefing body strips the duplicated title H1 in the loader', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await seedFinding(org.orgId);
    await asUser(org.orgId, 'Reader', 'c01_brief_h1', ['assistant.use', 'gl.read']);
    await withOrgContext(org.orgId, async () => {
      const today = await businessToday(org.orgId);
      // The stub translator returns keys, so the loader title is the key
      // itself — the cached H1 matches it exactly and must strip.
      const conv = await db.execute<{ id: string }>(sql`insert into ai_conversations
        (org_id, user_id, scope, title, created_by, updated_by)
        values (${org.orgId}, ${state.user!.id}, 'briefing', ${`briefing ${today}`}, ${state.user!.id}, ${state.user!.id})
        returning id`);
      await db.execute(sql`insert into ai_messages (org_id, conversation_id, role, content, data, created_by, updated_by)
        values (${org.orgId}, ${conv.rows[0]!.id}, 'assistant', ${'# briefing.title\n\nBody line.'},
          '{"kind":"briefing"}', ${state.user!.id}, ${state.user!.id})`);
      const data = await loadAgents({ briefing: 'true' });
      assert.equal(data.hasBriefing, true);
      assert.equal(data.briefingText, 'Body line.');
      assert.equal(data.briefingEmpty, false);
      const spec = agentsSpec(data);
      JSON.stringify(spec);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('proposals tab filters carriers and the drawer resolves governed cards', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
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
    // Assistant-side tool name: visible in the tab, but with no Apply card.
    const strangeId = await seedFinding(org.orgId, {
      proposedCommand: { tool: 'draft_journal_entry', input: {}, label: 'Draft' },
    });
    await asUser(org.orgId, 'Teller', 'b06_lane_teller', ['assistant.use', 'assistant.write', 'gl.read', 'banking.reconcile']);
    await withOrgContext(org.orgId, async () => {
      const inbox = await loadAgents({});
      assert.equal(inbox.showInbox, true);
      assert.equal(inbox.showProposals, false);
      assert.equal(inbox.tabs.find((tab) => tab.key === 'proposals')?.active, false);

      // The tab is the same shared table filtered to carriers — no cards.
      const proposals = await loadAgents({ proposals: 'true' });
      assert.equal(proposals.showProposals, true);
      assert.equal(proposals.showInbox, false);
      assert.equal(proposals.tabs.find((tab) => tab.key === 'proposals')?.active, true);
      assert.equal(proposals.total, 2);
      assert.deepEqual(proposals.rows.map((row) => row.id).sort(), [goodId, strangeId].sort());

      // Each row's drawer resolves the viewer-signed review card in place;
      // the unresolvable carrier stays visible with no card.
      const withDrawer = await loadAgents({ proposals: 'true', item: goodId });
      assert.equal(withDrawer.itemDrawerOpen, true);
      assert.equal(withDrawer.itemDrawer?.proposal?.toolName, 'match_bank_line');
      assert.ok(withDrawer.itemDrawer?.proposal?.confirmToken, 'token minted for this viewer');
      const strangeDrawer = await loadAgents({ proposals: 'true', item: strangeId });
      assert.equal(strangeDrawer.itemDrawerOpen, true);
      assert.equal(strangeDrawer.itemDrawer?.proposal, null);
      const spec = agentsSpec(proposals);
      JSON.stringify(spec);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

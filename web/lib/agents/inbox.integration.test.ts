import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';

// Inbox read-model proofs (b06): ranking, facets, since-filter, tenancy, and
// the doorway. Same stubbed harness as continuous-close-agents.integration.
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __b06Inbox: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__b06Inbox.user}' };
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
const { loadAgentInbox } = await import('./inbox');
const { CONTINUOUS_CLOSE_AGENT_KEYS } = await import('@openbooks/engine/src/continuous-close-config.ts');
const { AGENT_READ_PERMS } = await import('../continuous-close');

async function seedFinding(orgId: string, row: {
  agent?: string; type?: string; severity?: string; status?: string;
  confidence?: string; materiality?: string; summary?: unknown;
  subjectType?: string | null; subjectId?: string | null;
  firstDetected?: string; lastDetected?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into ai_work_items
    (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, status,
     confidence, materiality, subject_type, subject_id, summary, first_detected_at, last_detected_at)
    values (${id}, ${orgId}, ${row.agent ?? 'accounting'}, ${row.type ?? 'unmatched_bank_activity'},
      'test', ${`fp-${id}`}, ${row.severity ?? 'warning'}, ${row.status ?? 'open'},
      ${row.confidence ?? '1'}, ${row.materiality ?? '1000'},
      ${row.subjectType ?? null}, ${row.subjectId ?? null},
      ${JSON.stringify(row.summary ?? {})}::jsonb,
      ${row.firstDetected ?? new Date(Date.now() - 86_400_000).toISOString()}::timestamptz,
      ${row.lastDetected ?? new Date(Date.now() - 86_400_000).toISOString()}::timestamptz)`);
  return id;
}

async function asUser(orgId: string, name: string, roleKey: string, perms: string[]) {
  const actor = await createScratchUser(orgId, name, roleKey);
  await db.execute(sql`update app_roles set permissions=${JSON.stringify(perms)}::jsonb where org_id=${orgId} and key=${roleKey}`);
  state.user = { id: actor, orgId, name, email: `${roleKey}@scratch.test`, roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor };
}

const READER = ['assistant.use', 'gl.read', 'reports.read', 'budgets.read'];

test('inbox ranks stale material findings first and reports facets', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    // Stale but smaller: 10000 × 1.0 × (1 + 60/30) = 30000.
    const staleId = await seedFinding(org.orgId, { materiality: '10000', firstDetected: old });
    // Fresh but larger: 20000 × 1.0 × 1 = 20000.
    const freshId = await seedFinding(org.orgId, { materiality: '20000' });
    // Scratch accounts carry no subsidiary; pin the bank account so the
    // subject-subsidiary facet has a real linkage to resolve.
    await db.execute(sql`update accounts set subsidiary_id = ${org.subsidiaryId} where id = ${org.accounts.bank} and org_id = ${org.orgId}`);
    // Carries a proposal; subject honours the subsidiary facet.
    const proposedId = await seedFinding(org.orgId, {
      agent: 'finance', severity: 'critical', materiality: '500',
      summary: { proposedCommand: { tool: 'match_bank_line', input: {}, label: 'Match' } },
      subjectType: 'account', subjectId: org.accounts.bank,
    });
    await asUser(org.orgId, 'Reader', 'b06_inbox_reader', READER);
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      const inbox = await loadAgentInbox(authz, {});
      assert.equal(inbox.total, 3);
      // stale 10000×(1+60/30)=30000 > fresh 20000×~1 > proposal 500×~1.
      assert.deepEqual(inbox.rows.map((r) => r.id), [staleId, freshId, proposedId]);
      assert.equal(inbox.rows[2]?.hasProposal, true);
      assert.deepEqual(
        inbox.facets.packs.map((f) => [f.key, f.count]).sort(),
        [['accounting', 2], ['finance', 1]],
      );
      assert.equal(inbox.facets.withProposals, 1);
      assert.equal(inbox.facets.severities.find((f) => f.key === 'critical')?.count, 1);
      assert.equal(inbox.facets.subsidiaries.find((f) => f.id === org.subsidiaryId)?.count, 1);
      assert.equal(inbox.facets.unresolvedSubsidiary, 2);
      // Readable packs derive from the registry + grant map, never a
      // hardcoded list: the next pack must not break this test. READER holds
      // gl.read (accounting, hygiene, forensics, tax) and
      // reports.read/budgets.read (finance).
      assert.deepEqual(
        inbox.readablePacks,
        CONTINUOUS_CLOSE_AGENT_KEYS.filter((key) =>
          AGENT_READ_PERMS[key].some((perm) => (READER as readonly string[]).includes(perm)),
        ),
      );
      // Proposal filter narrows to the carrier row.
      const proposed = await loadAgentInbox(authz, { hasProposal: true });
      assert.equal(proposed.total, 1);
      assert.equal(proposed.rows[0]?.hasProposal, true);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('inbox since-filter, tenancy, and doorway', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  try {
    const ancient = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await seedFinding(orgA.orgId, { firstDetected: ancient, lastDetected: ancient });
    const freshId = await seedFinding(orgA.orgId, {
      firstDetected: new Date().toISOString(), lastDetected: new Date().toISOString(),
    });
    await seedFinding(orgB.orgId, {});
    await asUser(orgA.orgId, 'Reader', 'b06_inbox_reader2', READER);
    await withOrgContext(orgA.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      const all = await loadAgentInbox(authz, {});
      assert.equal(all.total, 2, 'org B finding is invisible');
      const changed = await loadAgentInbox(authz, { since: new Date(Date.now() - 86_400_000).toISOString() });
      assert.equal(changed.total, 1);
      assert.equal(changed.rows[0]?.id, freshId);
      // Pack filter intersects the readable set; unknown packs vanish.
      const finance = await loadAgentInbox(authz, { packs: ['finance'] });
      assert.equal(finance.total, 0);
    });
    // No assistant.use: empty inbox, never an error carrier.
    await asUser(orgA.orgId, 'NoAI', 'b06_inbox_noai', ['gl.read']);
    await withOrgContext(orgA.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      const inbox = await loadAgentInbox(authz, {});
      assert.equal(inbox.total, 0);
      assert.deepEqual(inbox.readablePacks, []);
    });
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

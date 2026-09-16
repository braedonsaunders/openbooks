import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';

// Assignment & SLA proofs (b06, migration 0153): user/role assignment with
// due dates, comment threads, inbox assignee facets, and the write doorway.
// Same stubbed harness as inbox.integration.
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __b06Assign: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__b06Assign.user}' };
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
const { addWorkItemNote, listWorkItemNotes, loadWorkItemAssignment, setWorkItemAssignment } = await import('./assignments');
const { loadAgentInbox } = await import('./inbox');

async function seedFinding(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into ai_work_items
    (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, status,
     confidence, materiality, subject_type, subject_id, summary, first_detected_at, last_detected_at)
    values (${id}, ${orgId}, 'accounting', 'unmatched_bank_activity',
      'test', ${`fp-${id}`}, 'warning', 'open',
      '1', '1000', null, null, '{}'::jsonb,
      now() - interval '1 day', now() - interval '1 day')`);
  return id;
}

async function asUser(orgId: string, name: string, roleKey: string, perms: string[]) {
  const actor = await createScratchUser(orgId, name, roleKey) as unknown as string;
  await db.execute(sql`update app_roles set permissions=${JSON.stringify(perms)}::jsonb where org_id=${orgId} and key=${roleKey}`);
  state.user = { id: actor, orgId, name, email: `${roleKey}@scratch.test`, roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor };
  return actor;
}

const WRITER = ['assistant.use', 'assistant.write', 'gl.read'];
const READER = ['assistant.use', 'gl.read'];

type Fallible = { ok: true; id?: string } | { ok: false; error: string };
function err(result: Fallible): string | undefined {
  return result.ok ? undefined : result.error;
}

test('assignment round-trips user, due, overdue, and inbox facets', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const itemId = await seedFinding(org.orgId);
    const me = await asUser(org.orgId, 'Writer', 'b06_assign_writer', WRITER);
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      // Unassigned to start.
      const before = await loadWorkItemAssignment(authz, itemId);
      assert.equal(before?.assigneeUserId, null);
      const future = new Date(Date.now() + 86_400_000).toISOString();
      assert.deepEqual(await setWorkItemAssignment(authz, itemId, { assigneeUserId: me, dueAt: future }), { ok: true });
      const after = await loadWorkItemAssignment(authz, itemId);
      assert.equal(after?.assigneeUserId, me);
      assert.equal(after?.assigneeUserName, 'Writer');
      assert.equal(after?.overdue, false);
      // Inbox surfaces the assignee and the mine/unassigned facets.
      const inbox = await loadAgentInbox(authz, {});
      const row = inbox.rows.find((r) => r.id === itemId);
      assert.deepEqual(row?.assignee, { kind: 'user', id: me, name: 'Writer' });
      assert.equal(inbox.facets.assignedToMe, 1);
      assert.equal(inbox.facets.unassigned, 0);
      assert.equal(inbox.facets.overdue, 0);
      const mine = await loadAgentInbox(authz, { assignedToMe: true });
      assert.equal(mine.total, 1);
      // Past due flips the overdue flag on the row, the loader, and the facet.
      const past = new Date(Date.now() - 86_400_000).toISOString();
      assert.deepEqual(await setWorkItemAssignment(authz, itemId, { assigneeUserId: me, dueAt: past }), { ok: true });
      const late = await loadWorkItemAssignment(authz, itemId);
      assert.equal(late?.overdue, true);
      const overdue = await loadAgentInbox(authz, { overdueOnly: true });
      assert.equal(overdue.total, 1);
      assert.equal(overdue.rows[0]?.overdue, true);
      assert.equal((await loadAgentInbox(authz, {})).facets.overdue, 1);
      // Clearing restores the unassigned bucket.
      assert.deepEqual(
        await setWorkItemAssignment(authz, itemId, { assigneeUserId: null, assigneeRole: null, dueAt: null }),
        { ok: true },
      );
      assert.equal((await loadWorkItemAssignment(authz, itemId))?.assigneeUserId, null);
      assert.equal((await loadAgentInbox(authz, {})).facets.unassigned, 1);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('assignment accepts org roles and rejects strangers', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const itemId = await seedFinding(org.orgId);
    await asUser(org.orgId, 'Writer', 'b06_assign_writer', WRITER);
    const role = await db.execute<{ id: string }>(sql`select id from app_roles where org_id=${org.orgId} and key='b06_assign_writer'`);
    const roleId = String(role.rows[0]?.id);
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      assert.deepEqual(
        await setWorkItemAssignment(authz, itemId, { assigneeRole: roleId }),
        { ok: true },
      );
      const loaded = await loadWorkItemAssignment(authz, itemId);
      assert.equal(loaded?.assigneeRole, roleId);
      assert.ok((loaded?.assigneeRoleName ?? '').length > 0);
      const inbox = await loadAgentInbox(authz, {});
      assert.equal(inbox.rows.find((r) => r.id === itemId)?.assignee?.kind, 'role');
      // Unknown user, unknown role, and garbage due dates all fail closed.
      assert.deepEqual(
        err(await setWorkItemAssignment(authz, itemId, { assigneeUserId: randomUUID() })),
        'invalid_assignee',
      );
      assert.deepEqual(
        err(await setWorkItemAssignment(authz, itemId, { assigneeRole: randomUUID() })),
        'invalid_assignee',
      );
      assert.deepEqual(
        err(await setWorkItemAssignment(authz, itemId, { assigneeUserId: null, dueAt: 'not-a-date' })),
        'invalid_due',
      );
      // Due date without an owner is not an assignment.
      assert.deepEqual(
        err(await setWorkItemAssignment(authz, itemId, { dueAt: new Date().toISOString() })),
        'missing_assignee',
      );
      // Unknown findings and other orgs read as not_found.
      assert.deepEqual(
        err(await setWorkItemAssignment(authz, randomUUID(), { assigneeRole: roleId })),
        'not_found',
      );
      assert.equal(await loadWorkItemAssignment(authz, randomUUID()), null);
    });
    const orgB = await createScratchOrg();
    try {
      await asUser(orgB.orgId, 'Outsider', 'b06_assign_outsider', WRITER);
      await withOrgContext(orgB.orgId, async () => {
        const authz = await getAuthz();
        assert.ok(authz);
        assert.deepEqual(
          err(await setWorkItemAssignment(authz, itemId, { assigneeRole: roleId })),
          'not_found',
        );
        assert.equal(await loadWorkItemAssignment(authz, itemId), null);
        assert.deepEqual(await listWorkItemNotes(authz, itemId), []);
      });
    } finally {
      await dropScratchOrg(orgB.orgId);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('notes thread round-trips and the doorway holds', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const itemId = await seedFinding(org.orgId);
    await asUser(org.orgId, 'Writer', 'b06_assign_writer', WRITER);
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      assert.deepEqual(await listWorkItemNotes(authz, itemId), []);
      const first = await addWorkItemNote(authz, itemId, 'Checking with finance');
      assert.equal(first.ok, true);
      const second = await addWorkItemNote(authz, itemId, 'Confirmed — resolving');
      assert.equal(second.ok, true);
      const notes = await listWorkItemNotes(authz, itemId);
      assert.deepEqual(notes.map((n) => n.body), ['Checking with finance', 'Confirmed — resolving']);
      assert.ok(notes.every((n) => n.userName === 'Writer'));
      assert.deepEqual(err(await addWorkItemNote(authz, itemId, '   ')), 'invalid_body');
      assert.deepEqual(err(await addWorkItemNote(authz, randomUUID(), 'x')), 'not_found');
    });
    // Reader (no assistant.write) can read the thread but cannot write or assign.
    await asUser(org.orgId, 'Reader', 'b06_assign_reader', READER);
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      assert.equal((await listWorkItemNotes(authz, itemId)).length, 2);
      assert.deepEqual(err(await addWorkItemNote(authz, itemId, 'nope')), 'forbidden');
      const me = state.user?.id ?? '';
      assert.deepEqual(
        err(await setWorkItemAssignment(authz, itemId, { assigneeUserId: me })),
        'forbidden',
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

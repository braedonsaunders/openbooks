import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';

const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
    }
    return nextResolve(path, context);
  }
  return nextResolve(specifier, context);
} });

const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/test-fixtures.ts');
const { executeAssistantTool } = await import('./registry');

function userFor(orgId: string, userId: string): SessionUser {
  return {
    id: userId, orgId, name: 'Admin reader', email: 'admin-scope@scratch.test',
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false, envKind: 'production',
    productionOrgId: orgId, homeOrgId: orgId, homeUserId: userId,
  };
}

const ADMIN_PERMS = ['assistant.use', 'admin.users.manage', 'admin.roles.manage', 'api.keys.manage', 'admin.audit.read'];

async function seedAdmin(orgId: string, adminId: string) {
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"apiAccess":true}'::jsonb, true)
     where id = ${orgId}
  `);
  await db.execute(sql`
    insert into api_keys (org_id, user_id, name, key_prefix, key_hash, key_preview, scopes)
    values (${orgId}, ${adminId}, 'Probe key', 'ob_', 'fixture-hash-not-a-secret', 'ab12', '["read"]'::jsonb)
  `);
  const roleId = randomUUID();
  await db.execute(sql`
    insert into app_roles (id, org_id, key, name, description, is_built_in, permissions)
    values (${roleId}, ${orgId}, 'probe-role', 'Probe role', 'scope fixture', false, '["gl.read", "gl.post"]'::jsonb)
  `);
  await db.execute(sql`
    insert into role_assignments (org_id, user_id, role_id)
    values (${orgId}, ${adminId}, ${roleId})
  `);
  const rowId = randomUUID();
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'budget_scenarios', ${rowId}, 'update',
      '{"amount": {"before": "1", "after": "2"}}'::jsonb, ${adminId})
  `);
  await db.execute(sql`
    insert into scheduler_outbox (org_id, kind, subject_id, occurrence_key, status, error, attempt_count, payload)
    values (${orgId}, 'flow_email', ${randomUUID()}, 'probe-1', 'pending', null, 0, '{}'::jsonb),
           (${orgId}, 'flow_email', ${randomUUID()}, 'probe-2', 'failed', 'worker exploded', 3, '{}'::jsonb)
  `);
  return { rowId };
}

test('admin reads mirror the admin pages without leaking secrets', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const { rowId } = await seedAdmin(org.orgId, actors.adminId);
    const authz = {
      user: userFor(org.orgId, actors.adminId),
      permissions: new Set(ADMIN_PERMS),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(org.orgId, async () => {
      const users = await executeAssistantTool(authz, 'list_users', {});
      assert.equal(users.ok, true, JSON.stringify(users));
      assert.ok(users.ok);
      const userRows = (users.data as { total: number; users: { email: string; roles: string[] }[] });
      assert.ok(userRows.total >= 1);
      assert.ok(userRows.users.some((u) => u.roles.length > 0), 'assignments join returns role names');

      const roles = await executeAssistantTool(authz, 'list_roles', {});
      assert.equal(roles.ok, true, JSON.stringify(roles));
      assert.ok(roles.ok);
      const roleRows = (roles.data as { roles: { key: string; permissions: string[]; memberCount: number }[] }).roles;
      const probeRole = roleRows.find((r) => r.key === 'probe-role');
      assert.ok(probeRole, 'custom role listed');
      assert.deepEqual(probeRole.permissions, ['gl.read', 'gl.post']);
      assert.equal(probeRole.memberCount, 1);

      const keys = await executeAssistantTool(authz, 'list_api_keys', {});
      assert.equal(keys.ok, true, JSON.stringify(keys));
      assert.ok(keys.ok);
      const keyData = keys.data as { total: number; keys: Record<string, unknown>[] };
      assert.equal(keyData.total, 1);
      assert.equal(keyData.keys[0]!.keyPreview, 'ab12');
      for (const key of Object.keys(keyData.keys[0]!)) {
        assert.ok(!/hash|secret/i.test(key), `no secret-bearing column leaks (${key})`);
      }

      const audit = await executeAssistantTool(authz, 'search_audit_log', { rtype: 'budget_scenarios' });
      assert.equal(audit.ok, true, JSON.stringify(audit));
      assert.ok(audit.ok);
      const auditData = audit.data as {
        total: number;
        events: { rowId: string; recordType: string; changes: { amount: { after: string } } }[];
      };
      assert.equal(auditData.total, 1);
      assert.equal(auditData.events[0]!.rowId, rowId);
      assert.equal(auditData.events[0]!.recordType, 'budget_scenarios');
      assert.equal(auditData.events[0]!.changes.amount.after, '2');

      const outbox = await executeAssistantTool(authz, 'get_outbox_status', {});
      assert.equal(outbox.ok, true, JSON.stringify(outbox));
      assert.ok(outbox.ok);
      const outboxData = outbox.data as {
        scheduler: { byStatus: Record<string, number> };
        recentFailures: Record<string, unknown>[];
      };
      assert.equal(outboxData.scheduler.byStatus.pending, 1);
      assert.equal(outboxData.scheduler.byStatus.failed, 1);
      assert.equal(outboxData.recentFailures.length, 1);
      for (const key of Object.keys(outboxData.recentFailures[0]!)) {
        assert.ok(!/payload|lease_token/i.test(key), `no job payload leaks (${key})`);
      }
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('admin reads enforce their gates, scope, and org boundary', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const other = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await seedAdmin(org.orgId, actors.adminId);
    const full = {
      user: userFor(org.orgId, actors.adminId),
      permissions: new Set(ADMIN_PERMS),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(org.orgId, async () => {
      // Each family refuses without its own manage permission.
      const names = ['list_users', 'list_roles', 'list_api_keys', 'search_audit_log', 'get_outbox_status'];
      for (const name of names) {
        const caller = { ...full, permissions: new Set(['assistant.use']) };
        assert.deepEqual(await executeAssistantTool(caller, name, {}), { ok: false, error: 'forbidden' });
      }
      // The audit log and outboxes require an org-wide caller like the page.
      const restricted = { ...full, allowedSubsidiaryIds: new Set([org.subsidiaryId]) };
      assert.deepEqual(await executeAssistantTool(restricted, 'search_audit_log', {}), { ok: false, error: 'forbidden' });
      assert.deepEqual(await executeAssistantTool(restricted, 'get_outbox_status', {}), { ok: false, error: 'forbidden' });
      // Users/roles/keys pages apply no subsidiary rule, so neither do these.
      assert.equal((await executeAssistantTool(restricted, 'list_users', {})).ok, true);
      // API access off matches the page fence.
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"apiAccess":false}'::jsonb, true)
         where id = ${org.orgId}
      `);
      try {
        assert.deepEqual(await executeAssistantTool(full, 'list_api_keys', {}), {
          ok: false, error: 'api_access_feature_disabled',
        });
      } finally {
        await db.execute(sql`
          update orgs set settings = jsonb_set(settings, '{features}',
            coalesce(settings->'features', '{}'::jsonb) || '{"apiAccess":true}'::jsonb, true)
           where id = ${org.orgId}
        `);
      }
    });
    // Another org sees none of the first org's admin surface.
    const otherActors = await seedFlowActors(other.orgId);
    const otherAuthz = {
      user: userFor(other.orgId, otherActors.adminId),
      permissions: new Set(ADMIN_PERMS),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(other.orgId, async () => {
      // The first org's seeded fixtures must not leak: the filtered audit
      // search is empty and the key directory holds none of its rows.
      const audit = await executeAssistantTool(otherAuthz, 'search_audit_log', { rtype: 'budget_scenarios' });
      assert.equal(audit.ok, true, JSON.stringify(audit));
      assert.ok(audit.ok);
      assert.equal((audit.data as { total: number }).total, 0);
      // apiAccess defaults off, so the fence fires before any row is read.
      const keys = await executeAssistantTool(otherAuthz, 'list_api_keys', {});
      assert.deepEqual(keys, { ok: false, error: 'api_access_feature_disabled' });
    });
  } finally {
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(other.orgId);
  }
});

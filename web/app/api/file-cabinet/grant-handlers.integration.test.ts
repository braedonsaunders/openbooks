import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { env } from '@openbooks/engine/src/db.ts'

/**
 * Live-Postgres coverage for grant isolation and audit atomicity.  The route
 * handler must bind a grant deletion to the resource whose Manager access was
 * checked, and the shared grant verbs must roll their writes back when the
 * required activity row cannot be appended.
 */
test('grant changes are resource-scoped and audit-atomic', { skip: !env.OPENBOOKS_DB_URL }, () => {
  const source = `
    import assert from 'node:assert/strict';
    import { randomUUID } from 'node:crypto';
    import { registerHooks } from 'node:module';
    import { sql } from 'drizzle-orm';
    import { db } from './engine/src/db.ts';
    import { installTrustedTestDatabaseBypass } from './engine/src/test-database-bypass.ts';
    import { createScratchOrg, dropScratchOrg } from './engine/src/test-fixtures.ts';

    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' };
        if (specifier === '../../../lib/authz') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export const can=()=>true; export const getAuthz=async()=>null; export const subsidiaryScopeAllows=()=>true;' };
        return nextResolve(specifier, context);
      },
    });
    const { deleteGrant } = await import('./web/app/api/file-cabinet/grant-handlers.ts');
    const { removeGrant, setGrant } = await import('./web/lib/file-cabinet.ts');
    hooks.deregister();

    installTrustedTestDatabaseBypass();
    const org = await createScratchOrg();
    const actorId = randomUUID();
    const folderA = randomUUID();
    const folderB = randomUUID();
    const principalId = randomUUID();
    try {
      await db.execute(sql\`
        insert into folders (id, org_id, parent_folder_id, name)
        values (\${folderA}, \${org.orgId}, null, 'A'), (\${folderB}, \${org.orgId}, null, 'B')
      \`);
      const grantId = (await db.execute(sql\`
        insert into resource_grants
          (org_id, resource_type, resource_id, principal_type, principal_id, access, created_by, updated_by)
        values (\${org.orgId}, 'folder', \${folderB}, 'user', \${principalId}, 'viewer', \${actorId}, \${actorId})
        returning id
      \`)).rows[0].id;
      const authz = {
        user: { id: actorId, orgId: org.orgId },
        permissions: new Set(['*']),
        allowedSubsidiaryIds: null,
      };

      // The caller is a Manager of A, but the supplied grant belongs to B.
      // The route must refuse it and leave B's grant intact.
      const denied = await deleteGrant(authz, 'folder', folderA, grantId);
      assert.equal(denied.status, 404);
      assert.equal((await db.execute(sql\`select count(*)::int as n from resource_grants where id = \${grantId}\`)).rows[0].n, 1);

      assert.match(org.orgId, /^[0-9a-f-]{36}$/i);
      await db.execute(sql.raw(\`
        create function openbooks_test_block_grant_audit() returns trigger
        language plpgsql as $fn$ begin raise exception 'forced grant audit failure'; end $fn$
      \`));
      await db.execute(sql.raw(\`
        create trigger block_grant_audit before insert on audit_log for each row
        when (new.org_id = '\${org.orgId}'::uuid and new.table_name = 'folders')
        execute function openbooks_test_block_grant_audit()
      \`));

      // A failed share audit rolls back the upsert; no grant is left behind.
      const newGrantPrincipal = randomUUID();
      await assert.rejects(() => setGrant({
        orgId: org.orgId, resourceType: 'folder', resourceId: folderA,
        principalType: 'user', principalId: newGrantPrincipal, access: 'editor', actorId,
        audit: { actorId },
      }), (error) => /forced grant audit failure/.test(String((error && error.cause) || error)));
      assert.equal((await db.execute(sql\`
        select count(*)::int as n from resource_grants
         where org_id = \${org.orgId} and resource_id = \${folderA} and principal_id = \${newGrantPrincipal}
      \`)).rows[0].n, 0);

      // The same trigger proves an unshare audit failure leaves B's grant.
      await assert.rejects(
        () => removeGrant(org.orgId, grantId, 'folder', folderB, { actorId }),
        (error) => /forced grant audit failure/.test(String((error && error.cause) || error)),
      );
      assert.equal((await db.execute(sql\`select count(*)::int as n from resource_grants where id = \${grantId}\`)).rows[0].n, 1);

      await db.execute(sql\`drop trigger block_grant_audit on audit_log\`);
      assert.equal(await removeGrant(org.orgId, grantId, 'folder', folderB, { actorId }), true);
      assert.equal((await db.execute(sql\`select count(*)::int as n from resource_grants where id = \${grantId}\`)).rows[0].n, 0);
    } finally {
      await db.execute(sql\`drop trigger if exists block_grant_audit on audit_log\`);
      await db.execute(sql\`drop function if exists openbooks_test_block_grant_audit()\`);
      await dropScratchOrg(org.orgId);
    }
  `;
  const result = spawnSync(
    process.execPath,
    ['--conditions=react-server', '--import', 'tsx', '--import', './engine/src/test-database-bypass.ts', '--input-type=module', '-e', source],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

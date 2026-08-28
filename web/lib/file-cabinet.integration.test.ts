import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { env } from '@openbooks/engine/src/db.ts'

/**
 * Regression coverage for the purge check/delete race: an attachment that is
 * committed while a purge is in flight must block the purge, never be deleted
 * along with its file.
 */
test('purge serializes against a concurrently committed attachment', { skip: !env.OPENBOOKS_DB_URL }, () => {
  const source = `
    import assert from 'node:assert/strict';
    import { randomUUID } from 'node:crypto';
    import pg from 'pg';
    import { sql } from 'drizzle-orm';
    import { db } from './engine/src/db.ts';
    import { installTrustedTestDatabaseBypass } from './engine/src/test-database-bypass.ts';
    import { purgeFolder } from './web/lib/file-cabinet.ts';

    installTrustedTestDatabaseBypass();
    const orgId = randomUUID();
    const folderId = randomUUID();
    const fileId = randomUUID();
    const targetId = randomUUID();
    const client = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL });
    try {
      await db.execute(sql\`
        insert into orgs (id, name, base_currency, country, settings, env_kind)
        values (\${orgId}, \${'Scratch ' + orgId.slice(0, 8)}, 'CAD', 'CA', '{}'::jsonb, 'sandbox')
      \`);
      await db.execute(sql\`
        insert into folders (id, org_id, parent_folder_id, name)
        values (\${folderId}, \${orgId}, null, 'Concurrent purge')
      \`);
      await db.execute(sql\`
        insert into files (id, org_id, folder_id, name, content_type, size_bytes)
        values (\${fileId}, \${orgId}, \${folderId}, 'evidence.txt', 'text/plain', 8)
      \`);

      await client.connect();
      await client.query('begin');
      await client.query("select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)", [orgId]);
      await client.query(
        'insert into file_attachments (org_id, file_id, target_table, target_id) values ($1, $2, $3, $4)',
        [orgId, fileId, 'documents', targetId],
      );

      let settled = false;
      const purge = purgeFolder(orgId, folderId).then((result) => { settled = true; return result });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(settled, false, "purge waits for the attachment transaction's file lock");
      await client.query('commit');
      const result = await purge;
      assert.deepEqual(result, { ok: false, reason: 'has attached files' });

      const counts = (await db.execute(sql\`
        select
          (select count(*)::int from folders where id = \${folderId}) as folders,
          (select count(*)::int from files where id = \${fileId}) as files,
          (select count(*)::int from file_attachments where file_id = \${fileId}) as links
      \`)).rows[0];
      assert.equal(counts.folders, 1);
      assert.equal(counts.files, 1);
      assert.equal(counts.links, 1);

      await db.execute(sql\`delete from file_attachments where file_id = \${fileId} and org_id = \${orgId}\`);
      assert.deepEqual(await purgeFolder(orgId, folderId), { ok: true });
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end().catch(() => undefined);
      await db.transaction(async (tx) => {
        await tx.execute(sql\`delete from file_attachments where org_id = \${orgId}\`);
        await tx.execute(sql\`delete from file_blobs where version_id in (select id from file_versions where file_id in (select id from files where org_id = \${orgId}))\`);
        await tx.execute(sql\`delete from file_versions where file_id in (select id from files where org_id = \${orgId})\`);
        await tx.execute(sql\`delete from files where org_id = \${orgId}\`);
        await tx.execute(sql\`delete from folders where org_id = \${orgId}\`);
        await tx.execute(sql\`delete from orgs where id = \${orgId}\`);
      });
    }
  `;
  const result = spawnSync(
    process.execPath,
    ['--conditions=react-server', '--import', 'tsx', '--import', './engine/src/test-database-bypass.ts', '--input-type=module', '-e', source],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
})

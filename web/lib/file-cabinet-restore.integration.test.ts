import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { deleteFile, deleteFolder, restoreFolder } = await import('./file-cabinet')

/**
 * Trashing a folder records which descendants it actually deactivated and
 * skips rows that were already in the trash. Restoring that folder must be
 * the exact inverse: only the rows the folder delete deactivated come back —
 * an item a user trashed on its own beforehand stays in the trash (it has its
 * own restore), instead of being silently resurrected.
 */
test('restoreFolder reactivates only what the folder delete deactivated', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'Clerk', 'clerk')
    const root = randomUUID()
    const child = randomUUID()
    const trashedChild = randomUUID()
    const rootFile = randomUUID()
    const childFile = randomUUID()
    const trashedFile = randomUUID()
    await db.execute(sql`insert into folders (id, org_id, parent_folder_id, name) values
      (${root}, ${org.orgId}, null, 'Root'),
      (${child}, ${org.orgId}, ${root}, 'Child'),
      (${trashedChild}, ${org.orgId}, ${root}, 'Trashed child')`)
    await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes) values
      (${rootFile}, ${org.orgId}, ${root}, 'root.txt', 'text/plain', 1),
      (${childFile}, ${org.orgId}, ${child}, 'child.txt', 'text/plain', 1),
      (${trashedFile}, ${org.orgId}, ${root}, 'trashed.txt', 'text/plain', 1)`)

    // Independently trashed BEFORE the folder: a file and a sub-folder.
    assert.equal(await deleteFile(org.orgId, trashedFile, { actorId }), true)
    assert.deepEqual(await deleteFolder(org.orgId, trashedChild, { actorId }), { ok: true })
    assert.deepEqual(await deleteFolder(org.orgId, root, { actorId }), { ok: true })

    assert.equal(await restoreFolder(org.orgId, root, { actorId }), true)

    const state = (await db.execute<{ id: string; kind: string; inactive: boolean }>(sql`
      select id, 'folder' as kind, is_inactive as inactive from folders where org_id = ${org.orgId} and id in (${root}, ${child}, ${trashedChild})
      union all
      select id, 'file' as kind, is_inactive as inactive from files where org_id = ${org.orgId} and id in (${rootFile}, ${childFile}, ${trashedFile})`)).rows
    const inactive = Object.fromEntries(state.map((row) => [row.id, row.inactive]))
    assert.deepEqual(inactive, {
      [root]: false,
      [child]: false,
      [rootFile]: false,
      [childFile]: false,
      // Trashed on their own before the folder: NOT resurrected by its restore.
      [trashedChild]: true,
      [trashedFile]: true,
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

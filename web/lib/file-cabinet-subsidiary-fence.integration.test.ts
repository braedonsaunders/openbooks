import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { Authz } from './authz'
import type { FileViewer } from './file-cabinet'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const {
  createFile,
  deleteFile,
  deleteFolder,
  fileAccessLevel,
  folderAccessLevel,
  moveFile,
  moveFolder,
  patchFolder,
  purgeFile,
  purgeFolder,
  removeGrant,
  renameFile,
  replaceFile,
  restoreFile,
  restoreFolder,
  setGrant,
} = await import('./file-cabinet')
const { requireFileAccess, requireFolderAccess } = await import('../app/api/file-cabinet/lib')

/**
 * Subsidiary fence for cabinet reads AND mutations: one coherent model.
 *
 * A documents.manage holder restricted to subsidiary B who guesses an A-side
 * record leaf, file, or grant id must read tier 'none' at the access level,
 * be refused (403) by the route gates, and be refused again inside the
 * mutation's own transaction when calling the verbs directly with their
 * viewer — for replace, move, rename, delete/purge, restores, creates, and
 * grant changes alike. B keeps full management of common (unscoped) files.
 */
test('subsidiary-restricted managers cannot read or alter out-of-fence files', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const userA = await createScratchUser(org.orgId, 'Keeper A', 'keeper_a')
    const userB = await createScratchUser(org.orgId, 'Keeper B', 'keeper_b')
    const subA = randomUUID()
    const subB = randomUUID()
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${subA}, ${org.orgId}, ${org.subsidiaryId}, 'Fence A', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb),
        (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Fence B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    `)
    const docA = randomUUID()
    await db.execute(sql`insert into documents(id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate)
      values (${docA}, ${org.orgId}, 'customer_invoice', 'draft', 'FENCE-A-1', ${subA}, ${org.customerId}, ${org.date}, 'CAD', 1)`)
    const commonId = randomUUID()
    const leafAId = randomUUID()
    const leafRId = randomUUID()
    await db.execute(sql`insert into folders (id, org_id, parent_folder_id, name, is_system, record_table, record_id)
      values (${commonId}, ${org.orgId}, null, 's19-fence-common', false, null, null),
             (${leafAId}, ${org.orgId}, null, 'documents / fence-a', true, 'documents', ${docA}),
             (${leafRId}, ${org.orgId}, null, 'documents / fence-restore', false, 'documents', ${docA})`)
    const mkFile = async (name: string, folderId: string): Promise<string> => {
      const fileId = randomUUID()
      await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes)
        values (${fileId}, ${org.orgId}, ${folderId}, ${name}, 'text/plain', 3)`)
      return fileId
    }
    // FA lives in A's leaf and is attached to A's record; FC sits in the
    // common folder but is attached to A's record; FP is free common stock.
    const faId = await mkFile('s19-fa.txt', leafAId)
    const fcId = await mkFile('s19-fc.txt', commonId)
    const fpId = await mkFile('s19-fp.txt', commonId)
    await db.execute(sql`insert into file_attachments (org_id, file_id, target_table, target_id, created_by)
      values (${org.orgId}, ${faId}, 'documents', ${docA}, ${userA}),
             (${org.orgId}, ${fcId}, 'documents', ${docA}, ${userA})`)

    const viewerA = { userId: userA, isAdmin: false as const, baseline: 'manager' as const, allowedSubsidiaryIds: new Set([subA]) } satisfies FileViewer
    const viewerB = { userId: userB, isAdmin: false as const, baseline: 'manager' as const, allowedSubsidiaryIds: new Set([subB]) } satisfies FileViewer
    const authzB = {
      user: { id: userB, orgId: org.orgId },
      permissions: new Set(['documents.read', 'documents.manage']),
      allowedSubsidiaryIds: new Set([subB]),
    } as unknown as Authz
    const auditB = { actorId: userB, viewer: viewerB }
    const auditA = { actorId: userA, viewer: viewerA }

    // Access levels: B reads 'none' on everything evidencing A — including
    // the common-folder file attached to A's record — while keeping manager
    // on genuinely common stock. A keeps manager on its own evidence.
    assert.equal(await folderAccessLevel(org.orgId, viewerB, leafAId), 'none')
    assert.equal(await fileAccessLevel(org.orgId, viewerB, faId), 'none')
    assert.equal(await fileAccessLevel(org.orgId, viewerB, fcId), 'none')
    assert.equal(await fileAccessLevel(org.orgId, viewerB, fpId), 'manager')
    assert.equal(await folderAccessLevel(org.orgId, viewerB, commonId), 'manager')
    assert.equal(await folderAccessLevel(org.orgId, viewerA, leafAId), 'manager')
    assert.equal(await fileAccessLevel(org.orgId, viewerA, faId), 'manager')

    // Route gates refuse B at the boundary.
    assert.equal((await requireFileAccess(authzB, faId, 'editor'))?.status, 403)
    assert.equal((await requireFileAccess(authzB, fcId, 'viewer'))?.status, 403)
    assert.equal((await requireFolderAccess(authzB, leafAId, 'manager'))?.status, 403)
    assert.equal(await requireFileAccess(authzB, fpId, 'editor'), null)

    // Direct verb calls with B's viewer refuse inside their transactions.
    assert.equal(await renameFile(org.orgId, faId, 's19-fa-hacked.txt', userB, auditB), false)
    assert.equal(await moveFile(org.orgId, faId, commonId, userB, auditB), false)
    assert.equal(
      await replaceFile({ orgId: org.orgId, fileId: faId, filename: 's19-fa.txt', contentType: 'text/plain', bytes: Buffer.from('x'), updatedBy: userB, audit: auditB }),
      false,
    )
    assert.equal(await deleteFile(org.orgId, faId, auditB), false)
    assert.equal(await purgeFile(org.orgId, faId, auditB), false)
    assert.equal((await patchFolder(org.orgId, leafAId, { name: 'hacked' }, userB, auditB)).ok, false)
    assert.equal(await moveFolder(org.orgId, leafAId, commonId, userB, auditB), false)
    assert.equal((await deleteFolder(org.orgId, leafAId, auditB)).ok, false)
    assert.equal((await purgeFolder(org.orgId, leafAId, auditB)).ok, false)
    await assert.rejects(
      () => setGrant({ orgId: org.orgId, resourceType: 'file', resourceId: faId, principalType: 'user', principalId: userB, access: 'viewer', actorId: userB, audit: auditB }),
      /lacks manager access/,
    )
    await assert.rejects(
      () => createFile({ orgId: org.orgId, folderId: leafAId, filename: 's19-drop.txt', contentType: 'text/plain', bytes: Buffer.from('x'), createdBy: userB, audit: auditB }),
      /lacks editor access/,
    )

    // Restores refuse too: trash privately, then B cannot bring rows back.
    await deleteFile(org.orgId, fcId, { actorId: userA })
    assert.equal(await restoreFile(org.orgId, fcId, auditB), false)
    await deleteFolder(org.orgId, leafRId, { actorId: userA }).then((r) => assert.equal(r.ok, true))
    assert.equal(await restoreFolder(org.orgId, leafRId, auditB), false)
    assert.equal(
      (await db.execute<{ isInactive: boolean }>(sql`select is_inactive as "isInactive" from folders where id = ${leafRId} and org_id = ${org.orgId}`)).rows[0]!.isInactive,
      true,
    )

    // Grant removal refuses on out-of-fence stock: the share B tries to strip
    // survives. (fpId is genuinely common, so B manages it — the refusal is
    // proven on faId, which evidences A.)
    await setGrant({ orgId: org.orgId, resourceType: 'file', resourceId: faId, principalType: 'user', principalId: userA, access: 'viewer', actorId: userA })
    const grantId: string = (await db.execute<{ id: string }>(sql`
      select id from resource_grants
       where org_id = ${org.orgId} and resource_type = 'file' and resource_id = ${faId} and principal_id = ${userA}
    `)).rows[0]!.id
    assert.equal(await removeGrant(org.orgId, grantId, 'file', faId, auditB), false)
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from resource_grants where id = ${grantId}`)).rows[0]!.n, 1)

    // Nothing moved: names, homes, and trash flags are exactly as seeded
    // (fcId stays trashed by its owner; everything else untouched).
    const files: Array<{ id: string; name: string; folderId: string; isInactive: boolean }> = (await db.execute(sql`
      select id, name, folder_id as "folderId", is_inactive as "isInactive"
        from files where org_id = ${org.orgId} and id in (${faId}, ${fcId}, ${fpId}) order by id
    `)).rows as Array<{ id: string; name: string; folderId: string; isInactive: boolean }>
    assert.equal(files.find((f) => f.id === faId)?.name, 's19-fa.txt')
    assert.equal(files.find((f) => f.id === faId)?.folderId, leafAId)
    assert.equal(files.find((f) => f.id === faId)?.isInactive, false)
    assert.equal(files.find((f) => f.id === fcId)?.isInactive, true)
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from files where org_id = ${org.orgId} and name = 's19-drop.txt'`)).rows[0]!.n, 0)
    const leaf: { name: string; isInactive: boolean } = (await db.execute(sql`
      select name, is_inactive as "isInactive" from folders where id = ${leafAId} and org_id = ${org.orgId}
    `)).rows[0] as { name: string; isInactive: boolean }
    assert.equal(leaf.name, 'documents / fence-a')
    assert.equal(leaf.isInactive, false)

    // A's own writes still succeed through the same gates.
    assert.equal(await renameFile(org.orgId, faId, 's19-fa-kept.txt', userA, auditA), true)
    assert.deepEqual(await patchFolder(org.orgId, leafRId, { name: 'documents / fence-restore-kept' }, userA, auditA), { ok: true })
    assert.equal(await restoreFile(org.orgId, fcId, { actorId: userA, viewer: viewerA }), true)
    assert.equal(await restoreFolder(org.orgId, leafRId, { actorId: userA, viewer: viewerA }), true)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

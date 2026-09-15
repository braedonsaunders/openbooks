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
const { attachExisting, getFile, getFileBlob, getFolder, listFiles, listFolderContents } = await import('./file-cabinet')

/**
 * Cabinet reads never apply the caller's subsidiary fence to record-folder
 * files: a file evidencing a hidden-entity record is listed, detailed, and
 * downloadable through the cabinet by a restricted documents.read holder,
 * although the attachment surfaces hide the same record as not-found.
 * Record-folder files whose folder-record target sits outside the fence must
 * be invisible at the query layer (metadata and bytes alike).
 */
test('cabinet reads hide record-folder files outside the caller fence', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'Clerk', 'clerk')
    const branchId = randomUUID()
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Cabinet Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    `)
    const hiddenDoc = randomUUID()
    await db.execute(sql`insert into documents(id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate)
      values (${hiddenDoc}, ${org.orgId}, 'customer_invoice', 'draft', 'HIDDEN-1', ${branchId}, ${org.customerId}, ${org.date}, 'CAD', 1)`)
    const folderId = randomUUID()
    const fileId = randomUUID()
    await db.execute(sql`insert into folders (id, org_id, parent_folder_id, name, is_system, record_table, record_id)
      values (${folderId}, ${org.orgId}, null, 'documents / hidden', true, 'documents', ${hiddenDoc})`)
    await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes)
      values (${fileId}, ${org.orgId}, ${folderId}, 'hidden-evidence.txt', 'text/plain', 8)`)
    const versionId = randomUUID()
    await db.execute(sql`insert into file_versions (id, file_id, version_number, content_type, size_bytes, storage_kind)
      values (${versionId}, ${fileId}, 1, 'text/plain', 8, 'db')`)
    await db.execute(sql`insert into file_blobs (version_id, bytes) values (${versionId}, 'aGVsbG8gd29ybGQ='::bytea)`)
    await db.execute(sql`update files set current_version_id = ${versionId} where id = ${fileId} and org_id = ${org.orgId}`)
    const link = await attachExisting({ orgId: org.orgId, fileId, targetTable: 'documents', targetId: hiddenDoc, createdBy: actorId })
    assert.ok(link)

    const restricted = { userId: actorId, isAdmin: false as const, baseline: 'viewer' as const, allowedSubsidiaryIds: new Set([org.subsidiaryId]) }
    assert.equal(await getFile(org.orgId, fileId, restricted), null)
    assert.equal(await getFileBlob(org.orgId, fileId, restricted), null)
    const listed = await listFiles(org.orgId, restricted, { q: 'hidden-evidence' })
    assert.equal(listed.total, 0)
    assert.equal(await getFolder(org.orgId, folderId, restricted), null)
    const groupId: string = (await db.execute<{ parent: string }>(sql`
      select parent_folder_id as "parent" from folders where id = ${folderId}`)).rows[0]!.parent
    const drilled = await listFolderContents(org.orgId, restricted, { parentId: groupId })
    assert.ok(!drilled.folders.some((f) => f.recordId === hiddenDoc))

    // Unrestricted callers and in-fence records keep working.
    assert.ok(await getFile(org.orgId, fileId, { ...restricted, allowedSubsidiaryIds: null }))
    assert.ok(await getFileBlob(org.orgId, fileId, { ...restricted, allowedSubsidiaryIds: null }))
    assert.ok(await getFolder(org.orgId, folderId, { ...restricted, allowedSubsidiaryIds: null }))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

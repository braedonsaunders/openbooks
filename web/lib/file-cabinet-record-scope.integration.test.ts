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
const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { attachExisting, deleteFile, ensureApCaptureRoot, fileAccessLevel, folderAccessLevel, getFile, getFileBlob, getFolder, getFolderTree, listFiles, listFolderContents, moveFile, setGrant } = await import('./file-cabinet')
const { buildZip, filesZipManifest, folderZipManifest, MAX_ZIP_FILES } = await import('./file-zip')

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

test('ZIP manifests apply record visibility before enforcing the file cap', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'ZIP branch viewer', 'clerk')
    const ownerId = await createScratchUser(org.orgId, 'Private folder owner', 'clerk')
    const subA = randomUUID()
    const subB = randomUUID()
    await db.execute(sql`insert into subsidiaries
      (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${subA}, ${org.orgId}, ${org.subsidiaryId}, 'ZIP A', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb),
             (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'ZIP B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`)
    const docA = randomUUID()
    const docB = randomUUID()
    await db.execute(sql`insert into documents(id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate)
      values (${docA}, ${org.orgId}, 'customer_invoice', 'draft', 'ZIP-A', ${subA}, ${org.customerId}, ${org.date}, 'CAD', 1),
             (${docB}, ${org.orgId}, 'customer_invoice', 'draft', 'ZIP-B', ${subB}, ${org.customerId}, ${org.date}, 'CAD', 1)`)
    const folderId = randomUUID()
    await db.execute(sql`insert into folders(id, org_id, name) values (${folderId}, ${org.orgId}, 'ZIP common')`)
    const privateFolderId = randomUUID()
    const privateFileId = randomUUID()
    await db.execute(sql`insert into folders(id, org_id, parent_folder_id, name, is_private, owner_id)
      values (${privateFolderId}, ${org.orgId}, ${folderId}, 'Confidential folder', true, ${ownerId})`)
    await db.execute(sql`insert into files(id, org_id, folder_id, name, content_type, size_bytes)
      values (${privateFileId}, ${org.orgId}, ${privateFolderId}, 'evidence.pdf', 'application/pdf', 1)`)
    await db.execute(sql`insert into resource_grants(org_id, resource_type, resource_id, principal_type, principal_id, access, created_by)
      values (${org.orgId}, 'file', ${privateFileId}, 'user', ${actorId}, 'viewer', ${actorId})`)
    await db.execute(sql`insert into files(id, org_id, folder_id, name, content_type, size_bytes)
      select gen_random_uuid(), ${org.orgId}, ${folderId}, 'hidden-' || n::text || '.pdf', 'application/pdf', 1
        from generate_series(1, ${MAX_ZIP_FILES + 1}) as n`)
    await db.execute(sql`insert into file_attachments(org_id, file_id, target_table, target_id, created_by)
      select ${org.orgId}, id, 'documents', ${docA}, ${actorId} from files
       where org_id = ${org.orgId} and folder_id = ${folderId}`)
    const visibleId = randomUUID()
    await db.execute(sql`insert into files(id, org_id, folder_id, name, content_type, size_bytes)
      values (${visibleId}, ${org.orgId}, ${folderId}, 'visible.pdf', 'application/pdf', 1)`)
    await db.execute(sql`insert into file_attachments(org_id, file_id, target_table, target_id, created_by)
      values (${org.orgId}, ${visibleId}, 'documents', ${docB}, ${actorId})`)

    const viewer = { userId: actorId, isAdmin: false as const, baseline: 'viewer' as const, allowedSubsidiaryIds: new Set([subB]) }
    const folderEntries = await folderZipManifest(org.orgId, folderId, viewer)
    const selectedIds = (await db.execute<{ id: string }>(sql`select id from files where org_id = ${org.orgId} and folder_id = ${folderId}`)).rows.map((row) => row.id)
    const selectedEntries = await filesZipManifest(org.orgId, selectedIds, viewer)
    assert.ok(folderEntries.some((entry) => entry.id === privateFileId && entry.path === 'evidence.pdf'))
    assert.ok(folderEntries.every((entry) => !entry.path.includes('Confidential folder')))
    assert.deepEqual(selectedEntries.map((entry) => entry.id), [visibleId])
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('trash hides metadata and every pinned or ZIP byte read', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'Cabinet reader', 'clerk')
    const folderId = randomUUID()
    const fileId = randomUUID()
    const versionId = randomUUID()
    await db.execute(sql`insert into folders (id, org_id, name) values (${folderId}, ${org.orgId}, 'Trash reader')`)
    await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes)
      values (${fileId}, ${org.orgId}, ${folderId}, 'trashed.txt', 'text/plain', 4)`)
    await db.execute(sql`insert into file_versions (id, file_id, version_number, content_type, size_bytes, storage_kind)
      values (${versionId}, ${fileId}, 1, 'text/plain', 4, 'db')`)
    await db.execute(sql`insert into file_blobs (version_id, bytes) values (${versionId}, decode('64617461', 'hex'))`)
    await db.execute(sql`update files set current_version_id = ${versionId} where id = ${fileId}`)
    const viewer = { userId: actorId, isAdmin: false, baseline: 'viewer' as const }
    const manifest = [{ id: fileId, path: 'Trash reader/trashed.txt' }]

    assert.equal(await deleteFile(org.orgId, fileId), true)
    assert.equal(await getFile(org.orgId, fileId, viewer), null)
    assert.equal(await getFileBlob(org.orgId, fileId, viewer), null)
    assert.equal(await getFileBlob(org.orgId, fileId, viewer, versionId), null)
    assert.equal((await buildZip(org.orgId, viewer, manifest)).included, 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('stale trashed folder and file ids cannot reveal metadata or activity access', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'Stale cabinet reader', 'clerk')
    const folderId = randomUUID()
    const fileId = randomUUID()
    await db.execute(sql`insert into folders(id, org_id, name) values (${folderId}, ${org.orgId}, 'Former folder')`)
    await db.execute(sql`insert into files(id, org_id, folder_id, name, content_type, size_bytes)
      values (${fileId}, ${org.orgId}, ${folderId}, 'former.txt', 'text/plain', 0)`)
    await db.execute(sql`insert into resource_grants(org_id, resource_type, resource_id, principal_type, principal_id, access, created_by)
      values (${org.orgId}, 'folder', ${folderId}, 'user', ${actorId}, 'viewer', ${actorId}),
             (${org.orgId}, 'file', ${fileId}, 'user', ${actorId}, 'viewer', ${actorId})`)
    const viewer = { userId: actorId, isAdmin: false, baseline: 'viewer' as const }

    await db.execute(sql`update folders set is_inactive = true where id = ${folderId} and org_id = ${org.orgId}`)
    await db.execute(sql`update files set is_inactive = true where id = ${fileId} and org_id = ${org.orgId}`)

    assert.equal(await getFolder(org.orgId, folderId, viewer), null)
    assert.equal(await folderAccessLevel(org.orgId, viewer, folderId), 'none')
    assert.equal(await fileAccessLevel(org.orgId, viewer, fileId), 'none')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('generic cabinet readers require AP read for AP capture even with a file grant', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'AP capture reader', 'clerk')
    const folderId = await ensureApCaptureRoot(org.orgId, actorId)
    const fileId = randomUUID()
    const versionId = randomUUID()
    await db.execute(sql`insert into files(id, org_id, folder_id, name, content_type, size_bytes)
      values (${fileId}, ${org.orgId}, ${folderId}, 'supplier-invoice.pdf', 'application/pdf', 4)`)
    await db.execute(sql`insert into file_versions(id, file_id, version_number, content_type, size_bytes, storage_kind)
      values (${versionId}, ${fileId}, 1, 'application/pdf', 4, 'db')`)
    await db.execute(sql`insert into file_blobs(version_id, bytes) values (${versionId}, decode('64617461', 'hex'))`)
    await db.execute(sql`update files set current_version_id = ${versionId} where id = ${fileId}`)
    await db.execute(sql`insert into resource_grants(org_id, resource_type, resource_id, principal_type, principal_id, access, created_by)
      values (${org.orgId}, 'file', ${fileId}, 'user', ${actorId}, 'viewer', ${actorId})`)

    const noApPermission = { userId: actorId, isAdmin: false, baseline: 'viewer' as const, canReadApCapture: false }
    const withApPermission = { ...noApPermission, canReadApCapture: true }
    assert.equal(await getFile(org.orgId, fileId, noApPermission), null)
    assert.equal(await getFileBlob(org.orgId, fileId, noApPermission), null)
    assert.equal((await listFiles(org.orgId, noApPermission, { q: 'supplier-invoice' })).total, 0)
    assert.equal(await getFolder(org.orgId, folderId, noApPermission), null)
    assert.ok(await getFile(org.orgId, fileId, withApPermission))
    assert.ok(await getFileBlob(org.orgId, fileId, withApPermission))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

/**
 * Attachment-target fence: a file evidences every record it is attached to,
 * its links — must stay invisible (metadata and bytes) to viewers outside the
 * targets' subsidiaries. Every target must be in-fence; an explicit file
 * grant re-opens exactly its file.
 */
test('cabinet reads hide files attached to out-of-fence records', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'Clerk', 'clerk')
    const bUserId = await createScratchUser(org.orgId, 'Branch Clerk', 'clerk')
    const subA = randomUUID()
    const subB = randomUUID()
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${subA}, ${org.orgId}, ${org.subsidiaryId}, 'Cabinet A', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb),
        (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Cabinet B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    `)
    const docA = randomUUID()
    const docB = randomUUID()
    await db.execute(sql`insert into documents(id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate)
      values (${docA}, ${org.orgId}, 'customer_invoice', 'draft', 'A-1', ${subA}, ${org.customerId}, ${org.date}, 'CAD', 1),
             (${docB}, ${org.orgId}, 'customer_invoice', 'draft', 'B-1', ${subB}, ${org.customerId}, ${org.date}, 'CAD', 1)`)
    const commonId = randomUUID()
    const leafAId = randomUUID()
    await db.execute(sql`insert into folders (id, org_id, parent_folder_id, name, is_system, record_table, record_id)
      values (${commonId}, ${org.orgId}, null, 's19-common', false, null, null),
             (${leafAId}, ${org.orgId}, null, 'documents / a-leaf', true, 'documents', ${docA})`)
    const mkFile = async (name: string, folderId: string): Promise<string> => {
      const fileId = randomUUID()
      const versionId = randomUUID()
      await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes)
        values (${fileId}, ${org.orgId}, ${folderId}, ${name}, 'text/plain', 8)`)
      await db.execute(sql`insert into file_versions (id, file_id, version_number, content_type, size_bytes, storage_kind)
        values (${versionId}, ${fileId}, 1, 'text/plain', 8, 'db')`)
      await db.execute(sql`insert into file_blobs (version_id, bytes) values (${versionId}, 'aGVsbG8gd29ybGQ='::bytea)`)
      await db.execute(sql`update files set current_version_id = ${versionId} where id = ${fileId} and org_id = ${org.orgId}`)
      return fileId
    }
    // Common-folder files linked across the fence, one multi-attached, one free.
    const onlyA = await mkFile('s19-only-a.txt', commonId)
    const onlyB = await mkFile('s19-only-b.txt', commonId)
    const bothAB = await mkFile('s19-both-ab.txt', commonId)
    const free = await mkFile('s19-free.txt', commonId)
    // A scoped-leaf file carrying its own attachment link (the move scenario).
    const leafFile = await mkFile('s19-leaf.txt', leafAId)
    assert.ok(await attachExisting({ orgId: org.orgId, fileId: onlyA, targetTable: 'documents', targetId: docA, createdBy: actorId }))
    assert.ok(await attachExisting({ orgId: org.orgId, fileId: onlyB, targetTable: 'documents', targetId: docB, createdBy: actorId }))
    assert.ok(await attachExisting({ orgId: org.orgId, fileId: bothAB, targetTable: 'documents', targetId: docA, createdBy: actorId }))
    assert.ok(await attachExisting({ orgId: org.orgId, fileId: bothAB, targetTable: 'documents', targetId: docB, createdBy: actorId }))
    assert.ok(await attachExisting({ orgId: org.orgId, fileId: leafFile, targetTable: 'documents', targetId: docA, createdBy: actorId }))

    const viewerA = { userId: actorId, isAdmin: false as const, baseline: 'viewer' as const, allowedSubsidiaryIds: new Set([subA]) }
    const viewerB = { userId: bUserId, isAdmin: false as const, baseline: 'viewer' as const, allowedSubsidiaryIds: new Set([subB]) }
    const open = { userId: actorId, isAdmin: false as const, baseline: 'viewer' as const, allowedSubsidiaryIds: null }

    // Linked files are visible only inside every target's fence.
    assert.ok(await getFile(org.orgId, onlyA, viewerA))
    assert.equal(await getFile(org.orgId, onlyA, viewerB), null)
    assert.equal(await getFileBlob(org.orgId, onlyA, viewerB), null)
    assert.ok(await getFile(org.orgId, onlyB, viewerB))
    assert.equal(await getFile(org.orgId, onlyB, viewerA), null)
    // Multi-attached to A+B: neither single-subsidiary viewer sees it.
    assert.equal(await getFile(org.orgId, bothAB, viewerA), null)
    assert.equal(await getFile(org.orgId, bothAB, viewerB), null)
    assert.ok(await getFile(org.orgId, bothAB, open))
    // Unattached common files stay visible to everyone.
    assert.ok(await getFile(org.orgId, free, viewerA))
    assert.ok(await getFile(org.orgId, free, viewerB))
    assert.equal((await listFiles(org.orgId, viewerB, { q: 's19-only-a' })).total, 0)
    assert.equal((await listFiles(org.orgId, viewerB, { q: 's19-only-b' })).total, 1)

    // The reported move: scoped-leaf file out to the common folder, links kept.
    // The bytes must not launder into B's reach; A keeps them.
    assert.ok(await moveFile(org.orgId, leafFile, commonId, actorId))
    assert.equal(await getFile(org.orgId, leafFile, viewerB), null)
    assert.equal(await getFileBlob(org.orgId, leafFile, viewerB), null)
    assert.equal((await listFiles(org.orgId, viewerB, { q: 's19-leaf' })).total, 0)
    assert.ok(await getFile(org.orgId, leafFile, viewerA))
    assert.ok(await getFileBlob(org.orgId, leafFile, viewerA))

    // The reported link: a free common file attached to A's record vanishes
    // from B's cabinet (fail closed) while A keeps it.
    assert.ok(await attachExisting({ orgId: org.orgId, fileId: free, targetTable: 'documents', targetId: docA, createdBy: actorId }))
    assert.equal(await getFile(org.orgId, free, viewerB), null)
    assert.ok(await getFile(org.orgId, free, viewerA))

    for (const viewer of [viewerA, viewerB, open]) {
      const visibleFiles = await listFiles(org.orgId, viewer, { folderId: commonId })
      const folder = await getFolder(org.orgId, commonId, viewer)
      assert.ok(folder)
      assert.equal(folder.fileCount, visibleFiles.total)
      const treeFolder = (await getFolderTree(org.orgId, viewer)).find((row) => row.id === commonId)
      assert.equal(treeFolder?.fileCount, visibleFiles.total)
    }

    // An explicit share re-opens exactly its file for the grantee.
    await setGrant({
      orgId: org.orgId, resourceType: 'file', resourceId: onlyA,
      principalType: 'user', principalId: bUserId, access: 'viewer', actorId,
    })
    const sharedAcrossFence = await getFile(org.orgId, onlyA, viewerB)
    assert.ok(sharedAcrossFence)
    assert.deepEqual(sharedAcrossFence.attachments, [], 'a direct file grant does not expose an out-of-scope target identity')
    assert.equal(await getFile(org.orgId, onlyB, viewerA), null)
    const afterGrant = await listFiles(org.orgId, viewerB, { folderId: commonId })
    assert.equal((await getFolder(org.orgId, commonId, viewerB))?.fileCount, afterGrant.total)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

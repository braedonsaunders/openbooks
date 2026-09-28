import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

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
    await db.execute(sql`insert into hrm_data_subject_exports(org_id, party_id, requested_by, file_id, scope)
      values (${org.orgId}, ${org.customerId}, ${actorId}, ${fileId}, '[]'::jsonb)`)
    assert.equal(await getFile(org.orgId, fileId, withApPermission), null)
    assert.equal(await getFileBlob(org.orgId, fileId, withApPermission), null)
    assert.equal(await fileAccessLevel(org.orgId, { userId: actorId, isAdmin: true }, fileId, undefined, { includeInactive: true }), 'none')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

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
    const onlyA = await mkFile('s19-only-a.txt', commonId)
    const onlyB = await mkFile('s19-only-b.txt', commonId)
    const bothAB = await mkFile('s19-both-ab.txt', commonId)
    const free = await mkFile('s19-free.txt', commonId)
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

    await db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [subB] })}::jsonb
      where org_id=${org.orgId} and key='clerk'`)
    await assert.rejects(
      () => setGrant({ orgId: org.orgId, resourceType: 'file', resourceId: onlyA, principalType: 'user', principalId: bUserId, access: 'viewer', actorId }),
      /outside their subsidiary scope/,
    )
    assert.equal(await getFile(org.orgId, onlyA, viewerB), null)
    assert.equal(await getFile(org.orgId, onlyB, viewerA), null)
    const afterGrant = await listFiles(org.orgId, viewerB, { folderId: commonId })
    assert.equal((await getFolder(org.orgId, commonId, viewerB))?.fileCount, afterGrant.total)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})


const consolidatedRows = [
  { label: "file cabinet detach", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const pg = (await import("pg")).default;
        const { sql } = await import('drizzle-orm')
        const { db } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
        const { attachExisting, detachAttachment, getAttachmentLink } = await import('./file-cabinet')

        test('detachAttachment retains links to posted documents and audits permitted detaches', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await createScratchOrg()
          try {
            const actorId = await createScratchUser(org.orgId, 'Clerk', 'clerk')
            const folderId = randomUUID()
            const fileId = randomUUID()
            await db.execute(sql`insert into folders (id, org_id, parent_folder_id, name) values (${folderId}, ${org.orgId}, null, 'Evidence')`)
            await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes) values (${fileId}, ${org.orgId}, ${folderId}, 'evidence.txt', 'text/plain', 8)`)

            const seedInvoice = async (label: string): Promise<string> => {
              const id = randomUUID()
              await db.execute(sql`insert into documents(id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate) values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${label}, ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', 1)`)
              await db.execute(sql`insert into document_lines(org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount) values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, 1, 100, 100, 0, 0)`)
              return id
            }
            const postedDoc = await seedInvoice('Posted')
            await db.execute(sql`update documents set status = 'approved' where id = ${postedDoc}`)
            await postDocument(postedDoc, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })
            const draftDoc = await seedInvoice('Draft')
            const raceDoc = await seedInvoice('Race')

            const postedLink = await attachExisting({ orgId: org.orgId, fileId, targetTable: 'documents', targetId: postedDoc, createdBy: actorId })
            const draftLink = await attachExisting({ orgId: org.orgId, fileId, targetTable: 'documents', targetId: draftDoc, createdBy: actorId })
            const raceLink = await attachExisting({ orgId: org.orgId, fileId, targetTable: 'documents', targetId: raceDoc, createdBy: actorId })
            assert.ok(postedLink && draftLink && raceLink)

            assert.deepEqual(await detachAttachment(org.orgId, postedLink, { actorId }), { ok: false, reason: 'retained' })
            assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from audit_log where org_id = ${org.orgId} and table_name = 'file_attachments' and row_id = ${postedLink}`)).rows[0]!.count, 0)

            assert.deepEqual(await detachAttachment(org.orgId, draftLink, { actorId }), { ok: true })
            assert.equal(await getAttachmentLink(org.orgId, draftLink), null)
            const evidence = (await db.execute<{ actor_id: string | null; changes: Record<string, unknown> }>(sql`select actor_id, changes from audit_log where org_id = ${org.orgId} and table_name = 'file_attachments' and row_id = ${draftLink}`)).rows
            assert.deepEqual(evidence.map((row) => [row.actor_id, row.changes.event, row.changes.before]), [[actorId, 'delete', { fileId, targetTable: 'documents', targetId: draftDoc }]])

            const client = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL })
            await client.connect()
            let detached = false
            try {
              await client.query('begin')
              await client.query("select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)", [org.orgId])
              await client.query('select id from documents where id = $1 and org_id = $2 for update', [raceDoc, org.orgId])
              const pendingDetach = detachAttachment(org.orgId, raceLink!, { actorId }).then((result) => { detached = true; return result })
              await new Promise((resolve) => setTimeout(resolve, 50))
              assert.equal(detached, false)
              await client.query('commit')
              assert.deepEqual(await pendingDetach, { ok: true })
            } finally {
              await client.query('rollback').catch(() => undefined)
              await client.end()
            }

          } finally {
            await dropScratchOrg(org.orgId)
          }
        })
  } },
  { label: "file cabinet restore", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { sql } = await import('drizzle-orm')
        const { db } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { deleteFile, deleteFolder, restoreFolder } = await import('./file-cabinet')

        /**
         * Trashing a folder records which descendants it actually deactivated and
         * skips rows that were already in the trash. Restoring that folder must be
         * the exact inverse: only the rows the folder delete deactivated come back —
         * an item a user trashed on its own beforehand stays in the trash (it has its
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

            assert.equal(await deleteFile(org.orgId, trashedFile, { actorId }), true)
            assert.deepEqual(await deleteFolder(org.orgId, trashedChild, { actorId }), { ok: true })
            assert.deepEqual(await deleteFolder(org.orgId, root, { actorId }), { ok: true })
            assert.deepEqual(await deleteFolder(org.orgId, root, { actorId }), { ok: false, reason: 'inactive' })
            assert.equal((await db.execute(sql`select count(*)::int as n from audit_log where org_id = ${org.orgId} and table_name = 'folders' and row_id = ${root} and action = 'delete'`)).rows[0]!.n, 1)

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
  } },
  { label: "file cabinet subsidiary fence", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        type Authz = import("./authz").Authz;
        type FileViewer = import("./file-cabinet").FileViewer;
        const { sql } = await import('drizzle-orm')
        const { db, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
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

        test('subsidiary-restricted managers cannot read or alter out-of-fence files', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypass(() => createScratchOrg())
          const { userA, userB, subA, subB, commonId, leafAId, leafRId, faId, fcId, fpId } = await withBypass(
            async () => {
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
              const faId = await mkFile('s19-fa.txt', leafAId)
              const fcId = await mkFile('s19-fc.txt', commonId)
              const fpId = await mkFile('s19-fp.txt', commonId)
              await db.execute(sql`insert into file_attachments (org_id, file_id, target_table, target_id, created_by)
                values (${org.orgId}, ${faId}, 'documents', ${docA}, ${userA}),
                       (${org.orgId}, ${fcId}, 'documents', ${docA}, ${userA})`)
              return { userA, userB, subA, subB, commonId, leafAId, leafRId, faId, fcId, fpId }
            },
          )
          try {

            const viewerA = { userId: userA, isAdmin: false as const, baseline: 'manager' as const, allowedSubsidiaryIds: new Set([subA]) } satisfies FileViewer
            const viewerB = { userId: userB, isAdmin: false as const, baseline: 'manager' as const, allowedSubsidiaryIds: new Set([subB]) } satisfies FileViewer
            const authzB = {
              user: { id: userB, orgId: org.orgId },
              permissions: new Set(['documents.read', 'documents.manage']),
              allowedSubsidiaryIds: new Set([subB]),
            } as unknown as Authz
            const auditB = { actorId: userB, viewer: viewerB }
            const auditA = { actorId: userA, viewer: viewerA }

            assert.equal(await folderAccessLevel(org.orgId, viewerB, leafAId), 'none')
            assert.equal(await fileAccessLevel(org.orgId, viewerB, faId), 'none')
            assert.equal(await fileAccessLevel(org.orgId, viewerB, fcId), 'none')
            assert.equal(await fileAccessLevel(org.orgId, viewerB, fpId), 'manager')
            assert.equal(await folderAccessLevel(org.orgId, viewerB, commonId), 'manager')
            assert.equal(await folderAccessLevel(org.orgId, viewerA, leafAId), 'manager')
            assert.equal(await fileAccessLevel(org.orgId, viewerA, faId), 'manager')

            assert.equal((await requireFileAccess(authzB, faId, 'editor'))?.status, 403)
            assert.equal((await requireFileAccess(authzB, fcId, 'viewer'))?.status, 403)
            assert.equal((await requireFolderAccess(authzB, leafAId, 'manager'))?.status, 403)
            assert.equal(await requireFileAccess(authzB, fpId, 'editor'), null)

            assert.equal(await renameFile(org.orgId, faId, 's19-fa-hacked.txt', userB, auditB), false)
            assert.equal(await moveFile(org.orgId, faId, commonId, userB, auditB), false)
            assert.equal(
              await replaceFile({ orgId: org.orgId, fileId: faId, filename: 's19-fa.txt', contentType: 'text/plain', bytes: Buffer.from('x'), updatedBy: userB, audit: auditB }),
              false,
            )
            assert.equal(await deleteFile(org.orgId, faId, auditB), false)
            assert.equal(await purgeFile(org.orgId, faId, auditB), 'forbidden')
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
  } },
  { label: "file cabinet", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { spawnSync } = await import("node:child_process");
        const test = (await import("node:test")).default;
        const { env } = await import("@openbooks/engine/src/platform/db.ts");
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
            import { db } from './engine/src/platform/db.ts';
            import { installTrustedTestDatabaseBypass } from './engine/src/testing/database-bypass.ts';
            import { purgeFolder } from './web/lib/file-cabinet/index.ts';

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
            ['--conditions=react-server', '--import', 'tsx', '--import', './engine/src/testing/database-bypass.ts', '--input-type=module', '-e', source],
            { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
          );
          assert.equal(result.status, 0, result.stderr || result.stdout);
        })
  } },
  { label: "file cabinet.private boundary", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { spawnSync } = await import("node:child_process");
        const test = (await import("node:test")).default;
        const { env } = await import("@openbooks/engine/src/platform/db.ts");
        /**
         * Regression coverage for the nested private-folder boundary defect in
         * web/lib/file-cabinet.ts: owning a private folder anywhere on the ancestor
         * chain used to waive a FOREIGN private folder elsewhere on the same chain —
         * folderAccessLevel returned Manager (and unsuppressed baseline) for subtrees
         * that resolveReadScope hides from the very same viewers, opening every
         * mutation gate (rename/move/delete/purge, bulk ops) on read-invisible rows.
         *
         * The scenario runs against the real exported functions on a real database,
         * asserting exact access levels plus a mechanical read/write parity invariant
         * (folderAccessLevel ≠ 'none' ⇔ the folder is visible via the read paths),
         * and that explicit resource_grants are the only way past the boundary.
         */
        test(
          "nested private-folder ownership cannot bypass a foreign private boundary",
          { skip: !env.OPENBOOKS_DB_URL },
          () => {
            // A bare OPENBOOKS_DB_URL (throwaway container) gets the published schema
            // through the canonical idempotent bootstrap; an already-migrated host is
            // left untouched apart from a catalog existence probe.
            const probe = spawnSync(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `
                import pg from "pg";
                const client = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL });
                await client.connect();
                const r = await client.query("select to_regclass('public.folders') is not null as ok");
                console.log("BOOTSTRAP_NEEDED=" + (!r.rows[0].ok));
                await client.end();
                `,
              ],
              { cwd: process.cwd(), env: process.env, encoding: "utf8" },
            );
            assert.equal(probe.status, 0, probe.stderr || probe.stdout);
            if (/BOOTSTRAP_NEEDED=true/.test(probe.stdout)) {
              const bootstrapped = spawnSync(
                process.execPath,
                ["--import", "tsx", "scripts/bootstrap.ts"],
                {
                  cwd: process.cwd(),
                  env: {
                    ...process.env,
                    NODE_ENV: "test",
                    ORG_NAME: "OpenBooks Test",
                    ORG_CURRENCY: "CAD",
                    ORG_COUNTRY: "CA",
                  },
                  encoding: "utf8",
                },
              );
              assert.equal(bootstrapped.status, 0, bootstrapped.stderr || bootstrapped.stdout);
            }

            // The spawned scenario source stays plain JavaScript: node parses `-e`
            // modules itself; only imported .ts files go through the tsx transform.
            const source = `
              import assert from "node:assert/strict";
              import { randomUUID } from "node:crypto";
              import { sql } from "drizzle-orm";
              import { db } from "./engine/src/platform/db.ts";
              import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
              import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";
              import {
                fileAccessLevel,
                folderAccessLevel,
                getFolderTree,
                listFiles,
                setGrant,
              } from "./web/lib/file-cabinet/index.ts";

              installTrustedTestDatabaseBypass();

              // Fixture tree (one org):
              //   rootA (private, alice)
              //     workA                  – plain folder inside alice's private subtree
              //       innerA (private, alice)
              //         leafA              – deep leaf of alice's OWN private chain
              //       orphanPrivate (private, owner NULL)
              //     secB (private, bob)    – bob's own private folder nested behind
              //                              alice's foreign private boundary
              //         leafB              – invisible to BOTH viewers via the read path
              const org = await createScratchOrg();
              const orgId = org.orgId;
              try {
                const alice = randomUUID();
                const bob = randomUUID();
                const ids = Array.from({ length: 7 }, () => randomUUID());
                const rootA = ids[0];
                const workA = ids[1];
                const innerA = ids[2];
                const leafA = ids[3];
                const orphanPrivate = ids[4];
                const secB = ids[5];
                const leafB = ids[6];

                const roleId = (await db.execute(sql\`
                  insert into app_roles (org_id, key, name, description, is_built_in, permissions)
                  values (\${orgId}, 'member', 'Member', 'boundary fixture', false, '[]'::jsonb)
                  returning id
                \`)).rows[0].id;
                for (const pair of [[alice, "alice@boundary.fixture"], [bob, "bob@boundary.fixture"]]) {
                  const userId = pair[0];
                  const email = pair[1];
                  await db.execute(sql\`
                    insert into users (id, org_id, email, name, password_hash, is_active)
                    values (\${userId}, \${orgId}, \${email}, \${email.split("@")[0]}, 'x', false)
                  \`);
                  await db.execute(sql\`
                    insert into role_assignments (org_id, user_id, role_id)
                    values (\${orgId}, \${userId}, \${roleId})
                  \`);
                  await db.execute(sql\`update users set is_active = true where id = \${userId}\`);
                }
                const folders = [
                  [rootA, null, "rootA", true, alice],
                  [workA, rootA, "workA", false, null],
                  [innerA, workA, "innerA", true, alice],
                  [leafA, innerA, "leafA", false, null],
                  [orphanPrivate, workA, "orphanPrivate", true, null],
                  [secB, rootA, "secB", true, bob],
                  [leafB, secB, "leafB", false, null],
                ];
                for (const f of folders) {
                  await db.execute(sql\`
                    insert into folders (id, org_id, parent_folder_id, name, is_private, owner_id)
                    values (\${f[0]}, \${orgId}, \${f[1]}, \${f[2]}, \${f[3]}, \${f[4]})
                  \`);
                }
                const fileIds = {};
                for (const folder of [leafA, leafB]) {
                  const fileId = randomUUID();
                  fileIds[folder] = fileId;
                  await db.execute(sql\`
                    insert into files (id, org_id, folder_id, name, content_type, size_bytes)
                    values (\${fileId}, \${orgId}, \${folder}, \${"f-" + fileId.slice(0, 8) + ".txt"}, \${"text/plain"}, 3)
                  \`);
                }

                const aliceViewer = { userId: alice, isAdmin: false, baseline: "viewer" };
                const bobViewer = { userId: bob, isAdmin: false, baseline: "viewer" };
                const adminViewer = { userId: "no-such-user", isAdmin: true };

                const level = async (viewer, folderId) => folderAccessLevel(orgId, viewer, folderId);

                // Ownership intact inside one's own private subtree (no crossing).
                assert.equal(await level(aliceViewer, rootA), "manager", "alice owns her private root");
                assert.equal(await level(aliceViewer, workA), "manager", "alice manages her own subtree");
                assert.equal(await level(aliceViewer, innerA), "manager", "alice manages her nested private folder");
                assert.equal(await level(aliceViewer, leafA), "manager", "ownership reaches deep leaves");

                // THE DEFECT: ownership of a private folder on the chain must not
                // waive a foreign private boundary elsewhere on the chain.
                assert.equal(await level(aliceViewer, secB), "none", "foreign private boundary seals bob's folder from alice");
                assert.equal(await level(aliceViewer, leafB), "none", "alice gets nothing under bob's nested private folder");
                assert.equal(await level(bobViewer, secB), "none", "bob's own ownership does not pierce alice's boundary above him");
                assert.equal(await level(bobViewer, leafB), "none", "bob gets nothing in his subtree behind the boundary");
                assert.equal(await level(bobViewer, rootA), "none", "foreign private root hides from bob");
                assert.equal(await level(bobViewer, workA), "none");
                assert.equal(await level(bobViewer, innerA), "none");
                assert.equal(await level(bobViewer, leafA), "none");
                assert.equal(await level(aliceViewer, orphanPrivate), "none", "NULL-owner private folder counts as foreign");
                assert.equal(await level(adminViewer, leafB), "manager", "admins keep Manager everywhere");
                assert.equal(await fileAccessLevel(orgId, aliceViewer, fileIds[leafB]), "none", "files inherit the boundary rule (alice)");
                assert.equal(await fileAccessLevel(orgId, bobViewer, fileIds[leafB]), "none", "files inherit the boundary rule (bob)");

                // Grants are the only path past a foreign boundary, and confer exactly
                // their own tier — never the spurious Manager the defect produced.
                await setGrant({
                  orgId, resourceType: "folder", resourceId: secB,
                  principalType: "user", principalId: alice, access: "editor", actorId: alice,
                });
                await setGrant({
                  orgId, resourceType: "folder", resourceId: orphanPrivate,
                  principalType: "user", principalId: bob, access: "viewer", actorId: alice,
                });
                assert.equal(await level(aliceViewer, leafB), "editor", "editor grant re-opens the subtree at editor tier");
                assert.equal(await level(bobViewer, leafB), "none", "alice's grant does not leak to bob");
                assert.equal(await level(bobViewer, orphanPrivate), "viewer", "viewer grant re-opens the NULL-owner boundary");
                assert.equal(await fileAccessLevel(orgId, aliceViewer, fileIds[leafB]), "editor", "granted folder lifts contained files");

                // Read/write parity invariant: the write-path tier agrees with the
                // read-path scope for every viewer/folder pair — a folder the lists
                // hide must not be actionable, and anything listed stays actionable.
                const targets = [
                  [rootA, "rootA"], [workA, "workA"], [innerA, "innerA"], [leafA, "leafA"],
                  [orphanPrivate, "orphanPrivate"], [secB, "secB"], [leafB, "leafB"],
                ];
                for (const entry of [["alice", aliceViewer], ["bob", bobViewer]]) {
                  const viewerName = entry[0];
                  const viewer = entry[1];
                  const tree = new Set((await getFolderTree(orgId, viewer)).map((f) => f.id));
                  for (const target of targets) {
                    const folderId = target[0];
                    const name = target[1];
                    const visible = tree.has(folderId);
                    const tier = await level(viewer, folderId);
                    const listed = (await listFiles(orgId, viewer, { folderId })).total;
                    const wantListed = visible && (folderId === leafA || folderId === leafB) ? 1 : 0;
                    assert.equal(tier !== "none", visible, \`parity \${viewerName}/\${name}: access=\${tier} treeVisible=\${visible}\`);
                    assert.equal(listed, wantListed, \`parity \${viewerName}/\${name}: fileListings\`);
                  }
                }
              } finally {
                await dropScratchOrg(orgId);
              }
            `;
            const result = spawnSync(
              process.execPath,
              [
                "--conditions=react-server",
                "--import",
                "tsx",
                "--import",
                "./engine/src/testing/database-bypass.ts",
                "--input-type=module",
                "-e",
                source,
              ],
              { cwd: process.cwd(), env: process.env, encoding: "utf8" },
            );
            assert.equal(result.status, 0, result.stderr || result.stdout);
          },
        );

        /**
         * Regression coverage for the mutation/audit atomicity defect in
         * web/lib/file-cabinet.ts: mutations and their audit evidence used to be two
         * independent autocommit statements issued by the route, so a failed audit
         * insert returned an error AFTER the file had already changed — irreversible
         * for purgeFile (files, versions, blobs, attachment links already gone).
         *
         * The verbs now own mutation + attributable before/after evidence in ONE
         * inDbTransaction unit (recordFileEvent executes on the caller-provided
         * executor seam), and the external S3 deletion stays strictly post-commit.
         *
         * These cases run against a real database in a scratch org. Deferred live-PG
         * execution command (schema-ready throwaway database):
         *   eval "$(scripts/testdb.sh new)" && NODE_ENV=test node --import tsx --test --test-force-exit web/lib/file-audit.test.ts web/lib/file-cabinet.private-boundary.integration.test.ts
         * (with OPENBOOKS_TRUSTED_TEST_BYPASS=1 exported for the trusted test boundary;
         * npm test supplies it).
         */

        /** Probe + (if needed) bootstrap the schema, then run one scenario child. Same
         *  environment contract as the boundary test above. */
        function runCabinetAtomicityScenario(source: string): void {
          const probe = spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
              import pg from "pg";
              const client = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL });
              await client.connect();
              const r = await client.query("select to_regclass('public.folders') is not null as ok");
              console.log("BOOTSTRAP_NEEDED=" + (!r.rows[0].ok));
              await client.end();
              `,
            ],
            { cwd: process.cwd(), env: process.env, encoding: "utf8" },
          );
          assert.equal(probe.status, 0, probe.stderr || probe.stdout);
          if (/BOOTSTRAP_NEEDED=true/.test(probe.stdout)) {
            const bootstrapped = spawnSync(process.execPath, ["--import", "tsx", "scripts/bootstrap.ts"], {
              cwd: process.cwd(),
              env: {
                ...process.env,
                NODE_ENV: "test",
                ORG_NAME: "OpenBooks Test",
                ORG_CURRENCY: "CAD",
                ORG_COUNTRY: "CA",
              },
              encoding: "utf8",
            });
            assert.equal(bootstrapped.status, 0, bootstrapped.stderr || bootstrapped.stdout);
          }
          const result = spawnSync(
            process.execPath,
            [
              "--conditions=react-server",
              "--import",
              "tsx",
              "--import",
              "./engine/src/testing/database-bypass.ts",
              "--input-type=module",
              "-e",
              source,
            ],
            { cwd: process.cwd(), env: process.env, encoding: "utf8" },
          );
          assert.equal(result.status, 0, result.stderr || result.stdout);
        }

        /** Shared fixture: a folder holding a file with two DB-stored versions —
         *  everything a purge must account for before any links are added. */
        const FILE_FIXTURE = `
          const actor = randomUUID();
          const folderId = randomUUID();
          const fileId = randomUUID();
          await db.execute(sql\`
            insert into folders (id, org_id, parent_folder_id, name)
            values (\${folderId}, \${orgId}, null, 'atomicity')
          \`);
          await db.execute(sql\`
            insert into files (id, org_id, folder_id, name, content_type, size_bytes)
            values (\${fileId}, \${orgId}, \${folderId}, \${fileName}, 'text/plain', 9)
          \`);
          for (let v = 1; v <= 2; v++) {
            const versionId = randomUUID();
            await db.execute(sql\`
              insert into file_versions (id, file_id, version_number, size_bytes, content_type, content_hash)
              values (\${versionId}, \${fileId}, \${v}, 9, 'text/plain', \${"hash-" + v})
            \`);
            await db.execute(sql\`insert into file_blobs (version_id, bytes) values (\${versionId}, 'payload')\`);
          }
          await db.execute(sql\`
            update files set current_version_id = (
              select id from file_versions where file_id = \${fileId} and version_number = 2
            ) where id = \${fileId}
          \`);
        `;

        /** Shared fixture: a folder holding a file with two DB-stored versions and an
         *  attachment link — everything a purge must account for. */
        const PURGE_FIXTURE = `${FILE_FIXTURE}
          await db.execute(sql\`
            insert into file_attachments (org_id, file_id, target_table, target_id)
            values (\${orgId}, \${fileId}, 'documents', \${linkTarget})
          \`);
        `;

        const COUNTS_QUERY = `
          const counts = (await db.execute(sql\`
            select
              (select count(*)::int from files where id = \${fileId}) as files,
              (select count(*)::int from file_versions where file_id = \${fileId}) as versions,
              (select count(*)::int from file_blobs where version_id in (
                select id from file_versions where file_id = \${fileId}
              )) as blobs,
              (select count(*)::int from file_attachments where file_id = \${fileId}) as links
          \`)).rows[0];
        `;

        test(
          "forced purge-audit failure leaves every purged row intact (fail-closed atomicity)",
          { skip: !env.OPENBOOKS_DB_URL },
          () => {
            runCabinetAtomicityScenario(`
              import assert from "node:assert/strict";
              import { randomUUID } from "node:crypto";
              import { sql } from "drizzle-orm";
              import { db } from "./engine/src/platform/db.ts";
              import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
              import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";
              import { purgeFile } from "./web/lib/file-cabinet/index.ts";

              installTrustedTestDatabaseBypass();

              const org = await createScratchOrg();
              const orgId = org.orgId;
              try {
                const fileName = "doomed.txt";
                const linkTarget = randomUUID();
                ${PURGE_FIXTURE}

                // Force the audit insert to fail for THIS org's purge events. Utility
                // statements cannot take bind parameters, so the org scope is inlined
                // after asserting its shape.
                assert.match(orgId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
                await db.execute(sql.raw(\`
                  create function openbooks_test_block_purge_audit() returns trigger
                  language plpgsql as $fn$ begin raise exception 'forced audit failure'; end $fn$
                \`));
                await db.execute(sql.raw(\`
                  create trigger block_purge_audit before insert on audit_log for each row
                  when (new.org_id = '\${orgId}'::uuid and new.table_name = 'files'
                        and new.changes->>'event' = 'purge')
                  execute function openbooks_test_block_purge_audit()
                \`));

                // THE DEFECT: pre-fix, the deletes committed first and only the route's
                // second autocommit audit failed afterwards — rows gone forever while
                // the caller saw an error. The combined verb must abort the WHOLE unit.
                await assert.rejects(
                  () => purgeFile(orgId, fileId, { actorId: actor }),
                  (error) => /forced audit failure/.test(String((error && error.cause) || error)),
                );

                // Committed state after the rejected purge: nothing deleted anywhere.
                ${COUNTS_QUERY}
                assert.equal(counts.files, 1, "mutation rolled back: the file row survives");
                assert.equal(counts.versions, 2, "both versions survive the aborted purge");
                assert.equal(counts.blobs, 2, "both blobs survive the aborted purge");
                assert.equal(counts.links, 1, "the attachment link survives the aborted purge");
                const evidence = (await db.execute(sql\`
                  select count(*)::int as n from audit_log
                   where table_name = 'files' and row_id = \${fileId}
                \`)).rows[0].n;
                assert.equal(evidence, 0, "the failed audit left no partial evidence");
              } finally {
                await db.execute(sql\`drop trigger if exists block_purge_audit on audit_log\`);
                await db.execute(sql\`drop function if exists openbooks_test_block_purge_audit()\`);
                await dropScratchOrg(orgId);
              }
            `);
          },
        );

        test(
          "successful purge commits redacted before/link/version evidence atomically",
          { skip: !env.OPENBOOKS_DB_URL },
          () => {
            runCabinetAtomicityScenario(`
              import assert from "node:assert/strict";
              import { randomUUID } from "node:crypto";
              import { sql } from "drizzle-orm";
              import { db } from "./engine/src/platform/db.ts";
              import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
              import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";
              import { purgeFile } from "./web/lib/file-cabinet/index.ts";

              installTrustedTestDatabaseBypass();

              const org = await createScratchOrg();
              const orgId = org.orgId;
              try {
                const fileName = "kept-evidence.txt";
                const linkTarget = randomUUID();
                ${PURGE_FIXTURE}

                assert.equal(await purgeFile(orgId, fileId, { actorId: actor }), 'purged');

                // Committed state after the successful purge: all rows gone.
                ${COUNTS_QUERY}
                assert.equal(counts.files, 0, "the file row is gone");
                assert.equal(counts.versions, 0, "all versions are gone");
                assert.equal(counts.blobs, 0, "all blobs are gone");
                assert.equal(counts.links, 0, "attachment links are gone");

                // Exactly one durable evidence row retains the redacted before-state.
                const rows = (await db.execute(sql\`
                  select action, actor_id as "actorId", changes
                    from audit_log where table_name = 'files' and row_id = \${fileId}
                \`)).rows;
                assert.equal(rows.length, 1, "exactly one durable purge evidence row");
                const evidence = rows[0];
                assert.equal(evidence.action, "delete");
                assert.equal(evidence.changes.event, "purge");
                assert.equal(evidence.changes.permanent, true);
                assert.equal(String(evidence.actorId), actor, "evidence names the actor");
                assert.equal(evidence.changes.before.file.name, fileName);
                assert.equal(evidence.changes.before.file.contentType, "text/plain");
                assert.equal(evidence.changes.before.file.sizeBytes, 9);
                assert.deepEqual(
                  evidence.changes.before.versions.map((v) => [v.versionNumber, v.contentHash]),
                  [[1, "hash-1"], [2, "hash-2"]],
                  "version inventory survives the purge",
                );
                assert.deepEqual(
                  evidence.changes.before.attachments,
                  [{ targetTable: "documents", targetId: linkTarget }],
                  "attachment links survive the purge as evidence",
                );
                // Redacted: metadata only — no blob payload key anywhere in the evidence.
                assert.ok(!/"bytes"/.test(JSON.stringify(evidence)), "evidence carries no blob bytes");
              } finally {
                await dropScratchOrg(orgId);
              }
            `);
          },
        );

        /**
         * Regression coverage for the permanent-purge retention defect in
         * web/lib/file-cabinet.ts: purgeFile used to permit any file not referenced by
         * ap_capture_items and then delete all file_attachments, versions, blobs, and
         * the file — so evidence attached to a POSTED document (or a live compliance
         * record or fixed asset) could be permanently destroyed from the ?purge=1
         * route. The purge now refuses, before any delete, while any attachment
         * targets a posted document, a non-superseded compliance record, or a fixed
         * asset; superseded compliance records do not block (controlled renewal), and
         * unbound files stay purgeable.
         */
        test(
          "purge refuses while any attachment targets a posted document (zero deletion)",
          { skip: !env.OPENBOOKS_DB_URL },
          () => {
            runCabinetAtomicityScenario(`
              import assert from "node:assert/strict";
              import { randomUUID } from "node:crypto";
              import { sql } from "drizzle-orm";
              import { db } from "./engine/src/platform/db.ts";
              import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
              import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";
              import { purgeFile } from "./web/lib/file-cabinet/index.ts";

              installTrustedTestDatabaseBypass();

              const org = await createScratchOrg();
              const orgId = org.orgId;
              try {
                // A real POSTED document. Its posting period must belong to the
                // scratch org now that document posting references are tenant-coherent.
                const documentId = randomUUID();
                const postedEntryId = randomUUID();
                await db.execute(sql\`
                  insert into journal_entries
                    (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
                     period_id, memo, status, origin)
                  values (\${postedEntryId}, \${orgId}, \${org.bookId}, \${org.subsidiaryId},
                          'RETAIN-ENTRY', current_date, \${org.periodId}, 'retention fixture',
                          'draft', 'manual')
                \`);
                await db.execute(sql\`
                  insert into documents (id, org_id, kind, document_number, document_date,
                                         currency, status, posted_entry_id, posting_period_id)
                  values (\${documentId}, \${orgId}, 'vendor_bill', 'RETAIN-1', current_date,
                          'USD', 'posted', \${postedEntryId}, \${org.periodId})
                \`);
                const fileName = "posted-evidence.txt";
                const linkTarget = documentId;
                ${PURGE_FIXTURE}

                // THE DEFECT: pre-fix this returned true with every row destroyed.
                // The guard must refuse BEFORE any delete runs — through the same
                // audited verb the ?purge=1 route exposes.
                assert.equal(await purgeFile(orgId, fileId, { actorId: actor }), 'retained');

                // Committed state after the refused purge: file, versions, blobs, and
                // the attachment link all survive intact.
                ${COUNTS_QUERY}
                assert.equal(counts.files, 1, "the file row survives");
                assert.equal(counts.versions, 2, "both versions survive");
                assert.equal(counts.blobs, 2, "both blobs survive");
                assert.equal(counts.links, 1, "the attachment link survives");
                const evidence = (await db.execute(sql\`
                  select count(*)::int as n from audit_log
                   where table_name = 'files' and row_id = \${fileId}
                \`)).rows[0].n;
                assert.equal(evidence, 0, "a refused purge writes no purge evidence");
              } finally {
                await dropScratchOrg(orgId);
              }
            `);
          },
        );

        test(
          "unbound files stay purgeable",
          { skip: !env.OPENBOOKS_DB_URL },
          () => {
            runCabinetAtomicityScenario(`
              import assert from "node:assert/strict";
              import { randomUUID } from "node:crypto";
              import { sql } from "drizzle-orm";
              import { db } from "./engine/src/platform/db.ts";
              import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
              import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";
              import { purgeFile } from "./web/lib/file-cabinet/index.ts";

              installTrustedTestDatabaseBypass();

              const org = await createScratchOrg();
              const orgId = org.orgId;
              try {
                const fileName = "disposable.txt";
                ${FILE_FIXTURE}

                // Control: with no attachment links at all the guard does not fire and
                // the disposable file purges cleanly.
                assert.equal(await purgeFile(orgId, fileId), 'purged');

                ${COUNTS_QUERY}
                assert.equal(counts.files, 0, "the unbound file is gone");
                assert.equal(counts.versions, 0, "all versions are gone");
                assert.equal(counts.blobs, 0, "all blobs are gone");
                assert.equal(counts.links, 0, "there were never any links to lose");
              } finally {
                await dropScratchOrg(orgId);
              }
            `);
          },
        );
  } },
] as const;

for (const row of consolidatedRows) await row.register();

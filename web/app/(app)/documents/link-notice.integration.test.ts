import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// F4T-17 behaviour coverage (integration partition): the documents loader
// carries linkNotice exactly when a ?file= / ?folder= deep link names
// nothing resolvable — and never when the link resolves or is absent.
const stateKey = Symbol.for('openbooks.documents-link-notice-test')
interface TestState {
  permissions: string[]
}
const testState: TestState = { permissions: ['documents.read', 'documents.manage'] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = testState

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next-intl/server') {
      return { shortCircuit: true, format: 'module', url: 'mock:intl' }
    }
    if (
      specifier === '../../../lib/authz' &&
      context.parentURL?.endsWith('/documents/view.ts')
    ) {
      return { shortCircuit: true, format: 'module', url: 'mock:authz' }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'mock:intl') {
      return {
        shortCircuit: true,
        format: 'module',
        source: 'export async function getTranslations() { return (key) => key }',
      }
    }
    if (url === 'mock:authz') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `
          const state = globalThis[Symbol.for('openbooks.documents-link-notice-test')]
          export async function requirePermission() {
            return { user: { orgId: globalThis.__linkNoticeOrgId, id: globalThis.__linkNoticeActor }, permissions: state.permissions, allowedSubsidiaryIds: null }
          }
          export function can(authz, perm) {
            return authz.permissions.includes('*') || authz.permissions.includes(perm)
          }
        `,
      }
    }
    return next(url, context)
  },
})

const { loadDocuments } = await import('./view.ts')
const { db } = await import('../../../../engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, createScratchUser } = await import(
  '../../../../engine/src/testing/fixtures.ts'
)

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

async function seedFile(orgId: string): Promise<string> {
  const folderId = randomUUID()
  const fileId = randomUUID()
  const versionId = randomUUID()
  await db.execute(sql`
    insert into folders (id, org_id, parent_folder_id, name, is_system, record_table, record_id)
    values (${folderId}, ${orgId}, null, 'link notice probe', false, null, null)`)
  await db.execute(sql`
    insert into files (id, org_id, folder_id, name, content_type, size_bytes)
    values (${fileId}, ${orgId}, ${folderId}, 'probe.txt', 'text/plain', 5)`)
  await db.execute(sql`
    insert into file_versions (id, file_id, version_number, content_type, size_bytes, storage_kind)
    values (${versionId}, ${fileId}, 1, 'text/plain', 5, 'db')`)
  await db.execute(sql`insert into file_blobs (version_id, bytes) values (${versionId}, 'aGVsbG8='::bytea)`)
  await db.execute(sql`update files set current_version_id = ${versionId} where id = ${fileId} and org_id = ${orgId}`)
  return fileId
}

test('a ?file= naming nothing resolvable notices with every drawer closed', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Link Clerk', 'link_clerk')
    ;(globalThis as Record<string, unknown>).__linkNoticeOrgId = org.orgId
    ;(globalThis as Record<string, unknown>).__linkNoticeActor = actor
    testState.permissions = ['documents.read', 'documents.manage']
    const data = await loadDocuments({ file: randomUUID() })
    assert.ok(data.linkNotice, 'a missing file id notices')
    assert.equal(data.fileDrawer, null)
    assert.equal(data.fileDrawerOpen, false)
    const malformed = await loadDocuments({ file: 'not-a-uuid' })
    assert.ok(malformed.linkNotice, 'a malformed file id notices')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('a ?file= that resolves opens the drawer with no notice', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Link Clerk', 'link_clerk')
    ;(globalThis as Record<string, unknown>).__linkNoticeOrgId = org.orgId
    ;(globalThis as Record<string, unknown>).__linkNoticeActor = actor
    testState.permissions = ['documents.read', 'documents.manage']
    const fileId = await seedFile(org.orgId)
    const data = await loadDocuments({ file: fileId })
    assert.equal(data.linkNotice, null)
    assert.equal(data.fileDrawerOpen, true)
    assert.ok(data.fileDrawer)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('?folder=new without manage notices instead of opening the create drawer', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Link Reader', 'link_reader')
    ;(globalThis as Record<string, unknown>).__linkNoticeOrgId = org.orgId
    ;(globalThis as Record<string, unknown>).__linkNoticeActor = actor
    testState.permissions = ['documents.read']
    const data = await loadDocuments({ folder: 'new' })
    assert.ok(data.linkNotice, 'new without manage notices')
    assert.equal(data.folderDrawerCreate, null)
    assert.equal(data.folderDrawerCreateOpen, false)
    testState.permissions = ['documents.read', 'documents.manage']
    const managed = await loadDocuments({ folder: 'new' })
    assert.equal(managed.linkNotice, null)
    assert.equal(managed.folderDrawerCreateOpen, true)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('no drawer param leaves no notice', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Link Clerk', 'link_clerk')
    ;(globalThis as Record<string, unknown>).__linkNoticeOrgId = org.orgId
    ;(globalThis as Record<string, unknown>).__linkNoticeActor = actor
    testState.permissions = ['documents.read']
    const data = await loadDocuments({})
    assert.equal(data.linkNotice, null)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, onTransactionRollback, withOrg, withOrgTransaction } from '../platform/db.ts'
import { createScratchOrg, createScratchUser, dropScratchOrg } from '../testing/fixtures.ts'
import { PartyPhotoRefusal, readPartyPhoto, removePartyPhoto, storePartyPhoto, type ConnectorPhotoSource } from '../organization/party-photos.ts'
import { syncSourcePartyPhotos } from './party-photos.ts'
import { loadEntities } from './migrate.ts'
import type { MigrationSource } from './source.ts'

const DB = Boolean(process.env.OPENBOOKS_DB_URL)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1foAAAAASUVORK5CYII=', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

async function fixture() {
  const org = await createScratchOrg()
  const actorId = await createScratchUser(org.orgId, 'Photo operator', 'photo_operator')
  const rows = await withOrg(org.orgId, async () => {
    const grants = await db.execute(sql`update app_roles set permissions='["sync.run","parties.read","parties.manage"]'::jsonb
      where org_id=${org.orgId} and key='photo_operator' returning id`)
    assert.equal(grants.rows.length,1)
    const principal = (await db.execute<{ is_active: boolean }>(sql`select is_active from users where org_id=${org.orgId} and id=${actorId}`)).rows[0]
    assert.equal(principal?.is_active,true)
    const connection = (await db.execute<{ id: string }>(sql`
      insert into connections (org_id,source,display_name,auth_kind,status,config)
      values (${org.orgId},'netsuite','Photo source','token','active','{"account":"photo-account","baseCurrency":"CAD"}'::jsonb) returning id`)).rows[0]!
    const party = (await db.execute<{ id: string }>(sql`
      insert into parties (org_id,kind,display_name,custom)
      values (${org.orgId},'person','Source employee','{"source":{"system":"netsuite","externalId":"100"},"nsId":"100"}'::jsonb) returning id`)).rows[0]!
    await db.execute(sql`insert into employee_roles (org_id,party_id) values (${org.orgId},${party.id})`)
    return { connectionId: connection.id, partyId: party.id }
  })
  const source: ConnectorPhotoSource = { system: 'netsuite', connectionId: rows.connectionId, account: 'photo-account', refKey: 'nsId', externalId: '100', fileId: '500', runId: null }
  return { orgId: org.orgId, actorId, ...rows, source }
}

async function counts(orgId: string, partyId: string) {
  return withOrg(orgId, async () => {
    const files = (await db.execute<{ n: number }>(sql`select count(*)::int as n from file_attachments where org_id=${orgId} and target_table='parties' and target_id=${partyId}`)).rows[0]!.n
    const audit = (await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where org_id=${orgId} and table_name='parties' and row_id=${partyId} and changes->>'mode'='party_photo'`)).rows[0]!.n
    return { files, audit }
  })
}

function adapter(bytes = PNG): MigrationSource {
  return {
    name: 'netsuite', refKey: 'nsId', baseCurrency: 'CAD', photoSourceAccount: 'photo-account',
    partyPhotos: async () => [{ partyRef: '100', fileRef: '500' }],
    partyPhotoContent: async () => ({ filename: 'employee.png', bytes }),
    entities: async () => [], accountingPeriods: async () => [],
  } as unknown as MigrationSource
}

test('source photo replay preserves the file URL, versions and audit; changed content retains prior history', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const input = { ...f, filename: 'employee.png', bytes: PNG, source: f.source }
    const first = await storePartyPhoto(input)
    assert.equal(first.status, 'attached')
    const before = await counts(f.orgId, f.partyId)
    const replay = await storePartyPhoto(input)
    assert.equal(replay.status, 'unchanged')
    assert.equal(replay.photoFileId, first.photoFileId)
    assert.deepEqual(await counts(f.orgId, f.partyId), before)
    const readback = await readPartyPhoto(f)
    assert.ok(readback?.bytes.equals(PNG))
    const changed = await storePartyPhoto({ ...input, bytes: GIF, filename: 'employee.gif', expectedPhotoFileId: first.photoFileId })
    assert.equal(changed.status, 'attached')
    assert.notEqual(changed.photoFileId, first.photoFileId)
    assert.deepEqual(await counts(f.orgId, f.partyId), { files: before.files + 1, audit: before.audit + 1 })
    assert.ok((await readPartyPhoto(f))?.bytes.equals(GIF))
  } finally { await dropScratchOrg(f.orgId) }
})

test('manual photos and removals survive ongoing source synchronization', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const manual = await storePartyPhoto({ ...f, source: undefined, filename: 'manual.gif', bytes: GIF })
    const before = await counts(f.orgId, f.partyId)
    const conflict = await storePartyPhoto({ ...f, filename: 'source.png', bytes: PNG })
    assert.equal(conflict.status, 'conflict')
    assert.equal(conflict.photoFileId, manual.photoFileId)
    assert.deepEqual(await counts(f.orgId, f.partyId), before)
    await removePartyPhoto(f)
    const removed = await counts(f.orgId, f.partyId)
    const repeated = await storePartyPhoto({ ...f, filename: 'source.png', bytes: PNG })
    assert.equal(repeated.status, 'conflict')
    assert.equal(repeated.photoFileId, null)
    assert.equal(await readPartyPhoto(f), null)
    assert.deepEqual(await counts(f.orgId, f.partyId), removed)
  } finally { await dropScratchOrg(f.orgId) }
})

test('a concurrent photo change and a changed stable employee identity refuse source replacement', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const first = await storePartyPhoto({ ...f, filename: 'source.png', bytes: PNG })
    const stale = await storePartyPhoto({ ...f, filename: 'changed.gif', bytes: GIF, expectedPhotoFileId: null })
    assert.equal(stale.status, 'conflict')
    assert.equal(stale.photoFileId, first.photoFileId)
    await assert.rejects(storePartyPhoto({ ...f, filename: 'source.png', bytes: PNG, source: { ...f.source, externalId: '101' } }), /stable connector identity changed/)
    const replay = await syncSourcePartyPhotos(adapter(), { ...f, runId: null, execute: true })
    assert.equal(replay.unchanged, 1)
    assert.equal(replay.verified, 1)
    assert.equal(replay.errors, 0)
  } finally { await dropScratchOrg(f.orgId) }
})

test('photo lookup never matches a display name or another provider and cannot cross organizations', { skip: !DB }, async () => {
  const f = await fixture()
  const other = await createScratchOrg()
  try {
    await withOrg(f.orgId, () => db.execute(sql`update parties set custom='{"source":{"system":"other-provider","externalId":"100"}}'::jsonb where org_id=${f.orgId} and id=${f.partyId}`))
    const result = await syncSourcePartyPhotos(adapter(), { ...f, runId: null, execute: true })
    assert.equal(result.unmatched, 1)
    assert.equal(result.attached, 0)
    const before = await counts(f.orgId,f.partyId)
    const deniedAccount = (error: unknown) => error instanceof PartyPhotoRefusal && error.status===403
      && error.message.includes('does not match this organization’s connector account')
    await assert.rejects(storePartyPhoto({ ...f, orgId: other.orgId, filename: 'source.png', bytes: PNG }), deniedAccount)
    await assert.rejects(readPartyPhoto({ ...f, orgId: other.orgId }), deniedAccount)
    assert.deepEqual(await counts(f.orgId,f.partyId),before)
    assert.deepEqual(await counts(other.orgId,f.partyId),{ files: 0,audit: 0 })
  } finally { await dropScratchOrg(other.orgId); await dropScratchOrg(f.orgId) }
})

test('native permission changes refuse imports and photo mutations before writing', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    await withOrg(f.orgId, () => db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${f.orgId},${f.actorId},'parties.manage','deny')`))
    await assert.rejects(storePartyPhoto({ ...f, filename: 'source.png', bytes: PNG }), /not found/)
    await assert.rejects(syncSourcePartyPhotos(adapter(), { ...f, runId: null, execute: true }), /parties.manage/)
    assert.deepEqual(await counts(f.orgId, f.partyId), { files: 0, audit: 0 })
  } finally { await dropScratchOrg(f.orgId) }
})

test('missing source photos and failed file downloads have different outcomes and preserve the destination', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const source = adapter()
    source.partyPhotos = async () => [{ partyRef: '100', fileRef: null }, { partyRef: '101', fileRef: '501' }]
    const noMapping = await syncSourcePartyPhotos(source, { ...f, runId: null, execute: true })
    assert.equal(noMapping.sourceWithoutPhoto, 1)
    assert.equal(noMapping.unmatched, 1)
    source.partyPhotos = async () => [{ partyRef: '100', fileRef: '500' }]
    source.partyPhotoContent = async () => { throw new Error('NetSuite file 500 access denied by the integration role') }
    const failed = await syncSourcePartyPhotos(source, { ...f, runId: null, execute: true })
    assert.equal(failed.errors, 1)
    assert.match(failed.details[0]!.reason!, /access denied by the integration role/)
    assert.deepEqual(await counts(f.orgId, f.partyId), { files: 0, audit: 0 })
  } finally { await dropScratchOrg(f.orgId) }
})

test('normal master-data migration invokes photo synchronization after employee identity resolution', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const result = await withOrg(f.orgId, () => loadEntities(adapter(), f.orgId, null, undefined, {
      connectionId: f.connectionId, runId: f.connectionId, actorId: f.actorId, sourceName: 'netsuite',
    }, [{ resource: 'parties', records: [{ sourceRef: '100', fields: { displayName: 'Source employee', kind: 'person', employeeRole: {} } }] }]))
    assert.equal(result.employee_photos?.photos?.attached, 1)
    assert.equal(result.employee_photos?.photos?.verified, 1)
    assert.equal(result.employee_photos?.failed, 0)
    assert.ok((await readPartyPhoto(f))?.bytes.equals(PNG))
  } finally { await dropScratchOrg(f.orgId) }
})

test('photo synchronization sees a newly adopted employee inside the owning master-data transaction', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const source = adapter()
    source.partyPhotos = async () => [{ partyRef: '102',fileRef: '502' }]
    const stats = await withOrg(f.orgId, () => loadEntities(source,f.orgId,null,undefined,
      { connectionId: f.connectionId,runId: f.connectionId,actorId: f.actorId,sourceName: 'netsuite' },
      [{ resource: 'parties',records: [{ sourceRef: '102',fields: { displayName: 'New source employee',kind: 'person',employeeRole: {} } }] }],
      undefined,{ employeeRefs: ['102'] }))
    assert.equal(stats.parties!.created,1)
    assert.equal(stats.employee_photos!.photos!.attached,1)
    assert.equal(stats.employee_photos!.photos!.verified,1)
    assert.equal(stats.employee_photos!.failed,0)
  } finally { await dropScratchOrg(f.orgId) }
})

test('scoped employee refresh lands source service dates and preserves other inactive employees', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const inactive = await withOrg(f.orgId, async () => {
      const row = (await db.execute<{ id: string }>(sql`insert into parties(org_id,kind,display_name,is_active,custom)
        values(${f.orgId},'person','Inactive source employee',false,'{"nsId":"101"}'::jsonb) returning id`)).rows[0]!
      await db.execute(sql`insert into employee_roles(org_id,party_id,is_active) values(${f.orgId},${row.id},false)`)
      return row.id
    })
    const source = adapter()
    source.partyPhotos = async () => [{ partyRef: '100',fileRef: null }]
    const stats = await withOrg(f.orgId, () => loadEntities(source,f.orgId,null,undefined,
      { connectionId: f.connectionId,runId: f.connectionId,actorId: f.actorId,sourceName: 'netsuite' },
      [{ resource: 'parties',records: [{ sourceRef: '100',fields: { displayName: 'Source employee',kind: 'person',isActive: true,employeeRole: { hiredOn: '2026-08-24',terminatedOn: null } } }] }],
      undefined,{ employeeRefs: ['100'] }))
    assert.equal(stats.parties!.failed,0)
    const roles = await withOrg(f.orgId, async () => (await db.execute(sql`select p.id,p.is_active,e.hired_on::text,e.terminated_on::text,e.is_active as role_active
      from parties p join employee_roles e on e.org_id=p.org_id and e.party_id=p.id where p.org_id=${f.orgId} and p.id in (${f.partyId},${inactive})`)).rows)
    assert.equal(roles.find(row => row.id===f.partyId)?.hired_on,'2026-08-24')
    assert.equal(roles.find(row => row.id===f.partyId)?.terminated_on,null)
    assert.equal(roles.find(row => row.id===inactive)?.is_active,false)
    assert.equal(roles.find(row => row.id===inactive)?.role_active,false)
  } finally { await dropScratchOrg(f.orgId) }
})

test('display derivatives retain private originals and source-content replay adds no files', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const input = { ...f,filename: 'display.gif',bytes: GIF,original: { filename: 'original.png',bytes: PNG } }
    const first = await storePartyPhoto(input)
    assert.equal(first.status,'attached')
    const original = await readPartyPhoto({ ...f,original: true })
    assert.ok(original?.bytes.equals(PNG))
    const before = await counts(f.orgId,f.partyId)
    assert.equal(before.files,2)
    const replay = await storePartyPhoto({ ...input,bytes: PNG })
    assert.equal(replay.status,'unchanged')
    assert.equal(replay.photoFileId,first.photoFileId)
    assert.deepEqual(await counts(f.orgId,f.partyId),before)
    assert.ok((await readPartyPhoto(f))?.bytes.equals(GIF))
  } finally { await dropScratchOrg(f.orgId) }
})

test('a rolled-back native party photo command leaves no attachment or photo pointer', { skip: !DB }, async () => {
  const f = await fixture()
  let compensated = 0
  try {
    await assert.rejects(withOrgTransaction(f.orgId, async () => {
      onTransactionRollback(async () => { compensated++ })
      await storePartyPhoto({ ...f, filename: 'source.png', bytes: PNG })
      throw new Error('Discard transaction')
    }), /Discard transaction/)
    assert.deepEqual(await counts(f.orgId, f.partyId), { files: 0, audit: 0 })
    assert.equal(await readPartyPhoto(f), null)
    assert.equal(compensated,1)
  } finally { await dropScratchOrg(f.orgId) }
})

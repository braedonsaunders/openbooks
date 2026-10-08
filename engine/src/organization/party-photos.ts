import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, onTransactionRollback, withOrgTransaction, type SqlExecutor } from '../platform/db.ts'
import { uploadCabinetAttachment } from '../platform/record-attachments.ts'
import { fileCabinetObjectKey, getS3Blob, refuseMaskedStorageKind } from '../platform/file-storage.ts'
import { enqueueStorageCleanupStandalone } from '../platform/storage-cleanup.ts'
import { lockActorCommandAuthority } from './actor-command-authority.ts'
import { actorAllowedSubsidiaryIds } from './actor-subsidiaries.ts'
import { actorHasPermission } from './actor-permissions.ts'
import { lockScopeRow, ScopeNotFoundError } from './subsidiary-scope.ts'

export const MAX_PARTY_PHOTO_BYTES = 5 * 1024 * 1024
export const PARTY_PHOTO_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export class PartyPhotoRefusal extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = 'PartyPhotoRefusal' }
}

/** Only browser-renderable raster bytes may be used as the current party photo. */
export function partyPhotoContentType(bytes: Buffer): string {
  if (bytes.length > MAX_PARTY_PHOTO_BYTES) throw new PartyPhotoRefusal('Use an image of 5 MB or less.', 413)
  return rasterPhotoContentType(bytes)
}

export function rasterPhotoContentType(bytes: Buffer): string {
  if (!bytes.length) throw new PartyPhotoRefusal('The photo file is empty.', 422)
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  const header = bytes.subarray(0, 12).toString('ascii')
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif'
  if (bytes.length >= 12 && header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp'
  throw new PartyPhotoRefusal('Use a PNG, JPEG, WebP or GIF image; the source bytes are not a supported photo.', 415)
}

export interface ConnectorPhotoSource {
  system: string
  connectionId: string
  account: string
  refKey: string
  externalId: string
  fileId: string
  runId: string | null
}

type Ownership = { mode?: string; system?: string; connectionId?: string; account?: string; externalId?: string; fileId?: string; contentHash?: string; sourceFileId?: string; sourceContentHash?: string; originalFileId?: string }

async function auditPhoto(orgId: string, actorId: string | null, partyId: string, before: unknown, after: unknown, reason: string, source?: ConnectorPhotoSource) {
  const event = await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (${orgId}, 'parties', ${partyId}, 'update',
      ${JSON.stringify({ mode: 'party_photo', reason, before, after, ...(source ? { source } : {}) })}::jsonb,
      ${actorId}, ${source ? 'sync' : 'ui'}) returning id`)
  if (event.rows.length !== 1) throw new Error('Party photo audit did not persist')
}

async function assertPhotoConnection(tx: SqlExecutor, orgId: string, source: ConnectorPhotoSource) {
  const connection = (await tx.execute<{ account: string }>(sql`
    select config->>'account' as account from connections
    where org_id=${orgId} and id=${source.connectionId} and source=${source.system} for share`)).rows[0]
  if (!connection || connection.account?.replaceAll('_', '-').toLowerCase() !== source.account.replaceAll('_', '-').toLowerCase()) {
    throw new PartyPhotoRefusal('The photo source does not match this organization’s connector account.', 403)
  }
}

async function authorizePhoto(tx: SqlExecutor, orgId: string, actorId: string | null, partyId: string, source?: ConnectorPhotoSource) {
  if (source) {
    await assertPhotoConnection(tx, orgId, source)
  }
  if (actorId) {
    const permission = source ? 'sync.run' : 'parties.manage'
    const subsidiary = (await tx.execute<{ subsidiary_id: string | null }>(sql`select subsidiary_id from parties where org_id=${orgId} and id=${partyId}`)).rows[0]
    if (!subsidiary) throw new ScopeNotFoundError()
    const scope = await lockActorCommandAuthority(tx, orgId, actorId, subsidiary.subsidiary_id, permission)
    if (!await actorHasPermission(tx, orgId, actorId, 'parties.manage')) throw new ScopeNotFoundError()
    if (source && scope !== null) throw new PartyPhotoRefusal('Connector employee photos require unrestricted subsidiary access.', 403)
    await lockScopeRow(tx, orgId, 'party', partyId, scope, 'update', { orgWideNull: true })
  } else if (!source) {
    throw new ScopeNotFoundError()
  }
}

/**
 * A source owns only photos it installed and whose pointer and content still
 * match its ownership evidence. Manual uploads, removals and cabinet edits
 * take precedence. New source content is a new retained file and URL.
 */
export async function storePartyPhoto(input: {
  orgId: string; partyId: string; actorId: string | null
  filename: string; bytes: Buffer; contentType?: string
  source?: ConnectorPhotoSource
  original?: { filename: string; bytes: Buffer }
  expectedPhotoFileId?: string | null
}) {
  const contentType = partyPhotoContentType(input.bytes)
  if (input.contentType && input.contentType !== contentType) throw new PartyPhotoRefusal('The photo content does not match its declared image type.', 415)
  const contentHash = createHash('sha256').update(input.bytes).digest('hex')
  if (input.original && (!input.source || input.original.bytes.length > 25 * 1024 * 1024)) throw new PartyPhotoRefusal('Source originals require a connector and an image of 25 MB or less.', 413)
  const originalContentType = input.original ? rasterPhotoContentType(input.original.bytes) : null
  const sourceContentHash = createHash('sha256').update(input.original?.bytes ?? input.bytes).digest('hex')
  const staged: { versionId: string; fileId: string }[] = []
  return withOrgTransaction(input.orgId, async () => {
      await authorizePhoto(db, input.orgId, input.actorId, input.partyId, input.source)
      const party = (await db.execute<{ photo_file_id: string | null; ownership: Ownership | null; custom: Record<string, unknown> }>(sql`
        select photo_file_id::text, custom->'photoOwnership' as ownership, custom from parties
        where org_id=${input.orgId} and id=${input.partyId} for update`)).rows[0]
      if (!party) throw new ScopeNotFoundError()
      const ownership = party.ownership
      if (input.source) {
        const source = input.source
        const canonical = party.custom.source as { system?: string; externalId?: string } | undefined
        const mappedRef = party.custom[source.refKey]
        if ((mappedRef != null && String(mappedRef) !== source.externalId)
          || (mappedRef == null && !(canonical?.system === source.system && canonical.externalId === source.externalId))) {
          throw new PartyPhotoRefusal('The employee’s stable connector identity changed; resolve its mapping before importing a photo.')
        }
        const employee = (await db.execute(sql`select id from employee_roles where org_id=${input.orgId} and party_id=${input.partyId}`)).rows[0]
        if (!employee) throw new PartyPhotoRefusal('The mapped party is not an employee in this organization.', 404)
        const owned = ownership?.mode === 'connector' && ownership.system === source.system
          && ownership.connectionId === source.connectionId && ownership.externalId === source.externalId
          && ownership.account?.replaceAll('_','-').toLowerCase() === source.account.replaceAll('_','-').toLowerCase()
          && ownership.fileId === party.photo_file_id
        if (ownership?.mode === 'connector' && !owned) {
          return { status: 'conflict' as const, photoFileId: party.photo_file_id, reason: 'The connector-owned photo pointer was removed or changed. Its attachment history is preserved; review the employee photo before replacing it.' }
        }
        if (ownership?.mode === 'user' || (party.photo_file_id && !owned)) {
          return { status: 'conflict' as const, photoFileId: party.photo_file_id, reason: 'A user-managed photo or removal is preserved.' }
        }
        if (owned && party.photo_file_id) {
          const stored = (await db.execute<{ content_hash: string | null; byte_length: string }>(sql`
            select content_hash, size_bytes::text as byte_length from files where org_id=${input.orgId} and id=${party.photo_file_id} and not is_inactive`)).rows[0]
          if (!stored || stored.content_hash !== ownership?.contentHash) {
            return { status: 'conflict' as const, photoFileId: party.photo_file_id, reason: 'The source-owned photo was edited or removed in the File Cabinet; its current content is preserved.' }
          }
          if ((ownership?.sourceContentHash ?? stored.content_hash) === sourceContentHash && ownership?.sourceFileId === source.fileId) {
            return { status: 'unchanged' as const, photoFileId: party.photo_file_id, contentHash: stored.content_hash, byteLength: Number(stored.byte_length), originalFileId: ownership?.originalFileId }
          }
        }
        if (input.expectedPhotoFileId !== undefined && party.photo_file_id !== input.expectedPhotoFileId) {
          return { status: 'conflict' as const, photoFileId: party.photo_file_id, reason: 'The employee photo changed while source content was being downloaded; refresh before retrying.' }
        }
      }
      onTransactionRollback(async () => {
        for (const object of staged) await enqueueStorageCleanupStandalone({
          orgId: input.orgId, objectKey: fileCabinetObjectKey(object.versionId), ownerKind: 'file_version', ownerId: object.fileId,
        })
      })
      const original = input.original ? await uploadCabinetAttachment({
        orgId: input.orgId, targetTable: 'parties', targetId: input.partyId,
        filename: input.original.filename, contentType: originalContentType!, bytes: input.original.bytes,
        createdBy: input.actorId, executor: db, onStagedS3: value => { staged.push(value) },
      }) : null
      const stored = await uploadCabinetAttachment({
        orgId: input.orgId, targetTable: 'parties', targetId: input.partyId,
        filename: input.filename, contentType, bytes: input.bytes, createdBy: input.actorId,
        executor: db, onStagedS3: value => { staged.push(value) },
      })
      const afterOwnership = input.source ? {
        mode: 'connector', system: input.source.system, connectionId: input.source.connectionId,
        account: input.source.account,
        externalId: input.source.externalId, sourceFileId: input.source.fileId,
        fileId: stored.id, contentHash, sourceContentHash, ...(original ? { originalFileId: original.id } : {}),
      } : { mode: 'user' }
      const updated = await db.execute(sql`
        update parties set photo_file_id=${stored.id}, custom=jsonb_set(custom, '{photoOwnership}', ${JSON.stringify(afterOwnership)}::jsonb, true),
          updated_at=greatest(clock_timestamp(),updated_at + interval '1 microsecond')
        where org_id=${input.orgId} and id=${input.partyId} returning id`)
      if (updated.rows.length !== 1) throw new Error('Party photo did not persist')
      await auditPhoto(input.orgId, input.actorId, input.partyId,
        { photo_file_id: party.photo_file_id, ownership }, { photo_file_id: stored.id, ownership: afterOwnership },
        input.source ? 'employee photo synchronized from connector' : 'photo replaced', input.source)
      return { status: 'attached' as const, photoFileId: stored.id, contentHash, byteLength: input.bytes.length, originalFileId: original?.id }
  })
}

/** A manual removal is durable operator intent; source synchronization preserves it. */
export async function removePartyPhoto(input: { orgId: string; partyId: string; actorId: string }) {
  return withOrgTransaction(input.orgId, async () => {
    await authorizePhoto(db, input.orgId, input.actorId, input.partyId)
    const before = (await db.execute<{ photo_file_id: string | null; ownership: Ownership | null }>(sql`
      select photo_file_id::text, custom->'photoOwnership' as ownership from parties
      where org_id=${input.orgId} and id=${input.partyId} for update`)).rows[0]
    if (!before) throw new ScopeNotFoundError()
    if (before.photo_file_id === null && before.ownership?.mode === 'user') return { photoFileId: null }
    const updated = await db.execute(sql`
      update parties set photo_file_id=null, custom=jsonb_set(custom, '{photoOwnership}', '{"mode":"user"}'::jsonb, true),
        updated_at=greatest(clock_timestamp(),updated_at + interval '1 microsecond')
      where org_id=${input.orgId} and id=${input.partyId} returning id`)
    if (updated.rows.length !== 1) throw new Error('Party photo removal did not persist')
    await auditPhoto(input.orgId, input.actorId, input.partyId, before, { photo_file_id: null, ownership: { mode: 'user' } }, 'photo removed')
    return { photoFileId: null }
  })
}

/** The same authorized read path serves HTTP bytes and native import readback. */
export async function readPartyPhoto(input: { orgId: string; partyId: string; actorId: string | null; source?: ConnectorPhotoSource; original?: boolean }) {
  return withOrgTransaction(input.orgId, async () => {
    if (input.original && !input.source) throw new ScopeNotFoundError()
    if (input.source) await assertPhotoConnection(db, input.orgId, input.source)
    if (input.actorId ? !await actorHasPermission(db, input.orgId, input.actorId, 'parties.read') : !input.source) throw new ScopeNotFoundError()
    const scope = input.actorId ? await actorAllowedSubsidiaryIds(db, input.orgId, input.actorId) : null
    await lockScopeRow(db, input.orgId, 'party', input.partyId, scope, 'share', { orgWideNull: true })
    const row = (await db.execute<{ file_id: string; name: string; content_type: string; version_id: string; storage_kind: string; bytes: Buffer | null }>(sql`
      select f.id::text as file_id, f.name, v.content_type, v.id::text as version_id, v.storage_kind, b.bytes
      from parties p join files f on f.org_id=p.org_id and not f.is_inactive
        and ${input.original ? sql`f.id::text=p.custom->'photoOwnership'->>'originalFileId'
          and p.custom->'photoOwnership'->>'mode'='connector'
          and p.custom->'photoOwnership'->>'system'=${input.source!.system}
          and lower(replace(p.custom->'photoOwnership'->>'account','_','-'))=${input.source!.account.replaceAll('_','-').toLowerCase()}
          and p.custom->'photoOwnership'->>'connectionId'=${input.source!.connectionId}
          and p.custom->'photoOwnership'->>'externalId'=${input.source!.externalId}` : sql`f.id=p.photo_file_id`}
      join file_versions v on v.file_id=f.id and v.id=f.current_version_id
      join file_attachments a on a.org_id=p.org_id and a.file_id=f.id and a.target_table='parties' and a.target_id=p.id
      left join file_blobs b on b.version_id=v.id
      where p.org_id=${input.orgId} and p.id=${input.partyId}`)).rows[0]
    if (!row || !PARTY_PHOTO_CONTENT_TYPES.has(row.content_type)) return null
    refuseMaskedStorageKind(row.storage_kind)
    const bytes = row.storage_kind === 's3' ? await getS3Blob(row.version_id) : row.bytes
    if (!bytes) return null
    return { ...row, bytes }
  })
}

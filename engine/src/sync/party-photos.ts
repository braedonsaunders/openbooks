import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, orgContext, withOrgContext } from '../platform/db.ts'
import { actorHasPermission } from '../organization/actor-permissions.ts'
import { actorAllowedSubsidiaryIds } from '../organization/actor-subsidiaries.ts'
import { readPartyPhoto, storePartyPhoto, type ConnectorPhotoSource } from '../organization/party-photos.ts'
import { prepareConnectorPhoto } from '../organization/photo-preparation.ts'
import type { MigrationSource } from './source.ts'

export interface PartyPhotoSummary {
  sourceEmployees: number
  sourceWithoutPhoto: number
  sourceWithPhoto: number
  matched: number
  attached: number
  unchanged: number
  conflicts: number
  unmatched: number
  errors: number
  prepared: number
  verified: number
  details: { sourceRef: string; sourceFileId: string | null; partyId?: string; status: string; reason?: string; photoFileId?: string | null; contentHash?: string; byteLength?: number; sourceContentHash?: string; originalFileId?: string; originalByteLength?: number }[]
}

/**
 * Synchronize photo content only after resolving the source's stable employee
 * identity in this organization. A photo never adopts a party by name, email
 * or another provider's ID. Failures retain their source cause and are counted
 * independently of missing photos and operator-owned conflicts.
 */
export async function syncSourcePartyPhotos(source: MigrationSource, options: {
  orgId: string; connectionId: string; actorId: string | null; runId: string | null
  execute: boolean; employeeRefs?: readonly string[]
  onProgress?: (current: number, total: number) => void
}): Promise<PartyPhotoSummary> {
  if (!source.partyPhotos || !source.partyPhotoContent || !source.photoSourceAccount) throw new Error('The connector does not expose native employee photos')
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(source.refKey)) throw new Error('Photo connector refKey is invalid')
  const run = async () => {
    if (options.actorId) {
      for (const permission of ['sync.run', 'parties.read', 'parties.manage']) {
        if (!await actorHasPermission(db, options.orgId, options.actorId, permission)) throw new Error(`Employee photo synchronization requires ${permission}`)
      }
      if (await actorAllowedSubsidiaryIds(db, options.orgId, options.actorId) !== null) throw new Error('Employee photo synchronization requires unrestricted subsidiary access')
    }
    const connections = (await db.execute<{ id: string; account: string }>(sql`
      select id, config->>'account' as account from connections
      where org_id=${options.orgId} and source=${source.name} and (status <> 'paused' or id=${options.connectionId})`)).rows
    const connection = connections.find(row => row.id === options.connectionId)
    if (!connection || connections.some(row => row.id !== options.connectionId)
      || connection.account?.replaceAll('_', '-').toLowerCase() !== source.photoSourceAccount!.replaceAll('_', '-').toLowerCase()) {
      throw new Error('Employee photo synchronization requires the one matching connector account in this organization')
    }
    const inventory = await source.partyPhotos!()
    const requested = new Set(options.employeeRefs ?? [])
    if (requested.size && [...requested].some(ref => !inventory.some(row => row.partyRef === ref))) throw new Error('A requested employee ID is absent from the source inventory')
    const selected = requested.size ? inventory.filter(row => requested.has(row.partyRef)) : inventory
    const summary: PartyPhotoSummary = {
      sourceEmployees: selected.length, sourceWithoutPhoto: 0, sourceWithPhoto: 0, matched: 0,
      attached: 0, unchanged: 0, conflicts: 0, unmatched: 0, errors: 0, prepared: 0, verified: 0, details: [],
    }
    let current = 0
    for (const photo of selected) {
      current++
      options.onProgress?.(current, selected.length)
      if (!photo.fileRef) {
        summary.sourceWithoutPhoto++
        summary.details.push({ sourceRef: photo.partyRef, sourceFileId: null, status: 'missing_source_photo', reason: 'The employee has no photo file set in NetSuite.' })
        continue
      }
      summary.sourceWithPhoto++
      const detail = { sourceRef: photo.partyRef, sourceFileId: photo.fileRef }
      try {
        const matches = (await db.execute<{ id: string; photo_file_id: string | null }>(sql`
          select p.id, p.photo_file_id::text from parties p
          join employee_roles e on e.org_id=p.org_id and e.party_id=p.id
          where p.org_id=${options.orgId} and (
            p.custom->>${source.refKey}=${photo.partyRef}
            or (p.custom->'source'->>'system'=${source.name} and p.custom->'source'->>'externalId'=${photo.partyRef})
          )`)).rows
        if (matches.length === 0) {
          summary.unmatched++
          summary.details.push({ ...detail, status: 'unmatched', reason: 'No employee has this stable connector identity in the organization.' })
          continue
        }
        if (matches.length !== 1) throw new Error('The source employee identity maps to multiple destination employees; resolve the mapping before importing its photo')
        const party = matches[0]!
        summary.matched++
        const sourceFile = await source.partyPhotoContent!(photo.fileRef)
        const file = await prepareConnectorPhoto(sourceFile)
        const contentType = file.contentType
        const contentHash = createHash('sha256').update(file.bytes).digest('hex')
        const sourceContentHash = createHash('sha256').update(sourceFile.bytes).digest('hex')
        if (!options.execute) {
          summary.prepared++
          summary.details.push({ ...detail, partyId: party.id, status: 'prepared', contentHash, sourceContentHash, byteLength: file.bytes.length, ...(file.original ? { originalByteLength: file.original.bytes.length } : {}) })
          continue
        }
        const origin: ConnectorPhotoSource = {
          system: source.name, connectionId: options.connectionId, account: source.photoSourceAccount!,
          refKey: source.refKey, externalId: photo.partyRef, fileId: photo.fileRef, runId: options.runId,
        }
        const outcome = await storePartyPhoto({
          orgId: options.orgId, partyId: party.id, actorId: options.actorId,
          filename: file.filename, bytes: file.bytes, contentType, original: file.original, source: origin, expectedPhotoFileId: party.photo_file_id,
        })
        if (outcome.status === 'conflict') {
          summary.conflicts++
          summary.details.push({ ...detail, partyId: party.id, status: outcome.status, photoFileId: outcome.photoFileId, reason: outcome.reason })
          continue
        }
        if (outcome.status === 'attached') summary.attached++
        else summary.unchanged++
        const readback = await readPartyPhoto({ orgId: options.orgId, partyId: party.id, actorId: options.actorId, source: origin })
        if (!readback || readback.file_id !== outcome.photoFileId || readback.bytes.length !== outcome.byteLength
          || createHash('sha256').update(readback.bytes).digest('hex') !== outcome.contentHash) {
          throw new Error('Native party photo readback does not match its synchronized content')
        }
        if (outcome.originalFileId) {
          const original = await readPartyPhoto({ orgId: options.orgId, partyId: party.id, actorId: options.actorId, source: origin, original: true })
          if (!original || original.file_id !== outcome.originalFileId || createHash('sha256').update(original.bytes).digest('hex') !== sourceContentHash) throw new Error('The retained native source photo attachment does not match the original bytes')
        }
        summary.verified++
        summary.details.push({ ...detail, partyId: party.id, status: outcome.status, photoFileId: outcome.photoFileId, contentHash: outcome.contentHash, byteLength: outcome.byteLength, sourceContentHash, originalFileId: outcome.originalFileId, ...(file.original ? { originalByteLength: file.original.bytes.length } : {}) })
      } catch (error) {
        summary.errors++
        summary.details.push({ ...detail, status: 'error', reason: error instanceof Error ? error.message : 'Employee photo synchronization failed' })
      }
    }
    return summary
  }
  const active = orgContext.getStore()
  if (active?.txDb) {
    if (!active.bypass && active.orgId !== options.orgId) throw new Error('Employee photos cannot change organization inside an active transaction')
    return run()
  }
  return withOrgContext(options.orgId, run)
}

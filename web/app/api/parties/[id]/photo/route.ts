import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/platform/database'
import { defineRoute } from '../../../../../lib/api/route'
import { isUuid } from '../../../../../lib/list-params'
import { notFound } from '@/lib/api/responses'
import { blobResponse } from '../../../../../lib/blob-response'
import { getS3Blob, isMaskedFileContentError, refuseMaskedStorageKind } from '../../../../../lib/file-storage'
import { uploadAndAttach } from '../../../../../lib/file-cabinet/attachments'
import { denyLockedOutsidePartyScope, denyOutsidePartyScope } from '../bank-accounts/party-scope'

export const runtime = 'nodejs'

/** Raster formats a browser renders inline; vector and scriptable formats are refused. */
const PHOTO_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_PHOTO_BYTES = 5 * 1024 * 1024

const FEATURE = { none: 'Party records are shared master data; a photo is part of the record every role reads.' } as const
const params = z.object({ id: z.string() })

/** A refusal to return as-is, or the photo now in effect. */
type PhotoOutcome = { response: NextResponse } | { photoFileId: string | null }

/**
 * The party's photo bytes. Served under the party read permission and the
 * party's subsidiary scope — not the File Cabinet's document grants — so
 * every reader of the record sees the same picture. A `v` query naming the
 * current photo file makes the response immutable: a new photo is a new
 * file, so its address changes with it.
 */
export const GET = defineRoute({
  permission: 'parties.read',
  feature: FEATURE,
  params,
  handler: async ({ request, authz: gate, params: { id } }) => {
    if (!isUuid(id)) return notFound('record')
    const denied = await denyOutsidePartyScope(gate, id)
    if (denied) return denied
    const row = (await db.execute<{ file_id: string; name: string; content_type: string; version_id: string; storage_kind: string; bytes: Buffer | null }>(sql`
      select f.id::text as file_id, f.name, v.content_type, v.id::text as version_id, v.storage_kind, b.bytes
        from parties p
        join files f on f.org_id = p.org_id and f.id = p.photo_file_id and not f.is_inactive
        join file_versions v on v.file_id = f.id and v.id = f.current_version_id
        left join file_blobs b on b.version_id = v.id
       where p.org_id = ${gate.user.orgId} and p.id = ${id}`)).rows[0]
    if (!row || !PHOTO_CONTENT_TYPES.has(row.content_type)) return notFound('photo')
    try {
      refuseMaskedStorageKind(row.storage_kind)
    } catch (error) {
      // A masked sandbox keeps file metadata but never production bytes.
      if (isMaskedFileContentError(error)) return notFound('photo')
      throw error
    }
    const bytes = row.storage_kind === 's3' ? await getS3Blob(row.version_id) : row.bytes
    if (!bytes) return notFound('photo')
    const requested = new URL(request.url).searchParams.get('v')
    return blobResponse(request, { filename: row.name, contentType: row.content_type, bytes, versionId: row.version_id }, {
      immutable: requested === row.file_id,
      fallbackName: 'photo',
    })
  },
})

async function recordPhotoChange(tx: SqlExecutor, orgId: string, actorId: string, partyId: string, before: string | null, after: string | null, reason: string) {
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (${orgId}, 'parties', ${partyId}, 'update',
            ${JSON.stringify({ mode: 'party_photo', reason, before: { photo_file_id: before }, after: { photo_file_id: after } })}::jsonb,
            ${actorId}, 'ui')`)
}

/**
 * Set the party's photo: the image is stored as an attachment of the party
 * (so it stays in the record's file history) and becomes the current photo.
 * The photo is independent of the record's edit revision, so changing it
 * never invalidates an edit another user has open.
 */
export const POST = defineRoute({
  permission: 'parties.manage',
  feature: FEATURE,
  params,
  handler: async ({ request, authz: gate, params: { id } }) => {
    if (!isUuid(id)) return notFound('record')
    const denied = await denyOutsidePartyScope(gate, id)
    if (denied) return denied
    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'Choose an image to upload.' }, { status: 400 })
    const contentType = file.type.split(';')[0]!.trim().toLowerCase()
    if (!PHOTO_CONTENT_TYPES.has(contentType)) {
      return NextResponse.json({ error: 'Use a PNG, JPEG, WebP or GIF image.' }, { status: 415 })
    }
    if (file.size > MAX_PHOTO_BYTES) return NextResponse.json({ error: 'Use an image of 5 MB or less.' }, { status: 413 })
    const bytes = Buffer.from(await file.arrayBuffer())
    const outcome = await db.transaction(async (tx): Promise<PhotoOutcome> => {
      const lockedDenied = await denyLockedOutsidePartyScope(tx, gate, id)
      if (lockedDenied) return { response: lockedDenied }
      const before = (await tx.execute<{ photo_file_id: string | null }>(sql`
        select photo_file_id::text as photo_file_id from parties where org_id = ${gate.user.orgId} and id = ${id} for update`)).rows[0]
      if (!before) return { response: notFound('record') }
      const stored = await uploadAndAttach({
        orgId: gate.user.orgId,
        targetTable: 'parties',
        targetId: id,
        filename: file.name || 'photo',
        contentType,
        bytes,
        createdBy: gate.user.id,
        executor: tx,
      })
      const updated = await tx.execute(sql`
        update parties set photo_file_id = ${stored.id} where org_id = ${gate.user.orgId} and id = ${id}`)
      if ((updated.rowCount ?? 0) !== 1) throw new Error('the party photo was not stored')
      await recordPhotoChange(tx, gate.user.orgId, gate.user.id, id, before.photo_file_id, stored.id, 'photo replaced')
      return { photoFileId: stored.id }
    })
    if ('response' in outcome) return outcome.response
    return NextResponse.json(outcome)
  },
})

/** Remove the photo. The image stays in the record's attachments as history. */
export const DELETE = defineRoute({
  permission: 'parties.manage',
  feature: FEATURE,
  params,
  handler: async ({ authz: gate, params: { id } }) => {
    if (!isUuid(id)) return notFound('record')
    const denied = await denyOutsidePartyScope(gate, id)
    if (denied) return denied
    const outcome = await db.transaction(async (tx): Promise<PhotoOutcome> => {
      const lockedDenied = await denyLockedOutsidePartyScope(tx, gate, id)
      if (lockedDenied) return { response: lockedDenied }
      const before = (await tx.execute<{ photo_file_id: string | null }>(sql`
        select photo_file_id::text as photo_file_id from parties where org_id = ${gate.user.orgId} and id = ${id} for update`)).rows[0]
      if (!before) return { response: notFound('record') }
      if (before.photo_file_id === null) return { photoFileId: null }
      const updated = await tx.execute(sql`
        update parties set photo_file_id = null where org_id = ${gate.user.orgId} and id = ${id}`)
      if ((updated.rowCount ?? 0) !== 1) throw new Error('the party photo was not removed')
      await recordPhotoChange(tx, gate.user.orgId, gate.user.id, id, before.photo_file_id, null, 'photo removed')
      return { photoFileId: null }
    })
    if ('response' in outcome) return outcome.response
    return NextResponse.json(outcome)
  },
})

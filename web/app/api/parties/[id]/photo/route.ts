import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '../../../../../lib/api/route'
import { isUuid } from '../../../../../lib/list-params'
import { notFound } from '@/lib/api/responses'
import { partyPhotoResponse } from '../../../../../lib/party-photo-response'
import { isMaskedFileContentError } from '../../../../../lib/file-storage'
import { MAX_PARTY_PHOTO_BYTES, PARTY_PHOTO_CONTENT_TYPES, readPartyPhoto, removePartyPhoto, storePartyPhoto } from '@openbooks/engine/src/organization/party-photos.ts'
import { ScopeNotFoundError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'

export const runtime = 'nodejs'
const FEATURE = { none: 'Party records are shared master data; a photo is part of the record every role reads.' } as const
const params = z.object({ id: z.string() })

/** Authenticated, subsidiary-scoped bytes; source and user changes use new file URLs. */
export const GET = defineRoute({
  permission: 'parties.read', feature: FEATURE, params,
  handler: async ({ request, authz, params: { id } }) => {
    if (!isUuid(id)) return notFound('record')
    try {
      const photo = await readPartyPhoto({ orgId: authz.user.orgId, actorId: authz.user.id, partyId: id })
      if (!photo) return notFound('photo')
      return partyPhotoResponse(request,photo)
    } catch (error) {
      if (error instanceof ScopeNotFoundError || isMaskedFileContentError(error)) return notFound('photo')
      throw error
    }
  },
})

/** Manual uploads establish operator ownership; connector runs preserve it. */
export const POST = defineRoute({
  permission: 'parties.manage', feature: FEATURE, params,
  handler: async ({ request, authz, params: { id } }) => {
    if (!isUuid(id)) return notFound('record')
    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'Choose an image to upload.' }, { status: 400 })
    const contentType = file.type.split(';')[0]!.trim().toLowerCase()
    if (!PARTY_PHOTO_CONTENT_TYPES.has(contentType)) return NextResponse.json({ error: 'Use a PNG, JPEG, WebP or GIF image.' }, { status: 415 })
    if (file.size > MAX_PARTY_PHOTO_BYTES) return NextResponse.json({ error: 'Use an image of 5 MB or less.' }, { status: 413 })
    try {
      const outcome = await storePartyPhoto({
        orgId: authz.user.orgId, actorId: authz.user.id, partyId: id,
        filename: file.name || 'photo', contentType, bytes: Buffer.from(await file.arrayBuffer()),
      })
      return NextResponse.json({ photoFileId: outcome.photoFileId })
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound('record')
      throw error
    }
  },
})

/** The old image stays in attachment history, and a manual removal stays removed. */
export const DELETE = defineRoute({
  permission: 'parties.manage', feature: FEATURE, params,
  handler: async ({ authz, params: { id } }) => {
    if (!isUuid(id)) return notFound('record')
    try {
      return NextResponse.json(await removePartyPhoto({ orgId: authz.user.orgId, actorId: authz.user.id, partyId: id }))
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound('record')
      throw error
    }
  },
})

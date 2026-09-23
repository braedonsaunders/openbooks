import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { applicationContextFromSession } from '@/lib/application/context'
import {
  activateExtensionDraft,
  discardExtensionDraft,
  draftExtension,
  getExtensionDraft,
  previewExtensionPage,
} from '@/lib/application/extensions'
import { ApplicationError } from '@/lib/application/errors'
import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

/**
 * An extension bundle rides this body as JSON (text files inline, binaries
 * base64). validateExtensionBundle caps the stringified bundle at 10 MB, so
 * the body cap is that cap plus envelope headroom — a legal max-size bundle
 * must pass, while the house 1 MiB default would refuse every real package.
 */
export const MAX_DRAFT_BODY_BYTES = 11 * 1024 * 1024

export async function POST(request: Request) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(request, jsonObject, { maxBodyBytes: MAX_DRAFT_BODY_BYTES })
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  const context = applicationContextFromSession(
    gate,
    'api',
    crypto.randomUUID(),
  )
  try {
    if (
      body.action === 'preview-page' &&
      typeof body.draftId === 'string' &&
      isUuid(body.draftId) &&
      typeof body.route === 'string'
    )
      return NextResponse.json(
        await previewExtensionPage(context, {
          draftId: body.draftId,
          route: body.route,
        }),
      )
    if (body.action === 'draft' && typeof body.reason === 'string') {
      if (
        body.expectedBaseVersionId !== undefined &&
        body.expectedBaseVersionId !== null &&
        (typeof body.expectedBaseVersionId !== 'string' ||
          !isUuid(body.expectedBaseVersionId))
      )
        return NextResponse.json(
          { error: 'Invalid base version' },
          { status: 400 },
        )
      let sourceDraft: { id: string; contentHash: string } | undefined
      if (body.sourceDraft !== undefined) {
        const source = body.sourceDraft as Record<string, unknown> | null
        if (
          !source ||
          typeof source.id !== 'string' ||
          !isUuid(source.id) ||
          typeof source.contentHash !== 'string'
        )
          return NextResponse.json(
            { error: 'Invalid source draft' },
            { status: 400 },
          )
        sourceDraft = { id: source.id, contentHash: source.contentHash }
      }
      return NextResponse.json(
        await draftExtension(context, {
          bundle: body.bundle,
          reason: body.reason,
          expectedBaseVersionId: body.expectedBaseVersionId,
          sourceDraft,
        }),
      )
    }
    if (
      body.action === 'discard' &&
      typeof body.draftId === 'string' &&
      isUuid(body.draftId) &&
      typeof body.contentHash === 'string'
    )
      return NextResponse.json(
        await discardExtensionDraft(context, {
          draftId: body.draftId,
          contentHash: body.contentHash,
        }),
      )
    if (
      body.action === 'activate' &&
      typeof body.draftId === 'string' &&
      isUuid(body.draftId) &&
      typeof body.contentHash === 'string'
    )
      return NextResponse.json(
        await activateExtensionDraft(context, {
          draftId: body.draftId,
          contentHash: body.contentHash,
        }),
      )
    return NextResponse.json({ error: 'Invalid draft action' }, { status: 400 })
  } catch (error) {
    if (error instanceof ApplicationError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      )
    throw error
  }
}
export async function GET(request: Request) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const id = new URL(request.url).searchParams.get('id')
  if (!id || !isUuid(id))
    return NextResponse.json({ error: 'draft id required' }, { status: 400 })
  try {
    return NextResponse.json(
      await getExtensionDraft(
        applicationContextFromSession(gate, 'api', crypto.randomUUID()),
        id,
      ),
    )
  } catch (error) {
    if (error instanceof ApplicationError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      )
    throw error
  }
}

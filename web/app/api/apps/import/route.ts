import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { applicationContextFromSession } from '@/lib/application/context'
import {
  draftExtension,
  requireExtensionAuthor,
} from '@/lib/application/extensions'
import { ApplicationError } from '@/lib/application/errors'
import {
  parseZipBundle,
  MAX_COMPRESSED_BYTES,
  ZipBundleError,
} from '@/lib/apps/zip'

export const runtime = 'nodejs'
/** Imports always create a reviewed draft; archives never write active files. */
export async function POST(request: Request) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  if (
    !['application/zip', 'application/octet-stream'].includes(
      (request.headers.get('content-type') ?? '')
        .split(';')[0]!
        .trim()
        .toLowerCase(),
    )
  )
    return NextResponse.json(
      { error: 'Upload a ZIP package.' },
      { status: 415 },
    )
  const context = applicationContextFromSession(
    gate,
    'api',
    crypto.randomUUID(),
  )
  const reader = request.body?.getReader()
  if (!reader)
    return NextResponse.json(
      { error: 'Choose an app package.' },
      { status: 400 },
    )
  try {
    await requireExtensionAuthor(context)
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_COMPRESSED_BYTES) {
        await reader.cancel()
        return NextResponse.json(
          { error: 'App packages must be 10 MB or smaller.' },
          { status: 413 },
        )
      }
      chunks.push(value)
    }
    const bundle = parseZipBundle(Buffer.concat(chunks))
    const reason =
      new URL(request.url).searchParams.get('reason') ??
      'Import app package for review'
    return NextResponse.json(await draftExtension(context, { bundle, reason }))
  } catch (error) {
    if (error instanceof ApplicationError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      )
    if (error instanceof ZipBundleError)
      return NextResponse.json({ error: error.message }, { status: 400 })
    throw error
  } finally {
    reader.releaseLock()
  }
}

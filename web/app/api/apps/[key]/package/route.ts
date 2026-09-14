import { NextResponse } from 'next/server'
import { zipSync, strToU8 } from 'fflate'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { applicationContextFromSession } from '@/lib/application/context'
import { getExtensionPackage } from '@/lib/application/extensions'
import { isUuid } from '@/lib/list-params'
import { ApplicationError } from '@/lib/application/errors'

export const runtime = 'nodejs'
export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  try {
    const { key } = await params
    const versionId =
      new URL(request.url).searchParams.get('versionId') ?? undefined
    if (versionId && !isUuid(versionId))
      return NextResponse.json({ error: 'Invalid version' }, { status: 400 })
    const result = await getExtensionPackage(
      applicationContextFromSession(gate, 'api', crypto.randomUUID()),
      { key, versionId },
    )
    if (new URL(request.url).searchParams.get('download') === '1') {
      const entries: Record<string, Uint8Array> = {
        'manifest.json': strToU8(
          JSON.stringify(result.bundle.manifest, null, 2),
        ),
      }
      for (const file of result.bundle.files)
        entries[file.path] = file.isBinary
          ? Buffer.from(file.content, 'base64')
          : strToU8(file.content)
      return new Response(Buffer.from(zipSync(entries)), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${key}.zip"`,
          'Cache-Control': 'no-store',
        },
      })
    }
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    if (error instanceof ApplicationError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      )
    throw error
  }
}

import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { listAppFiles, writeAppFile, AppError } from '@/lib/apps/store'
import { contentTypeFor } from '@/lib/apps/manifest'

export const runtime = 'nodejs'

/** GET — list the active version's files (the file browser's tree). */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key } = await params
  try {
    const files = await listAppFiles(gate.user.orgId, key)
    return NextResponse.json({ files })
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}

/**
 * POST — create a file. Two shapes:
 *   application/json      { path, content }        (New File in the browser)
 *   multipart/form-data   file=<upload>, dir=<prefix>   (Upload into a folder)
 */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key } = await params
  const contentType = req.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData().catch(() => null)
      const file = form?.get('file')
      const dir = String(form?.get('dir') ?? '').replace(/^\/+|\/+$/g, '')
      if (!(file instanceof File)) return NextResponse.json({ error: 'file field required' }, { status: 400 })
      const path = (dir ? dir + '/' : '') + file.name
      const { binary } = contentTypeFor(path)
      const buf = Buffer.from(await file.arrayBuffer())
      await writeAppFile(
        gate.user.orgId,
        gate.user.id,
        key,
        path,
        binary ? buf.toString('base64') : buf.toString('utf8'),
        binary,
      )
      return NextResponse.json({ ok: true, path })
    }
    const body = (await req.json().catch(() => ({}))) as { path?: string; content?: string }
    if (!body.path) return NextResponse.json({ error: 'path required' }, { status: 400 })
    await writeAppFile(gate.user.orgId, gate.user.id, key, body.path, body.content ?? '', false)
    return NextResponse.json({ ok: true, path: body.path })
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}

import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { installApp, listApps, AppError, type UploadBundle } from '@/lib/apps/store'
import { parseZipBundle, ZipBundleError } from '@/lib/apps/zip'

export const runtime = 'nodejs'

const MAX_ZIP_BYTES = 10 * 1024 * 1024 // 10 MB compressed

/** GET — list installed Apps for the org (admin). */
export async function GET() {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const apps = await listApps(gate.user.orgId)
  return NextResponse.json({ apps })
}

/**
 * POST — install/upgrade an App. Two upload shapes:
 *   application/json    { manifest, files[] }         (programmatic)
 *   multipart/form-data file=<bundle.zip>             (the admin UI upload)
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate

  let body: UploadBundle
  const contentType = req.headers.get('content-type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'file field required' }, { status: 400 })
    if (file.size > MAX_ZIP_BYTES) return NextResponse.json({ error: 'zip too large (max 10 MB)' }, { status: 400 })
    try {
      const parsed = parseZipBundle(new Uint8Array(await file.arrayBuffer()))
      body = { manifest: parsed.manifest, files: parsed.files }
    } catch (e) {
      if (e instanceof ZipBundleError) return NextResponse.json({ error: e.message }, { status: 400 })
      throw e
    }
  } else {
    try {
      const parsedBody = await parseJsonBody(req, jsonObject);
      if (!parsedBody.ok) return parsedBody.response;
      body = (parsedBody.data) as UploadBundle
    } catch {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
    }
    if (!body || typeof body !== 'object' || !Array.isArray(body.files)) {
      return NextResponse.json({ error: 'body must be { manifest, files[] }' }, { status: 400 })
    }
  }

  try {
    const { key } = await installApp(gate.user.orgId, gate.user.id, body)
    return NextResponse.json({ ok: true, key })
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.status })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { readAppFile, AppError } from '@/lib/apps/store'

export const runtime = 'nodejs'

function joined(path: string[]): string {
  return path.map(decodeURIComponent).join('/')
}

/** GET — one file's content (the editor pane). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string; path: string[] }> },
) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key, path } = await params
  try {
    const file = await readAppFile(gate.user.orgId, key, joined(path))
    return NextResponse.json({ file })
  } catch (e) {
    if (e instanceof AppError)
      return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}

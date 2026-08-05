import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/authz'
import { readAppFile, writeAppFile, deleteAppFile, AppError } from '@/lib/apps/store'

export const runtime = 'nodejs'

function joined(path: string[]): string {
  return path.map(decodeURIComponent).join('/')
}

/** GET — one file's content (the editor pane). */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string; path: string[] }> }) {
  const gate = await guardPermission('apps.manage')
  if (gate instanceof NextResponse) return gate
  const { key, path } = await params
  try {
    const file = await readAppFile(gate.user.orgId, key, joined(path))
    return NextResponse.json({ file })
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}

/** PUT — save edited text content. */
export async function PUT(req: Request, { params }: { params: Promise<{ key: string; path: string[] }> }) {
  const gate = await guardPermission('apps.manage')
  if (gate instanceof NextResponse) return gate
  const { key, path } = await params
  const body = (await req.json().catch(() => ({}))) as { content?: string }
  if (typeof body.content !== 'string') return NextResponse.json({ error: 'content required' }, { status: 400 })
  try {
    await writeAppFile(gate.user.orgId, gate.user.id, key, joined(path), body.content, false)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}

/** DELETE — remove a file (entry + endpoint files are protected). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ key: string; path: string[] }> }) {
  const gate = await guardPermission('apps.manage')
  if (gate instanceof NextResponse) return gate
  const { key, path } = await params
  try {
    await deleteAppFile(gate.user.orgId, key, joined(path))
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}

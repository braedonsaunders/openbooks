import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { readAppFile, writeAppFile, deleteAppFile, AppError } from '@/lib/apps/store'

export const runtime = 'nodejs'

function joined(path: string[]): string {
  return path.map(decodeURIComponent).join('/')
}

/** GET — one file's content (the editor pane). */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string; path: string[] }> }) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
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
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key, path } = await params
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { content?: string }
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
  const gate = await guardFeaturePermission('apps.manage', 'apps')
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

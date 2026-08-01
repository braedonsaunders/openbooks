import { NextResponse } from 'next/server'
import { runEndpointScript } from '@openbooks/engine/src/scripting.ts'
import { guardFeaturePermission } from '@/lib/feature-gates'

export const runtime = 'nodejs'

/**
 * Endpoint scripts — the platform's RESTlet equivalent. An active user script
 * with trigger 'endpoint' and this slug runs in the QuickJS sandbox with
 * ctx.request = { method, query, body }; its main() return is the response
 * body. Callers authenticate as themselves and need scripts.execute; the
 * script sees the calling user in ctx.user.
 */
async function handle(req: Request, slug: string) {
  const gate = await guardFeaturePermission('scripts.execute', 'scripts')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const url = new URL(req.url)
  const query: Record<string, string> = {}
  url.searchParams.forEach((v, k) => (query[k] = v))
  const body = req.method === 'POST' ? await req.json().catch(() => null) : null

  const outcome = await runEndpointScript(
    slug,
    user.orgId,
    { id: user.id, name: user.name, roles: user.roles.map(({ key }) => key) },
    { method: req.method, query, body },
  )
  if (!outcome) return NextResponse.json({ error: 'no such endpoint script' }, { status: 404 })
  if (outcome.status !== 'ok') {
    const status = outcome.status === 'timeout' ? 504 : 422
    return NextResponse.json({ error: outcome.abortReason ?? outcome.status, logs: outcome.logs }, { status })
  }
  return NextResponse.json({ ok: true, result: outcome.returned ?? null })
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return handle(req, slug)
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return handle(req, slug)
}

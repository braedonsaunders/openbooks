import { NextResponse } from 'next/server'
import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { guardPermission } from '../../../lib/authz'
import { clearPageSpec, listPageSpecs, savePageSpec } from '../../../lib/page-specs'
import { FRAME_NAMES } from '../../../components/viewspec/blocks'
import { WIDGET_NAMES } from '../../../components/viewspec/widgets'

export const runtime = 'nodejs'

/**
 * Tenant-authored page layouts.
 *
 * Gated on `admin.customization.manage` — the same permission that governs
 * form layouts and list views, because this is the same kind of authority:
 * deciding what a page looks like for everyone in the org. It is not a new
 * permission, because inventing one would leave every existing customization
 * admin unable to do a thing they can already do by other means.
 *
 * Note what this endpoint does NOT need: the ability to run anything. A spec
 * is a layout that binds fields the page's loader already resolved, so the
 * most a bad one can do is arrange data the caller could already see, or fail
 * validation and be refused.
 */

const registries = { widgets: WIDGET_NAMES, frames: FRAME_NAMES }

/** GET — every route this org has customized. */
export async function GET() {
  const gate = await guardPermission('admin.customization.manage')
  if (gate instanceof NextResponse) return gate
  return NextResponse.json({ rows: await listPageSpecs(gate.user.orgId) })
}

/** POST — store a spec for a route. Body: `{ route, spec, note? }`. */
export async function POST(req: Request) {
  const gate = await guardPermission('admin.customization.manage')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(req, jsonObject)
  if (!parsed.ok) return parsed.response
  const body = parsed.data as { route?: unknown; spec?: unknown; note?: unknown }

  const route = typeof body.route === 'string' ? body.route : null
  if (!route) return NextResponse.json({ error: 'route is required' }, { status: 400 })
  if (body.spec === undefined) return NextResponse.json({ error: 'spec is required' }, { status: 400 })

  const result = await savePageSpec({
    orgId: gate.user.orgId,
    actorId: gate.user.id,
    route,
    spec: body.spec as never,
    note: typeof body.note === 'string' ? body.note : null,
    registries,
  })
  // The errors are returned, not logged and swallowed. An author who wrote an
  // unknown widget needs to be told WHICH one; "invalid spec" is not a message
  // anyone can act on.
  if ('ok' in result && result.ok === false) {
    return NextResponse.json({ error: 'spec rejected', errors: result.errors }, { status: 400 })
  }
  return NextResponse.json(result)
}

/** DELETE ?route=… — drop the override; the page returns to its built-in spec. */
export async function DELETE(req: Request) {
  const gate = await guardPermission('admin.customization.manage')
  if (gate instanceof NextResponse) return gate
  const route = new URL(req.url).searchParams.get('route')
  if (!route) return NextResponse.json({ error: 'route is required' }, { status: 400 })
  const { cleared } = await clearPageSpec({
    orgId: gate.user.orgId,
    actorId: gate.user.id,
    route,
  })
  if (cleared === 0) return NextResponse.json({ error: 'no active spec for that route' }, { status: 404 })
  return NextResponse.json({ cleared })
}

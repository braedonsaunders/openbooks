import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { guardPermission } from '../../../lib/authz'
import { applicationContextFromSession } from '../../../lib/application/context'
import { describePageLayout } from '../../../lib/application/page-layouts'
import { clearPageSpec, listPageSpecs, savePageSpec, savePageSpecDraft } from '../../../lib/page-specs'
import { validateAgainstRegistries } from '../../../lib/page-spec-validate'
import { AUTHORING_REGISTRIES } from '../../../components/viewspec/registries'

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

const registries = AUTHORING_REGISTRIES

/**
 * A route PATTERN plus segment values as a url a browser can open.
 *
 * `/apps/[key]` is what a layout is stored under; `/apps/inventory` is what
 * you can look at. Refusing on a missing segment rather than substituting a
 * blank matters: `/apps/` would render some other page entirely, and the
 * author would be told their layout looks wrong when what they were shown was
 * never their page.
 */
function previewUrl(
  route: string,
  params: Record<string, string>,
): { ok: true; href: string } | { ok: false; error: string } {
  let missing: string | null = null
  const path = route.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    const value = params[name]
    if (typeof value !== 'string' || value === '') {
      missing ??= name
      return ''
    }
    return encodeURIComponent(value)
  })
  if (missing) return { ok: false, error: `preview needs a value for [${missing}]` }
  return { ok: true, href: `${path}?layoutPreview=1` }
}

/**
 * GET — every route this org has customized.
 *
 * With `?route=…`, describes that ONE route instead: its built-in layout, the
 * override if any, and the field paths its loader exposes. An editor needs the
 * layout it is about to change and the vocabulary of the data behind it, and
 * both come from running the page's own loader — under this session, so a
 * route the caller cannot view answers with that rather than with its layout.
 */
export async function GET(req: Request) {
  const gate = await guardPermission('admin.customization.manage')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const route = url.searchParams.get('route')
  if (!route) return NextResponse.json({ rows: await listPageSpecs(gate.user.orgId) })

  // Everything except `route` is forwarded to the loader as its query string,
  // which is how an editor previews a report page under a chosen period.
  const searchParams: Record<string, string> = {}
  for (const [key, value] of url.searchParams) {
    if (key !== 'route' && !key.startsWith('param.')) searchParams[key] = value
  }
  // `param.accountId=…` supplies a dynamic segment; the prefix keeps segments
  // and query parameters from colliding on a page that has both.
  const params: Record<string, string> = {}
  for (const [key, value] of url.searchParams) {
    if (key.startsWith('param.')) params[key.slice('param.'.length)] = value
  }

  const context = applicationContextFromSession(gate, 'assistant', randomUUID())
  const described = await describePageLayout(context, { route, params, searchParams })
  return NextResponse.json(described, { status: described.known ? 200 : 404 })
}

/**
 * POST — store a spec for a route. Body: `{ route, spec, note? }`.
 *
 * With `?validate=1` the document is checked and NOT stored. The editor needs
 * to answer "would this be accepted" without an author having to save a broken
 * layout to find out, and a dry run costs one validation instead of a write
 * plus an undo.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('admin.customization.manage')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(req, jsonObject)
  if (!parsed.ok) return parsed.response
  const body = parsed.data as { route?: unknown; spec?: unknown; note?: unknown }

  const route = typeof body.route === 'string' ? body.route : null
  if (!route) return NextResponse.json({ error: 'route is required' }, { status: 400 })
  if (body.spec === undefined) return NextResponse.json({ error: 'spec is required' }, { status: 400 })

  if (new URL(req.url).searchParams.get('preview') === '1') {
    const params = (body as { params?: unknown }).params
    const url = previewUrl(route, params && typeof params === 'object' ? (params as Record<string, string>) : {})
    if (!url.ok) return NextResponse.json({ error: url.error, errors: [url.error] }, { status: 400 })

    const saved = await savePageSpecDraft({
      orgId: gate.user.orgId,
      userId: gate.user.id,
      route,
      spec: body.spec as never,
      registries,
    })
    if (!saved.ok) return NextResponse.json({ error: 'spec rejected', errors: saved.errors }, { status: 400 })
    return NextResponse.json({ previewUrl: url.href })
  }

  if (new URL(req.url).searchParams.get('validate') === '1') {
    const checked = validateAgainstRegistries(body.spec, registries)
    if (!checked.ok) {
      return NextResponse.json({ error: 'spec rejected', errors: checked.errors }, { status: 400 })
    }
    // The route check the writer makes, made here too: a spec that declares a
    // different route would be refused at save, so a dry run that ignored it
    // would report a document as fine and then reject it.
    if (checked.spec.route && checked.spec.route !== route) {
      return NextResponse.json(
        { error: 'spec rejected', errors: [`spec declares route ${checked.spec.route}, saved under ${route}`] },
        { status: 400 },
      )
    }
    return NextResponse.json({ valid: true })
  }

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
  if (!result.ok) {
    return NextResponse.json({ error: 'spec rejected', errors: result.errors }, { status: 400 })
  }
  return NextResponse.json({ id: result.id })
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

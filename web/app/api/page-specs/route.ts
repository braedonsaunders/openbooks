import { notFound } from '@/lib/api/responses';
import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { applicationContextFromSession } from '../../../lib/application/context'
import { describePageLayout } from '../../../lib/application/page-layouts'
import {
  clearPageSpec,
  listPageSpecHistory,
  listPageSpecs,
  restorePageSpec,
  savePageSpec,
  savePageSpecDraft,
} from '../../../lib/page-specs'
import { validateAgainstRegistries } from '../../../lib/page-spec-validate'
import { AUTHORING_REGISTRIES, RENDER_REGISTRIES } from '../../../components/viewspec/registries'
const POSTBodySchema1 = z.object({
  route: z.string().min(1).optional(),
  spec: z.json().optional(),
  note: z.string().nullable().optional(),
}).refine((body) => Object.keys(body).length > 0, { message: "At least one field must be provided." });


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
export const GET = defineRoute({
  permission: 'admin.customization.manage',
  feature: { none: "This always-on route is governed by admin.customization.manage; the existing route has no separate feature gate." },
  handler: async ({ request: req, authz: routeAuthz }) => {
    const gate = routeAuthz;
    const url = new URL(req.url)
    const route = url.searchParams.get('route')
    if (!route) {
        return NextResponse.json({ rows: await listPageSpecs(gate.user.orgId, gate.user.id) })
      }
    const searchParams: Record<string, string> = {}
    for (const [key, value] of url.searchParams) {
        if (key !== 'route' && !key.startsWith('param.')) searchParams[key] = value
      }
    const params: Record<string, string> = {}
    for (const [key, value] of url.searchParams) {
        if (key.startsWith('param.')) params[key.slice('param.'.length)] = value
      }
    if (url.searchParams.get('history') === '1') {
        return NextResponse.json({ versions: await listPageSpecHistory(gate.user.orgId, route, gate.user.id) })
      }
    const context = applicationContextFromSession(gate, 'assistant', randomUUID())
    const described = await describePageLayout(context, { route, params, searchParams })
    return NextResponse.json(described, { status: described.known ? 200 : 404 })
  },
});

/**
 * POST — store a spec for a route. Body: `{ route, spec, note? }`.
 *
 * With `?validate=1` the document is checked and NOT stored. The editor needs
 * to answer "would this be accepted" without an author having to save a broken
 * layout to find out, and a dry run costs one validation instead of a write
 * plus an undo.
 */
export const POST = defineRoute({
  permission: 'admin.customization.manage',
  feature: { none: "This always-on route is governed by admin.customization.manage; the existing route has no separate feature gate." },
  body: POSTBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;

    const body = routeBody as { route?: unknown; spec?: unknown; note?: unknown }
    const route = typeof body.route === 'string' ? body.route : null
    if (!route) return NextResponse.json({ error: 'route is required' }, { status: 400 })
    const restoring = new URL(req.url).searchParams.get('restore')
    if (!restoring && body.spec === undefined) {
        return NextResponse.json({ error: 'spec is required' }, { status: 400 })
      }
    const restoreId = new URL(req.url).searchParams.get('restore')
    if (restoreId) {
        const restored = await restorePageSpec({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          route,
          versionId: restoreId,
          // RENDER rules: an undo is not an edit. A version published under older
          // rules still renders, and holding it to today's stricter checks would
          // make the layout someone wants back the one they cannot have.
          registries: RENDER_REGISTRIES,
          // `?scope=user` restores the caller's personal layer; default restores
          // the org layer. Without this a restore would publish into (and switch
          // off) a layer the caller did not mean to touch.
          scope: new URL(req.url).searchParams.get('scope') === 'user' ? 'user' : 'org',
        })
        if (!restored.ok) return NextResponse.json({ error: 'restore refused', errors: restored.errors }, { status: 400 })
        return NextResponse.json({ id: restored.id })
      }
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
    const scope = new URL(req.url).searchParams.get('scope') === 'user' ? 'user' : 'org'
    const result = await savePageSpec({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        route,
        spec: body.spec as never,
        note: typeof body.note === 'string' ? body.note : null,
        registries,
        scope,
      })
    if (!result.ok) {
        return NextResponse.json({ error: 'spec rejected', errors: result.errors }, { status: 400 })
      }
    return NextResponse.json({ id: result.id })
  },
});

/** DELETE ?route=… — drop the override; the page returns to its built-in spec. */
export const DELETE = defineRoute({
  permission: 'admin.customization.manage',
  feature: { none: "This always-on route is governed by admin.customization.manage; the existing route has no separate feature gate." },
  handler: async ({ request: req, authz: routeAuthz }) => {
    const gate = routeAuthz;
    const route = new URL(req.url).searchParams.get('route')
    if (!route) return NextResponse.json({ error: 'route is required' }, { status: 400 })
    const { cleared } = await clearPageSpec({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        route,
        scope: new URL(req.url).searchParams.get('scope') === 'user' ? 'user' : 'org',
      })
    if (cleared === 0) return notFound('record')
    return NextResponse.json({ cleared })
  },
});

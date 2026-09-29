import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { validateOrgReportQuery } from '@/lib/custom-record-report-catalog'

import { NextResponse } from 'next/server'
import { validateReportLayout } from '@openbooks/reports'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { canRunReportEntity, guardReportEntity } from '../../../../lib/report-authz'
import { deleteView, loadView, updateView, uniqueViewSlug, slugifyViewName } from '../../../../lib/views'
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.object({
  "allowedRoles": z.array(z.string().trim().min(1).max(100)).max(50).nullable().optional(),
  "description": z.string().nullable().optional(),
  "layout": z.json().optional(),
  "name": z.string({ error: "name must be a string" }).trim().min(1).max(200).optional(),
  "query": z.json().optional(),
  "scope": z.enum(["private", "shared"]).optional(),
}).refine((body) => Object.keys(body).length > 0, "At least one view setting is required");



export const runtime = 'nodejs'

/** Load one view (respecting visibility and the report entity gate). */
async function legacyGET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user, permissions } = gate
  const { id } = await params
  if (!isUuid(id)) return notFound("record")
  const view = await loadView(user.orgId, id, user.id, permissions)
  if (!view) return notFound("record")
  if (!(await canRunReportEntity(gate, view.query))) {
    return notFound("record")
  }
  return NextResponse.json({ view })
}

/** Autosave: update name/description/query/layout/scope/allowedRoles. */


/** Delete (owner or admin only). */
async function legacyDELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const { user, permissions } = gate
  const { id } = await params
  if (!isUuid(id)) return notFound("record")
  const ok = await deleteView(user.orgId, id, user.id, permissions.has('*'))
  if (!ok) return NextResponse.json({ error: 'You can only delete your own views.' }, { status: 403 })
  return NextResponse.json({ ok: true })
}

export const GET = defineRoute({
  permission: "reports.read",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  params: z.object({ "id": z.string() }),
  handler: async ({ request, params }) => legacyGET(request as never, { params: Promise.resolve(params as never) } as never),
});

export const PATCH = defineRoute({
  permission: "reports.create",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  params: z.object({ "id": z.string() }),
  body: requestBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ body, params, authz: routeAuthz }) => {

    const gate = routeAuthz

    const { user, permissions } = gate
    const { id } = params
    const isAdmin = permissions.has('*')

    if (!isUuid(id)) return notFound("record")
    const existing = await loadView(user.orgId, id, user.id, permissions)
    if (!existing) return notFound("record")
    if (!(await canRunReportEntity(gate, existing.query))) {
      return notFound("record")
    }





    let slug = existing.slug
    if (typeof body.name === 'string' && body.name.trim() && body.name.trim() !== existing.name) {
      slug = await uniqueViewSlug(user.orgId, slugifyViewName(body.name.trim()), id)
    }
    const layout =
      body.layout !== undefined
        ? (validateReportLayout(body.layout) as Record<string, unknown>)
        : existing.layout

    let query = existing.query
    if (body.query !== undefined) {
      try {
        query = await validateOrgReportQuery(gate, body.query)
      } catch (err) {
        return apiErrorResponse(err)
      }
      const denied = await guardReportEntity(gate, query)
      if (denied) return denied
    }

    const res = await updateView(user.orgId, id, user.id, isAdmin, {
      name: body.name,
      slug: slug !== existing.slug ? slug : undefined,
      description: body.description,
      query: body.query !== undefined ? query : undefined,
      layout,
      scope: body.scope,
      allowedRoles: body.allowedRoles,
    })
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 422 })

    const view = await loadView(user.orgId, id, user.id, permissions)
    if (!view || !(await canRunReportEntity(gate, view.query))) {
      return notFound("record")
    }
    return NextResponse.json({ view })
  },
});

export const DELETE = defineRoute({
  permission: "reports.create",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  params: z.object({ "id": z.string() }),
  handler: async ({ request, params }) => legacyDELETE(request as never, { params: Promise.resolve(params as never) } as never),
});

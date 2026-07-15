import { NextResponse } from 'next/server'
import { validateReportLayout } from '@openbooks/reports'
import { guardPermission } from '../../../../lib/authz'
import {
  deleteSavedSearch,
  loadSavedSearch,
  updateSavedSearch,
  uniqueSavedSearchSlug,
  slugifySavedSearchName,
  type SavedSearchScope,
} from '../../../../lib/saved-searches'

export const runtime = 'nodejs'

/** Load one saved search (respecting visibility). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user, permissions } = gate
  const { id } = await params
  const search = await loadSavedSearch(user.orgId, id, user.id, permissions)
  if (!search) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ search })
}

/** Autosave: update name/description/query/layout/scope/allowedRoles. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const { user, permissions } = gate
  const { id } = await params
  const isAdmin = permissions.has('*')

  const existing = await loadSavedSearch(user.orgId, id, user.id, permissions)
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json()) as {
    name?: string
    description?: string | null
    query?: unknown
    layout?: unknown
    scope?: SavedSearchScope
    allowedRoles?: string[] | null
  }

  let slug = existing.slug
  if (typeof body.name === 'string' && body.name.trim() && body.name.trim() !== existing.name) {
    slug = await uniqueSavedSearchSlug(user.orgId, slugifySavedSearchName(body.name.trim()), id)
  }
  const layout =
    body.layout !== undefined
      ? (validateReportLayout(body.layout) as Record<string, unknown>)
      : existing.layout

  const res = await updateSavedSearch(user.orgId, id, user.id, isAdmin, {
    name: body.name,
    slug: slug !== existing.slug ? slug : undefined,
    description: body.description,
    query: body.query as never,
    layout,
    scope: body.scope,
    allowedRoles: body.allowedRoles,
  })
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 422 })

  const search = await loadSavedSearch(user.orgId, id, user.id, permissions)
  return NextResponse.json({ search })
}

/** Delete (owner or admin only). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const { user, permissions } = gate
  const { id } = await params
  const ok = await deleteSavedSearch(user.orgId, id, user.id, permissions.has('*'))
  if (!ok) return NextResponse.json({ error: 'You can only delete your own saved searches.' }, { status: 403 })
  return NextResponse.json({ ok: true })
}

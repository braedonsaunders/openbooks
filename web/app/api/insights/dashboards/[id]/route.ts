import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { loadDashboard, normalizeAllowedRoles, normalizeLayout, strOrNull } from '../../_lib'

export const runtime = 'nodejs'

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 })
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('insights.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const dashboard = await loadDashboard(id, gate.user.orgId)
  if (!dashboard) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(dashboard)
}

interface PatchBody {
  name?: string
  description?: string | null
  layout?: unknown
  allowedRoles?: unknown
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('insights.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const existing = await loadDashboard(id, user.orgId)
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json()) as PatchBody

  const name = body.name !== undefined ? body.name.trim() : undefined
  if (name !== undefined && name === '') return bad('Dashboard name cannot be empty')

  let layout: unknown = undefined
  if (body.layout !== undefined) {
    try {
      layout = normalizeLayout(body.layout)
    } catch (e) {
      return bad(e instanceof Error ? e.message : 'invalid layout')
    }
  }

  let allowedRoles: string[] | null | undefined = undefined
  if (body.allowedRoles !== undefined) {
    try {
      allowedRoles = normalizeAllowedRoles(body.allowedRoles)
    } catch (e) {
      return bad(e instanceof Error ? e.message : 'invalid roles')
    }
  }

  await db.execute(sql`
    update insight_dashboards set
      name = ${name !== undefined ? name : sql`name`},
      description = ${body.description !== undefined ? strOrNull(body.description) : sql`description`},
      layout = ${layout !== undefined ? sql`${JSON.stringify(layout)}::jsonb` : sql`layout`},
      allowed_roles = ${allowedRoles !== undefined ? sql`${allowedRoles ? JSON.stringify(allowedRoles) : null}::jsonb` : sql`allowed_roles`},
      updated_at = now(), updated_by = ${user.id}
    where id = ${id} and org_id = ${user.orgId}
  `)

  const dashboard = await loadDashboard(id, user.orgId)
  return NextResponse.json(dashboard)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('insights.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  await db.execute(sql`delete from insight_dashboard_pins where dashboard_id = ${id} and org_id = ${user.orgId}`)
  await db.execute(sql`delete from insight_dashboards where id = ${id} and org_id = ${user.orgId}`)
  return NextResponse.json({ ok: true })
}

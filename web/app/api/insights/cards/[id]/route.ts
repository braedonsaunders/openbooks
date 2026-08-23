import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import {
  isVizType,
  loadCard,
  normalizeAllowedRoles,
  normalizeQuery,
  normalizeVizSettings,
  strOrNull,
} from '../../_lib'

export const runtime = 'nodejs'

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 })
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('insights.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const card = await loadCard(id, gate.user.orgId)
  if (!card) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(card)
}

interface PatchBody {
  name?: string
  description?: string | null
  query?: unknown
  vizType?: string
  vizSettings?: unknown
  allowedRoles?: unknown
}

/** Autosave for the card studio: name, query plan, viz type + settings, gating. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('insights.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const existing = await loadCard(id, user.orgId)
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as PatchBody

  const name = body.name !== undefined ? body.name.trim() : undefined
  if (name !== undefined && name === '') return bad('Card name cannot be empty')

  let query: unknown = undefined
  if (body.query !== undefined) {
    try {
      query = normalizeQuery(body.query)
    } catch (e) {
      return bad(e instanceof Error ? e.message : 'invalid query')
    }
  }

  if (body.vizType !== undefined && !isVizType(body.vizType)) return bad('invalid viz type')

  let vizSettings: unknown = undefined
  if (body.vizSettings !== undefined) {
    try {
      vizSettings = normalizeVizSettings(body.vizSettings)
    } catch (e) {
      return bad(e instanceof Error ? e.message : 'invalid viz settings')
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
    update insight_cards set
      name = ${name !== undefined ? name : sql`name`},
      description = ${body.description !== undefined ? strOrNull(body.description) : sql`description`},
      query = ${query !== undefined ? sql`${JSON.stringify(query)}::jsonb` : sql`query`},
      viz_type = ${body.vizType !== undefined ? body.vizType : sql`viz_type`},
      viz_settings = ${vizSettings !== undefined ? sql`${JSON.stringify(vizSettings)}::jsonb` : sql`viz_settings`},
      allowed_roles = ${allowedRoles !== undefined ? sql`${allowedRoles ? JSON.stringify(allowedRoles) : null}::jsonb` : sql`allowed_roles`},
      updated_at = now(), updated_by = ${user.id}
    where id = ${id} and org_id = ${user.orgId}
  `)

  const card = await loadCard(id, user.orgId)
  return NextResponse.json(card)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('insights.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  await db.execute(sql`delete from insight_cards where id = ${id} and org_id = ${user.orgId}`)
  // Drop this card from any dashboard layouts so no board references a ghost.
  await db.execute(sql`
    update insight_dashboards
       set layout = coalesce((
             select jsonb_agg(elem)
               from jsonb_array_elements(layout) elem
              where elem->>'cardId' <> ${id}
           ), '[]'::jsonb)
     where org_id = ${user.orgId} and layout @> ${sql`${JSON.stringify([{ cardId: id }])}::jsonb`}
  `)
  return NextResponse.json({ ok: true })
}

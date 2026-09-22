import { parseJsonBody } from '@/lib/api/json'
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { claimIdempotentCreate, resolveIdempotentReplay } from '../../../../lib/api/idempotency'
import { auditSetupChange } from '../../../../lib/setup/audit'
import {
  isVizType,
  normalizeAllowedRoles,
  normalizeQuery,
  normalizeVizSettings,
  strOrNull,
} from '../_lib'

export const runtime = 'nodejs'

const createCardBodySchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  query: z.unknown().optional(),
  vizType: z.string().optional(),
  vizSettings: z.unknown().optional(),
  allowedRoles: z.unknown().optional(),
})

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 })
}

/** The blank a fresh unsaved studio starts from (same seed the draft route used). */
const DEFAULT_QUERY = {
  source: 'ledger_lines',
  measures: [{ agg: 'sum', field: 'amount' }],
  dimensions: [{ field: 'posting_date', bin: 'month' }],
}

/**
 * Explicit create for an insight card. The New button opens an UNSAVED studio
 * (`?card=new`) and this endpoint runs only on Save: the caller supplies a
 * UUID idempotency key, which becomes the card id, so retrying the same
 * request returns the same card without a duplicate insert or duplicate
 * audit event. Cancel/close writes nothing — there is no draft row.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('insights.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const requestId = req.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 400 })
  }

  const parsedBody = await parseJsonBody(req, createCardBodySchema)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data

  if (body.name !== undefined && typeof body.name !== 'string') {
    return bad('Card name must be a string')
  }
  const name = body.name?.trim() || 'Untitled card'

  let query: ReturnType<typeof normalizeQuery>
  try {
    query = normalizeQuery(body.query ?? DEFAULT_QUERY)
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'invalid query')
  }
  const vizType = body.vizType ?? 'bar'
  if (!isVizType(vizType)) return bad('invalid viz type')
  let vizSettings: ReturnType<typeof normalizeVizSettings>
  try {
    vizSettings = normalizeVizSettings(body.vizSettings)
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'invalid viz settings')
  }
  let allowedRoles: string[] | null
  try {
    allowedRoles = normalizeAllowedRoles(body.allowedRoles)
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'invalid roles')
  }
  const description = strOrNull(body.description)

  const snapshot = {
    id: requestId,
    org_id: user.orgId,
    name,
    description,
    query,
    viz_type: vizType,
    viz_settings: vizSettings,
    allowed_roles: allowedRoles,
  }
  const match = { name, description, query, viz_type: vizType, viz_settings: vizSettings, allowed_roles: allowedRoles }

  const outcome = await db.transaction(async (tx) => {
    const claim = await claimIdempotentCreate(tx, {
      orgId: user.orgId,
      table: 'insight_cards',
      key: requestId,
    })
    if (claim === 'exists') {
      return resolveIdempotentReplay(tx, {
        orgId: user.orgId,
        table: 'insight_cards',
        key: requestId,
        match,
      })
    }
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into insight_cards
        (id, org_id, name, description, query, viz_type, viz_settings,
         status, allowed_roles, created_by, updated_by)
      values
        (${requestId}, ${user.orgId}, ${name}, ${description},
         ${JSON.stringify(query)}::jsonb, ${vizType}, ${JSON.stringify(vizSettings)}::jsonb,
         'draft', ${allowedRoles ? JSON.stringify(allowedRoles) : null}::jsonb,
         ${user.id}, ${user.id})
      on conflict (id) do nothing
      returning id
    `))
    if (!inserted.rows[0]) {
      return resolveIdempotentReplay(tx, {
        orgId: user.orgId,
        table: 'insight_cards',
        key: requestId,
        match,
      })
    }
    await auditSetupChange(
      {
        orgId: user.orgId,
        table: 'insight_cards',
        rowId: requestId,
        action: 'insert',
        changes: { before: null, after: snapshot },
        actorId: user.id,
        requestId,
      },
      tx,
    )
    return 'fresh' as const
  })
  if (outcome === 'conflict') {
    return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 409 })
  }
  return NextResponse.json({ id: requestId }, { status: outcome === 'fresh' ? 201 : 200 })
}

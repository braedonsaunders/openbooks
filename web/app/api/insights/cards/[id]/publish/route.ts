import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { mutateInsight } from '@/lib/insight-mutations'
import { validateInsightQuery } from '@openbooks/analytics'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { loadCard } from '../../../_lib'

export const runtime = 'nodejs'

/**
 * Publish (or unpublish) a card. Publishing gates on insights.publish, requires
 * a real name and a query that compiles — a published card must render for every
 * reader. `{ publish: false }` returns it to draft.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardPermission('insights.publish')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id))
    return NextResponse.json({ error: 'not found' }, { status: 404 })

  const card = await loadCard(id, user.orgId)
  if (!card) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data as {
    publish?: boolean
    expectedUpdatedAt?: unknown
  }
  const publish = body.publish !== false

  return mutateInsight(
    gate,
    'insight_cards',
    id,
    'update',
    async (tx, before, revision) => {
      if (
        typeof body.expectedUpdatedAt !== 'string' ||
        body.expectedUpdatedAt !== revision
      ) {
        return NextResponse.json(
          {
            error:
              'The record changed; reload and review the latest revision before publishing.',
          },
          { status: 409 },
        )
      }
      const card = before!
      if (publish) {
        if (
          typeof card.name !== 'string' ||
          card.name.trim() === '' ||
          card.name === 'Untitled card'
        ) {
          return NextResponse.json(
            { error: 'Give the card a real name before publishing.' },
            { status: 422 },
          )
        }
        try {
          validateInsightQuery(card.query)
        } catch (e) {
          return NextResponse.json(
            {
              error: `The query is incomplete: ${e instanceof Error ? e.message : 'invalid query'}`,
            },
            { status: 422 },
          )
        }
      }

      await tx.execute(sql`
    update insight_cards
       set status = ${publish ? 'published' : 'draft'}, updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${user.id}
     where id = ${id} and org_id = ${user.orgId}
  `)

      const updated = await tx.execute(
        sql`select *, to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at from insight_cards where id = ${id} and org_id = ${user.orgId}`,
      )
      return NextResponse.json(updated.rows[0])
    },
  )
}

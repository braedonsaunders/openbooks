import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
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
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('insights.publish')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const card = await loadCard(id, user.orgId)
  if (!card) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as { publish?: boolean }
  const publish = body.publish !== false

  if (publish) {
    if (!card.name || card.name.trim() === '' || card.name === 'Untitled card') {
      return NextResponse.json({ error: 'Give the card a real name before publishing.' }, { status: 422 })
    }
    try {
      validateInsightQuery(card.query)
    } catch (e) {
      return NextResponse.json(
        { error: `The query is incomplete: ${e instanceof Error ? e.message : 'invalid query'}` },
        { status: 422 },
      )
    }
  }

  await db.execute(sql`
    update insight_cards
       set status = ${publish ? 'published' : 'draft'}, updated_at = now(), updated_by = ${user.id}
     where id = ${id} and org_id = ${user.orgId}
  `)

  const updated = await loadCard(id, user.orgId)
  return NextResponse.json(updated)
}

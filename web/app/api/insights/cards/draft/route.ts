import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { mutateInsight } from '@/lib/insight-mutations'
import { insightCards } from '@openbooks/schema/src/insights.ts'
import { guardPermission } from '../../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Instant-into-draft: create a real draft card server-side and return its id.
 * The studio flyout edits it in place; publishing is an explicit action.
 */
export async function POST() {
  const gate = await guardPermission('insights.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const id = randomUUID()
  return mutateInsight(gate, 'insight_cards', id, 'insert', async (tx) => {
    const [card] = await tx
      .insert(insightCards)
      .values({
        id,
        orgId: user.orgId,
        name: 'Untitled card',
        query: {
          source: 'ledger_lines',
          measures: [{ agg: 'sum', field: 'amount' }],
          dimensions: [{ field: 'posting_date', bin: 'month' }],
        },
        vizType: 'bar',
        vizSettings: {},
        status: 'draft',
        createdBy: user.id,
        updatedBy: user.id,
      })
      .returning({ id: insightCards.id })

    return NextResponse.json(card)
  })
}

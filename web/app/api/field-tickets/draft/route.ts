import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { createFieldTicket, FieldTicketError, FieldTicketNotFoundError } from '../../../../lib/field-tickets'

export const runtime = 'nodejs'

/**
 * Instant-into-draft (the NewOrderButton contract): create an empty draft
 * ticket and return its id — the flyout's standard form picks the project,
 * which then derives customer/PO/period.
 */
export async function POST() {
  const gate = await guardPermission('time.manage')
  if (gate instanceof NextResponse) return gate
  if (!(await isFeatureEnabled(gate.user.orgId, 'fieldTickets'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  try {
    const created = await createFieldTicket(gate.user.orgId, gate.user.id)
    return NextResponse.json(created)
  } catch (e) {
    // A fenced in-transaction refusal stays indistinguishable from a missing
    // ticket, like the entry guard above and the main ticket route.
    const status = e instanceof FieldTicketNotFoundError ? 404 : e instanceof FieldTicketError ? 422 : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}

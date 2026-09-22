import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  returnableSources,
  type ReturnSide,
} from '@openbooks/engine/src/inventory/returnable-sources.ts'
import { guardPermission, guardSubsidiaryScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { isFeatureEnabled } from '../../../../lib/features'
import { createPermission } from '../../../../lib/document-kinds'
import { isDocKindEnabled } from '../../../../lib/documents.ts'

export const runtime = 'nodejs'

/**
 * The picker is part of authoring a credit memo, so it is gated by that
 * credit's own edit permission — derived from the kind exactly as the document
 * editor derives it, never a second hand-written mapping that could drift into
 * offering AP evidence to an AR-only reader.
 */
const SIDE_KINDS: Record<string, { side: ReturnSide; creditKind: string }> = {
  purchase: { side: 'purchase', creditKind: 'vendor_credit' },
  sales: { side: 'sales', creditKind: 'customer_credit' },
}

/**
 * Posted receipts (purchase) or shipments (sales) a credit memo may still
 * return for this party, with the quantity left on each.
 *
 * The credit-memo line picker reads this; the save path validates the chosen
 * movement against the very same reader, so the editor cannot offer a source
 * the save would refuse.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const sideParam = url.searchParams.get('side') ?? ''
  const rules = SIDE_KINDS[sideParam]
  if (!rules) {
    return NextResponse.json({ error: 'side must be purchase or sales' }, { status: 400 })
  }
  const gate = await guardPermission(createPermission(rules.creditKind))
  if (gate instanceof NextResponse) return gate

  // Returns are an inventory capability, and the credit kind itself can be
  // switched off: with either disabled there is no return to author and the
  // picker must not appear to offer one.
  if (
    !(await isFeatureEnabled(gate.user.orgId, 'inventory')) ||
    !(await isDocKindEnabled(gate.user.orgId, rules.creditKind))
  ) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const partyId = url.searchParams.get('partyId') ?? ''
  if (!isUuid(partyId)) return NextResponse.json({ error: 'partyId is required' }, { status: 400 })
  const itemId = url.searchParams.get('itemId')
  const stockLocationId = url.searchParams.get('stockLocationId')
  for (const [name, value] of [['itemId', itemId], ['stockLocationId', stockLocationId]] as const) {
    if (value !== null && !isUuid(value)) {
      return NextResponse.json({ error: `${name} must be a UUID` }, { status: 400 })
    }
  }

  const party = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from parties
     where id = ${partyId} and org_id = ${gate.user.orgId}
  `))
  if (!party.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const scopeDenied = guardSubsidiaryScope(gate, party.rows[0].subsidiaryId, { orgWideNull: true })
  if (scopeDenied) return scopeDenied

  // A restricted reader must not learn of movements in entities it cannot see.
  // One allowed entity narrows the query; several leave it party-scoped, which
  // the party's own scope check above already bounded.
  const allowed = gate.allowedSubsidiaryIds
  const sources = await returnableSources(db, gate.user.orgId, {
    side: rules.side,
    partyId,
    itemId,
    stockLocationId,
    subsidiaryId: allowed && allowed.size === 1 ? [...allowed][0]! : null,
  })
  return NextResponse.json({ sources })
}

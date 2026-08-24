import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { NextRequest, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

const ROLE_TABLES = {
  customer: schema.customerRoles,
  vendor: schema.vendorRoles,
  employee: schema.employeeRoles,
} as const

/**
 * Instant-into-draft: create an inactive placeholder party and return its id.
 * The flyout edits it in place; activation requires a real display name.
 *
 * An optional `{ role }` pre-enables one role so a party created from an
 * entity list (Customers / Vendors / Employees) is that kind by construction
 * — it shows up in the filtered list immediately and the flyout opens with
 * that role toggled on.
 */
export async function POST(req: NextRequest) {
  const gate = await guardPermission('parties.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const parsedBody = await parseJsonBody(req, jsonObject)
  if (!parsedBody.ok) return parsedBody.response
  const role = typeof parsedBody.data.role === 'string' ? parsedBody.data.role : null
  const roleTable = role && role in ROLE_TABLES ? ROLE_TABLES[role as keyof typeof ROLE_TABLES] : null

  const party = await db.transaction(async (tx) => {
    const [p] = await tx
      .insert(schema.parties)
      .values({
        orgId: user.orgId,
        kind: 'company',
        displayName: 'New party',
        isActive: false,
        createdBy: user.id,
        updatedBy: user.id,
      })
      .returning({ id: schema.parties.id })

    if (role === 'customer') {
      const terms = (await tx.execute<{ id: string }>(sql`
        select id from payment_terms
         where org_id = ${user.orgId} and is_active
         order by net_days, name limit 1
      `))
      await tx.insert(schema.customerRoles).values({
        orgId: user.orgId,
        partyId: p!.id,
        paymentTermsId: terms.rows[0]?.id ?? null,
        isActive: true,
        createdBy: user.id,
        updatedBy: user.id,
      })
    } else if (roleTable) {
      await tx.insert(roleTable).values({
        orgId: user.orgId,
        partyId: p!.id,
        isActive: true,
        createdBy: user.id,
        updatedBy: user.id,
      })
    }
    return p
  })

  return NextResponse.json(party)
}

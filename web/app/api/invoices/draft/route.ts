import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { nextDocumentNumber } from '../../../../lib/bills'

export const runtime = 'nodejs'

/** Instant-into-draft: create an empty draft invoice and return its id. */
export async function POST() {
  const gate = await guardPermission('ar.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const org = (await db.execute(
    sql`select base_currency from orgs where id = ${user.orgId}`,
  )) as unknown as { rows: { base_currency: string }[] }

  const documentNumber = await nextDocumentNumber(user.orgId, 'customer_invoice', 'INV-')
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId: user.orgId,
      kind: 'customer_invoice',
      documentNumber,
      documentDate: new Date().toISOString().slice(0, 10),
      currency: org.rows[0]?.base_currency ?? 'CAD',
      subtotal: '0',
      taxTotal: '0',
      total: '0',
      createdBy: user.id,
    })
    .returning({ id: schema.documents.id, documentNumber: schema.documents.documentNumber })

  return NextResponse.json(doc)
}

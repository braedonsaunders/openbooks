import { NextResponse } from 'next/server'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { nextDocumentNumber } from '../../../../lib/bills'

export const runtime = 'nodejs'

/** Instant-into-draft: create an empty draft expense report and return its id. */
export async function POST() {
  const gate = await guardPermission('expenses.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const documentNumber = await nextDocumentNumber(user.orgId, 'expense_report', 'EXP-')
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId: user.orgId,
      kind: 'expense_report',
      documentNumber,
      documentDate: new Date().toISOString().slice(0, 10),
      currency: 'CAD',
      subtotal: '0',
      taxTotal: '0',
      total: '0',
      createdBy: user.id,
    })
    .returning({ id: schema.documents.id, documentNumber: schema.documents.documentNumber })

  return NextResponse.json(doc)
}

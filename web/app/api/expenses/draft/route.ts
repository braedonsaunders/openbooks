import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { nextDocumentNumber } from '../../../../lib/bills'

export const runtime = 'nodejs'

/** Instant-into-draft: create an empty draft expense report and return its id. */
export async function POST() {
  const gate = await guardFeaturePermission('expenses.create', 'expenses')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const [org, today, documentNumber] = await Promise.all([
    db.execute<{ base_currency: string }>(sql`select base_currency from orgs where id = ${user.orgId}`),
    businessToday(user.orgId),
    nextDocumentNumber(user.orgId, 'expense_report', 'EXP-'),
  ])
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId: user.orgId,
      kind: 'expense_report',
      documentNumber,
      documentDate: today,
      currency: org.rows[0]?.base_currency ?? 'CAD',
      subtotal: '0',
      taxTotal: '0',
      total: '0',
      createdBy: user.id,
    })
    .returning({ id: schema.documents.id, documentNumber: schema.documents.documentNumber })

  return NextResponse.json(doc)
}

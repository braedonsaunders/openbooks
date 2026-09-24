import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { resolveDraftSubsidiary } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { nextDocumentNumber } from "../../../../lib/bills.ts";

export const runtime = 'nodejs'

/** Instant-into-draft: create an empty draft expense report and return its id. */
export async function POST() {
  const gate = await guardFeaturePermission('expenses.create', 'expenses')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  // The draft must land in a subsidiary the actor's own GET/PATCH can
  // observe: a restricted caller gets their single allowed subsidiary, or a
  // named refusal — never a NULL-subsidiary row their reads hide.
  const resolved = resolveDraftSubsidiary(gate.allowedSubsidiaryIds)
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 422 })
  const subsidiaryId = resolved.subsidiaryId

  const [org, today, documentNumber] = await Promise.all([
    db.execute<{ base_currency: string }>(sql`select base_currency from orgs where id = ${user.orgId}`),
    businessToday(user.orgId),
    nextDocumentNumber(user.orgId, 'expense_report', 'EXP-', subsidiaryId ?? undefined),
  ])
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId: user.orgId,
      kind: 'expense_report',
      subsidiaryId,
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

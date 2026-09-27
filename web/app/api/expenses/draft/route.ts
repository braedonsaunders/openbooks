import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { resolveDraftSubsidiary } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { nextDocumentNumber } from "../../../../lib/bills.ts";

export const runtime = 'nodejs'

/** Instant-into-draft: create an empty draft expense report and return its id. */
export const POST = defineRoute({
  permission: 'expenses.create',
  feature: 'expenses',
  handler: async ({ authz: routeAuthz }) => {
    const gate = routeAuthz;
    const user = gate.user
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
  },
});

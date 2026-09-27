import { notFound } from "@/lib/api/responses";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardSubsidiaryScope } from '../../../../../lib/authz'
import { defineRoute } from '../../../../../lib/api/route'
import { isUuid } from '../../../../../lib/list-params'
import { loadRelatedTransactionDrawerData } from '../../../../../components/related-transaction-drawer'

export const GET = defineRoute({
  permission: 'parties.read',
  feature: { none: 'Party transaction drawers are scoped by the transaction kind and subsidiary.' },
  params: z.object({ id: z.string() }),
  handler: async ({ request, authz, params }) => {
  const { id: partyId } = params
  const searchParams = new URL(request.url).searchParams
  const transactionId = searchParams.get('transaction')
  const kind = searchParams.get('kind')
  const formLayoutId = searchParams.get('form') ?? undefined
  if (!isUuid(partyId) || !transactionId || !isUuid(transactionId) || !kind) {
    return NextResponse.json({ error: 'invalid transaction selection' }, { status: 400 })
  }

  // The party is the record boundary (the loader separately enforces the
  // transaction's own subsidiary + org scope).
  const scope = (await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from parties where id = ${partyId} and org_id = ${authz.user.orgId}`,
  ))
  if (!scope.rows[0]) return notFound("record")
  const denied = guardSubsidiaryScope(authz, scope.rows[0].subsidiaryId, { orgWideNull: true })
  if (denied) return denied

  const data = await loadRelatedTransactionDrawerData({
    id: transactionId,
    kind,
    partyId,
    authz,
    formLayoutId,
  })
  if (!data) return notFound("record")
  return NextResponse.json(data)
  },
})

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { uuidId } from '@/lib/api/json'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { loadWithholdingReturn, fileWithholdingReturn, createWithholdingRemittance, withholdingReturnCsv, withholdingStatements } from '@openbooks/engine/contractor-withholding'
import { renderWithholdingPdf } from '@/lib/pdf-templates/contractor-withholding'
import { withholdingRecordScope, withholdingRefusal } from '@/lib/contractor-withholding'
export const runtime = 'nodejs'
const params = z.object({ id: uuidId })
export const GET = defineRoute({
  permission: 'ap.read', feature: 'contractorWithholding', params,
  handler: async ({ authz, params, request }) => {
    const denied = await withholdingRecordScope(authz, params.id, 'return')
    if (denied) return denied
    try {
      const ret = await withOrgTransaction(authz.user.orgId, () => loadWithholdingReturn(db, authz.user.orgId, params.id))
      const format = new URL(request.url).searchParams.get('format')
      if (format === 'pdf') {
        const payee = new URL(request.url).searchParams.get('payee')
        const index = payee ? ret.lines.findIndex(line => line.partyId === payee) : -1
        if (payee && index < 0) return NextResponse.json({ error: 'Statement not found.' }, { status: 404 })
        const pdf = await renderWithholdingPdf(ret, payee ? withholdingStatements(ret)[index]! : null)
        return new Response(new Uint8Array(pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="withholding-${ret.periodStart}-r${ret.revision}${payee ? '-statement' : ''}.pdf"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
      }
      if (format === 'csv') return new Response(withholdingReturnCsv(ret), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="withholding-${ret.periodStart}-r${ret.revision}.csv"`, 'Cache-Control': 'no-store' } })
      return NextResponse.json({ return: ret, statements: withholdingStatements(ret) })
    } catch (error) { return withholdingRefusal(error) }
  },
})
export const POST = defineRoute({
  permission: 'ap.pay', feature: 'contractorWithholding', params,
  body: z.discriminatedUnion('action', [z.object({ action: z.literal('file'), filingReference: z.string().trim().min(1).max(100), confirmed: z.boolean().optional() }).strict(), z.object({ action: z.literal('remit') }).strict()]), invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) => {
    const denied = await withholdingRecordScope(authz, params.id, 'return')
    if (denied) return denied
    try {
      const result = await withOrgTransaction(authz.user.orgId, async () => {
        if (body.action === 'file') {
          const source = await loadWithholdingReturn(db, authz.user.orgId, params.id)
          if (source.returnKind === 'financial_workpaper' && body.confirmed !== true) return { refusal: 'Confirm review of this financial workpaper before freezing it.' }
          await fileWithholdingReturn(db, authz.user.orgId, { returnId: params.id, filingReference: body.filingReference, confirmed: body.confirmed }, authz.user.id); return { ok: true } }
        return createWithholdingRemittance(db, authz.user.orgId, { returnId: params.id }, authz.user.id)
      })
      if ('refusal' in result) return NextResponse.json({ error: result.refusal }, { status: 422 })
      return NextResponse.json(result)
    } catch (error) { return withholdingRefusal(error) }
  },
})

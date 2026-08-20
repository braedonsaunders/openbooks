import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { maskTin, type RecipientFormData } from '@/lib/information-return-form'
import { renderInformationReturnBatchPdf, renderInformationReturnPdf } from '@/lib/information-return-pdf'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

function addressLines(address: Record<string, string | null> | null): string | null {
  if (!address) return null
  const parts = [
    address.line1,
    address.line2,
    [address.city, address.region, address.postalCode].filter(Boolean).join(' '),
    address.country,
  ].filter((line): line is string => Boolean(line && line.trim()))
  return parts.length > 0 ? parts.join('\n') : null
}

/**
 * Recipient copies (Copy B) for a filing: all of them, or one via
 * `?recipientId=`. Furnishing recipient copies is stamped so the workspace can
 * show who still has not been sent theirs.
 *
 * Only an included recipient gets a copy — an excluded one is deliberately not
 * being reported, and printing them a form would say otherwise.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('compliance.read')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardComplianceFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId, id: actorId } = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const recipientId = new URL(req.url).searchParams.get('recipientId')
  if (recipientId && !isUuid(recipientId)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const filings = (await db.execute<{
      tax_year: number
      form_type: string
      currency: string
      status: string
      payer_snapshot: { taxIds?: Record<string, string> } | null
      payer_name: string
      org_tax_ids: Record<string, string> | null
    }>(sql`
    select f.tax_year, f.form_type, f.currency, f.status, f.payer_snapshot,
           coalesce(f.payer_snapshot->>'name', s.name, o.name) as payer_name,
           o.settings->'taxIds' as org_tax_ids
      from information_return_filings f
      join orgs o on o.id = f.org_id
      left join subsidiaries s on s.id = f.subsidiary_id
     where f.org_id = ${orgId} and f.id = ${id}
  `))
  const filing = filings.rows[0]
  if (!filing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const recipients = (await db.execute<{
      id: string
      status: string
      tin_last4: string | null
      tin_type: string | null
      computed_amounts: Record<string, string>
      adjustments: Record<string, string>
      corrected_from_id: string | null
      name: string
      address: Record<string, string | null> | null
    }>(sql`
    select r.id, r.status, r.tin_last4, r.tin_type, r.computed_amounts, r.adjustments,
           r.corrected_from_id,
           coalesce(r.recipient_snapshot->>'legalName', p.display_name) as name,
           r.recipient_snapshot->'address' as address
      from information_return_recipients r
      join parties p on p.id = r.party_id
     where r.org_id = ${orgId} and r.filing_id = ${id} and r.status = 'included'
       and (${recipientId ?? null}::uuid is null or r.id = ${recipientId ?? null}::uuid)
     order by name
  `))
  if (recipients.rows.length === 0) {
    return NextResponse.json({ error: 'no included recipients to print' }, { status: 422 })
  }

  // The payer TIN comes from the frozen snapshot once finalized, so a reprint of
  // a filed return reproduces exactly what was furnished.
  const taxIds = filing.payer_snapshot?.taxIds ?? filing.org_tax_ids ?? {}
  const payerTin = taxIds.ein ?? taxIds.federal ?? taxIds.bn ?? Object.values(taxIds)[0] ?? null

  const forms: RecipientFormData[] = recipients.rows.map((r) => ({
    formType: filing.form_type,
    taxYear: filing.tax_year,
    payerName: filing.payer_name,
    payerTin,
    recipientName: r.name,
    recipientAddress: addressLines(r.address),
    recipientTinMasked: maskTin(r.tin_last4, r.tin_type),
    computedAmounts: r.computed_amounts,
    adjustments: r.adjustments,
    corrected: r.corrected_from_id !== null,
    void: false,
    currency: filing.currency,
  }))

  const pdf =
    forms.length === 1
      ? await renderInformationReturnPdf(forms[0]!)
      : await renderInformationReturnBatchPdf(forms)

  await db.execute(sql`
    update information_return_recipients
       set printed_at = now(), updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and filing_id = ${id} and status = 'included'
       and (${recipientId ?? null}::uuid is null or id = ${recipientId ?? null}::uuid)`)

  const filename =
    forms.length === 1
      ? `${filing.form_type}-${filing.tax_year}-${forms[0]!.recipientName.replace(/[^\w-]+/g, '_')}.pdf`
      : `${filing.form_type}-${filing.tax_year}-recipient-copies.pdf`
  const body = new Uint8Array(pdf)
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(body.byteLength),
      'Content-Disposition': `inline; filename="${filename}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
}

import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '@/lib/authz'
import { guardLienWaiverFeature } from '@/lib/compliance'
import { renderLienWaiverPdf } from '@/lib/lien-waiver-pdf'
import type { LienWaiverType } from '@/lib/lien-waiver-form'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

/**
 * The printable waiver. Prints as a blank to be executed while the waiver is
 * unsigned and as the executed release once it is signed — one document, one
 * source of truth, no separate "template" that can drift from the record.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('compliance.read')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardLienWaiverFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId } = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const r = (await db.execute<{
      waiver_number: string
      waiver_type: LienWaiverType
      direction: 'received' | 'issued'
      through_date: string
      amount: string
      currency: string
      jurisdiction: string | null
      notes: string | null
      signed_by_name: string | null
      signed_by_title: string | null
      signed_at: string | null
      notarized: boolean
      signature: { method?: string; attestedAt?: string } | null
      claimant_name: string
      project_name: string
      project_address: string | null
      owner_name: string | null
      bill_number: string | null
      org_name: string
    }>(sql`
    select lw.waiver_number, lw.waiver_type, lw.direction, lw.through_date, lw.amount,
           lw.currency, lw.jurisdiction, lw.notes, lw.signed_by_name, lw.signed_by_title,
           lw.signed_at, lw.notarized, lw.signature,
           claimant.display_name as claimant_name,
           coalesce(pj.code || ' · ' || pj.name, pj.name) as project_name,
           coalesce(nullif(concat_ws(', ', addr.line1, addr.city, addr.region, addr.postal_code), ''), null) as project_address,
           owner.display_name as owner_name,
           bill.document_number as bill_number,
           o.name as org_name
      from lien_waivers lw
      join parties claimant on claimant.id = lw.party_id and claimant.org_id = lw.org_id
      join projects pj on pj.id = lw.project_id and pj.org_id = lw.org_id
      join orgs o on o.id = lw.org_id
      left join parties owner on owner.id = pj.customer_id and owner.org_id = lw.org_id
      left join documents bill on bill.id = lw.bill_document_id and bill.org_id = lw.org_id
      left join lateral (
        select line1, city, region, postal_code from addresses
         where org_id = lw.org_id and party_id = pj.customer_id
         order by is_default_shipping desc, created_at limit 1
      ) addr on true
     where lw.org_id = ${orgId} and lw.id = ${id}
  `))
  const w = r.rows[0]
  if (!w) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // Who releases and who pays flips with direction: a waiver we RECEIVE is the
  // subcontractor releasing us; one we ISSUE is us releasing the owner.
  const claimantName = w.direction === 'received' ? w.claimant_name : w.org_name
  const payerName = w.direction === 'received' ? w.org_name : w.claimant_name

  const pdf = await renderLienWaiverPdf(
    {
      waiverNumber: w.waiver_number,
      waiverType: w.waiver_type,
      direction: w.direction,
      claimantName,
      payerName,
      ownerName: w.owner_name,
      projectName: w.project_name,
      projectAddress: w.project_address,
      throughDate: w.through_date,
      amount: w.amount,
      currency: w.currency,
      jurisdiction: w.jurisdiction,
      billNumber: w.bill_number,
      notes: w.notes,
      signedByName: w.signed_by_name,
      signedByTitle: w.signed_by_title,
      signedAt: w.signed_at,
      notarized: w.notarized,
      signatureEvidence: w.signature?.method
        ? `${w.signature.method} · recorded ${w.signature.attestedAt ?? ''}`.trim()
        : null,
    },
    w.org_name,
  )

  const body = new Uint8Array(pdf)
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(body.byteLength),
      'Content-Disposition': `inline; filename="${w.waiver_number}.pdf"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
}

import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { filedBoxAmounts, formDefinition } from '@openbooks/engine/src/information-returns.ts'
import { guardPermission } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Transmittal export: one row per included recipient, one column per statutory
 * box, plus the payer block. This is the file a filing agent or the IRS IRIS
 * bulk-upload consumes.
 *
 * The full TIN is deliberately NOT in this file — it stays sealed on the vendor
 * record. A transmittal needs the unmasked number, so it is entered in the
 * filing channel rather than dropped into a spreadsheet that gets emailed
 * around; the export carries the last four so rows can be reconciled.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('compliance.file')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardComplianceFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId } = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const filings = (await db.execute<{ tax_year: number; form_type: string; currency: string; status: string; payer_name: string }>(sql`
    select f.tax_year, f.form_type, f.currency, f.status,
           coalesce(f.payer_snapshot->>'name', s.name, o.name) as payer_name
      from information_return_filings f
      join orgs o on o.id = f.org_id
      left join subsidiaries s on s.id = f.subsidiary_id
     where f.org_id = ${orgId} and f.id = ${id}
  `))
  const filing = filings.rows[0]
  if (!filing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const form = formDefinition(filing.form_type)

  const recipients = (await db.execute<{
      name: string
      display_name: string
      tin_last4: string | null
      tin_type: string | null
      tax_classification: string | null
      address: Record<string, string | null> | null
      computed_amounts: Record<string, string>
      adjustments: Record<string, string>
      tax_withheld: string
      corrected: boolean
    }>(sql`
    select coalesce(r.recipient_snapshot->>'legalName', p.display_name) as name,
           p.display_name as display_name,
           r.tin_last4, r.tin_type,
           r.recipient_snapshot->>'taxClassification' as tax_classification,
           r.recipient_snapshot->'address' as address,
           r.computed_amounts, r.adjustments, r.tax_withheld,
           r.corrected_from_id is not null as corrected
      from information_return_recipients r
      join parties p on p.id = r.party_id and p.org_id = r.org_id
     where r.org_id = ${orgId} and r.filing_id = ${id} and r.status = 'included'
     order by name
  `))

  const header = [
    'payer_name',
    'tax_year',
    'form_type',
    'currency',
    'corrected',
    'recipient_legal_name',
    'recipient_display_name',
    'tin_type',
    'tin_last4',
    'tax_classification',
    'address_line1',
    'address_line2',
    'city',
    'region',
    'postal_code',
    'country',
    ...form.boxes.map((box) => `box_${box.number}`),
  ]
  const lines = [header.join(',')]
  for (const r of recipients.rows) {
    const amounts = filedBoxAmounts(r.computed_amounts, r.adjustments)
    lines.push(
      [
        filing.payer_name,
        filing.tax_year,
        filing.form_type,
        filing.currency,
        r.corrected ? 'CORRECTED' : '',
        r.name,
        r.display_name,
        r.tin_type ?? '',
        r.tin_last4 ?? '',
        r.tax_classification ?? '',
        r.address?.line1 ?? '',
        r.address?.line2 ?? '',
        r.address?.city ?? '',
        r.address?.region ?? '',
        r.address?.postalCode ?? '',
        r.address?.country ?? '',
        ...form.boxes.map((box) => amounts[box.key] ?? ''),
      ]
        .map(csvCell)
        .join(','),
    )
  }

  const filename = `${filing.form_type}-${filing.tax_year}-transmittal.csv`
  return new NextResponse(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
}

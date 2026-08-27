import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { filingArtifact } from '@openbooks/engine/src/payroll-yearend-amendments.ts'
import { orgYearEndFilings } from '@openbooks/engine/src/payroll-yearend.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { guardPayrollFilingData, guardPayrollFilingRowIds } from '../../../subsidiary-scope'

export const dynamic = 'force-dynamic'

/**
 * GET ?id= — the EXACT bytes of one issued artifact.
 *
 * This is the audit trail's whole point: whatever has since superseded it,
 * what went to the agency is retrievable unchanged. Nothing regenerates here —
 * the response is the stored transmission, byte for byte.
 *
 * Wage data, so payroll.read; scoped to the caller's org by the query itself.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const id = new URL(req.url).searchParams.get('id') ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'a submission id is required' }, { status: 422 })
  }
  const submission = (await db.execute<{
    country: string; filing: string; taxYear: number;
  }>(sql`
    select country, filing_key as filing, tax_year as "taxYear"
      from payroll_filing_submissions
     where org_id = ${gate.user.orgId} and id = ${id}
  `)).rows[0]
  if (!submission) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const rows = (await db.execute<{ rowId: string }>(sql`
    select row_id as "rowId"
      from payroll_filing_submission_slips
     where org_id = ${gate.user.orgId} and submission_id = ${id}
  `)).rows
  const denied = await guardPayrollFilingRowIds(
    gate, submission.country, submission.filing, rows.map((row) => row.rowId),
  )
  if (denied) return denied
  if (rows.length === 0) {
    const section = (await orgYearEndFilings(gate.user.orgId, submission.taxYear))
      .find((candidate) => candidate.country === submission.country && candidate.key === submission.filing)
    if (section) {
      const populationDenied = await guardPayrollFilingData(gate, submission.country, submission.filing, section.data)
      if (populationDenied) return populationDenied
    }
  }
  const file = await filingArtifact(gate.user.orgId, id)
  if (!file) {
    return NextResponse.json(
      { error: 'that filing was recorded without an electronic file — the slip snapshots on the filing history are its record' },
      { status: 404 },
    )
  }
  return new NextResponse(file.body, {
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    },
  })
}

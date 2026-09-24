import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { filingArtifact } from '@openbooks/engine/src/payroll/yearend-amendments.ts'
import { orgYearEndFilings } from '@openbooks/engine/src/payroll/yearend.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'
import { suppliedValue } from '../../../../../../lib/payroll-decimal-refusal'
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
  // `id` is a uuid column. A 36-character hex/dash string is not enough —
  // PostgreSQL still raises `invalid input syntax for type uuid` for values
  // a bare 36-char shape check accepted (36 hex digits, 36 dashes). Shape
  // refusals stay 422 and never bind the parameter.
  if (!isUuid(id)) {
    const error = id.trim() === ''
      ? 'a submission id is required'
      : `submission id must be a UUID — "${suppliedValue(id)}" is not a UUID`
    return NextResponse.json({ error }, { status: 422 })
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
    gate, submission.country, submission.filing, rows.map((row) => row.rowId), submission.taxYear,
  )
  if (denied) return denied
  if (rows.length === 0) {
    const section = (await orgYearEndFilings(gate.user.orgId, submission.taxYear))
      .find((candidate) => candidate.country === submission.country && candidate.key === submission.filing)
    if (section) {
      const populationDenied = await guardPayrollFilingData(gate, submission.country, submission.filing, section.data, submission.taxYear)
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

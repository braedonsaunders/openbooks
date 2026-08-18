import { NextResponse } from 'next/server'
import { PayrollPackError } from '@openbooks/engine/src/payroll/packs.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-error.ts'
import {
  filingLifecycle,
  recordFilingIssue,
} from '@openbooks/engine/src/payroll-yearend-amendments.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const dynamic = 'force-dynamic'

/**
 * The AMENDED / CANCELLED filing lifecycle for one pack-declared filing.
 *
 * GET  ?country=&filing=&year=  — the filing's history (every artifact issued,
 *   newest revision last) plus every row's status and field-level delta.
 * POST { country, filing, year, revision, rowIds?, note? } — record that the
 *   filing was ISSUED, or that a correction was.
 *
 * Like the file and slip routes, this route knows no country and no form: the
 * filing is resolved through the payroll filing registry and the pack decides
 * whether a correction can be produced at all, on what vehicle, and in what
 * format. A pack that refuses (the Québec RL-1, the ROE) refuses HERE, by
 * name, with a 422 in the pack's own words.
 *
 * Reading the history is wage data (payroll.read). Issuing a filing is an act
 * with a statutory consequence, so it takes payroll.run.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const year = Number(url.searchParams.get('year'))
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return NextResponse.json({ error: 'invalid year' }, { status: 422 })
  }
  try {
    const lifecycle = await filingLifecycle(
      gate.user.orgId,
      url.searchParams.get('country') ?? '',
      url.searchParams.get('filing') ?? '',
      year,
    )
    return NextResponse.json({
      ...lifecycle,
      // The reported SNAPSHOT never leaves the server: it carries keyed
      // fingerprints of confidential identifiers (a SIN, an SSN), and the
      // browser only ever needs to know THAT a field changed. The per-row
      // delta below already says that, with the values redacted.
      submissions: lifecycle.submissions.map((submission) => ({
        id: submission.id,
        revision: submission.revision,
        revisionNumber: submission.revisionNumber,
        supersedesId: submission.supersedesId,
        issuedAt: submission.issuedAt,
        note: submission.note,
        slipCount: submission.slipCount,
        artifact: submission.artifact,
        slips: submission.slips.map((slip) => ({
          rowId: slip.rowId,
          label: slip.label,
          revision: slip.revision,
        })),
      })),
    })
  } catch (e) {
    if (e instanceof PayrollPackError) return NextResponse.json({ error: e.message }, { status: 404 })
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => null)) as {
    country?: string
    filing?: string
    year?: number
    revision?: string
    rowIds?: string[]
    note?: string
  } | null
  if (!body) return NextResponse.json({ error: 'a JSON body is required' }, { status: 422 })
  const year = Number(body.year)
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return NextResponse.json({ error: 'invalid year' }, { status: 422 })
  }
  const revision = body.revision ?? ''
  if (revision !== 'original' && revision !== 'amended' && revision !== 'cancelled') {
    return NextResponse.json(
      { error: 'revision must be original, amended or cancelled' },
      { status: 422 },
    )
  }
  try {
    const result = await recordFilingIssue({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      country: body.country ?? '',
      filingKey: body.filing ?? '',
      taxYear: year,
      revision,
      rowIds: Array.isArray(body.rowIds) ? body.rowIds.map(String) : undefined,
      note: body.note?.trim() || null,
    })
    return NextResponse.json({
      submission: {
        id: result.submission.id,
        revision: result.submission.revision,
        revisionNumber: result.submission.revisionNumber,
        issuedAt: result.submission.issuedAt,
        slipCount: result.submission.slipCount,
        artifact: result.submission.artifact,
      },
      // Why no file accompanies the issue, in the pack's own words. An issue
      // with no artifact is legitimate — but never silent.
      fileRefusal: result.fileRefusal,
    })
  } catch (e) {
    if (e instanceof PayrollPackError) return NextResponse.json({ error: e.message }, { status: 404 })
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}

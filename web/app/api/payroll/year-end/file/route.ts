import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { yearEndFiling } from '@openbooks/engine/src/payroll-filing-registry.ts'
import { PayrollPackError } from '@openbooks/engine/src/payroll/packs.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { orgYearEndFilings } from '@openbooks/engine/src/payroll-yearend.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import type { Authz } from '../../../../../lib/authz'
import { guardPayrollEmployees, guardPayrollFilingData } from '../../subsidiary-scope'

export const dynamic = 'force-dynamic'

type FileInput = {
  country: string
  filing: string
  year: number
  params: Record<string, string>
}

function parseYear(value: unknown): number | null {
  const year = Number(value)
  return Number.isInteger(year) && year >= 2020 && year <= 2100 ? year : null
}

function parseBody(body: Record<string, unknown>): FileInput | NextResponse {
  const year = parseYear(body.year)
  if (year == null) return NextResponse.json({ error: 'invalid year' }, { status: 422 })
  if (typeof body.country !== 'string' || typeof body.filing !== 'string') {
    return NextResponse.json({ error: 'country and filing are required' }, { status: 422 })
  }
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'country' || key === 'filing' || key === 'year') continue
    if (typeof value !== 'string') {
      return NextResponse.json({ error: `${key} must be a string` }, { status: 422 })
    }
    params[key] = value
  }
  return { country: body.country, filing: body.filing, year, params }
}

async function serveFile(gate: Authz, input: FileInput) {
  const { country, filing: filingKey, year, params } = input
  const section = (await orgYearEndFilings(gate.user.orgId, year))
    .find((candidate) => candidate.country === country && candidate.key === filingKey)
  const selected = params.employees
  const isRoeSelection = selected != null && country === 'CA' && filingKey === 'roe'
  if (section && !isRoeSelection) {
    const denied = await guardPayrollFilingData(gate, country, filingKey, section.data)
    if (denied) return denied
  }
  // ROE's pack-owned employee selection is an additional direct boundary. It
  // can name a subset (or a row absent from the current population), so guard
  // the submitted identities before the pack builds any bytes. The registry's
  // declared limit is enforced before this query, keeping the POST bounded.
  if (isRoeSelection) {
    const issue = section?.issue
    const entries = selected.split(',').filter(Boolean)
    // `commentMaxLength` is the decoded limit. Six is the maximum number of
    // URI characters per UTF-16 code unit after encodeURIComponent; the fixed
    // allowance covers each UUID/reason delimiter. This keeps malformed or
    // hand-crafted bodies bounded before any subsidiary lookup runs.
    const maxEncodedSelectionLength = issue
      ? issue.maxSelection * (256 + issue.commentMaxLength * 6)
      : 0
    if (
      !issue
      || entries.length > issue.maxSelection
      || selected.length > maxEncodedSelectionLength
    ) {
      return NextResponse.json({ error: 'invalid employee selection' }, { status: 422 })
    }
    const ids = entries.map((entry) => entry.split(':', 1)[0]!)
    const denied = await guardPayrollEmployees(gate, ids)
    if (denied) return denied
  }
  try {
    const filing = yearEndFiling(country, filingKey)
    if (!filing.download) {
      return NextResponse.json(
        { error: filing.downloadRefusal ?? `the ${filing.label} filing declares no electronic file` },
        { status: 422 },
      )
    }
    const file = await filing.download.build(gate.user.orgId, year, params)
    return new NextResponse(file.body, {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
      },
    })
  } catch (e) {
    if (e instanceof PayrollPackError) return NextResponse.json({ error: e.message }, { status: 404 })
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}

/**
 * GET ?country=&filing=&year=&… — the electronic file of ONE pack-declared
 * year-end filing (the CA pack's T4 XML or ROE Web XML today; whatever a
 * registered pack declares tomorrow). The filing is resolved through the
 * payroll filing registry, so this route knows no country and no format:
 * each filing parses its own extra parameters and builds its own file. Issue
 * declarations are deliberately refused on GET; submit those in the POST
 * body below so an employee population never travels in a request URL.
 *
 * Fails closed (422) with every problem named — missing SINs, missing
 * transmitter configuration, a filing whose pack declares no electronic
 * file. An unknown country/filing pair is a 404 that names what IS declared.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const params = Object.fromEntries(url.searchParams)
  if (params.employees != null) {
    return NextResponse.json(
      { error: 'issue filing selections must be submitted in a POST body' },
      { status: 405 },
    )
  }
  const year = parseYear(params.year)
  if (year == null) return NextResponse.json({ error: 'invalid year' }, { status: 422 })
  return serveFile(gate, {
    country: params.country ?? '',
    filing: params.filing ?? '',
    year,
    params,
  })
}

/**
 * POST { country, filing, year, …filing parameters } — the electronic file
 * when a filing carries request-sized declarations (the ROE employee issue
 * selection). Keeping those declarations in a body avoids request-line and
 * proxy URL limits while the filing's own parser enforces its row/comment
 * limits.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(req, jsonObject)
  if (!parsedBody.ok) return parsedBody.response
  const input = parseBody(parsedBody.data)
  if (input instanceof NextResponse) return input
  return serveFile(gate, input)
}

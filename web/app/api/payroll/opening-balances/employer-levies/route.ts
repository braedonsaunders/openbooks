import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { PayrollError } from "@openbooks/engine/src/payroll/error.ts";
import {
  assertTaxYear,
  declaredEmployerLevyFields,
  EmployerLevyOpeningSaveError,
  employerLevyOpeningsForYear,
  saveEmployerLevyOpening,
  type EmployerLevyOpeningWrite,
} from '@openbooks/engine/src/payroll/opening-balances.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Employer-side mid-year adoption carry-in: the base the employer earned
 * before the adoption date in each pack-declared aggregate levy's scope.
 *
 * The per-employee carry-ins have a grid, an import resource and a refused
 * edit path; this had only the engine save with no caller, so a mid-year
 * adopter's employer levies silently restarted at zero. Same permission
 * (`payroll.manage`), same audit (the engine writes the audit row with the
 * save) and same lock semantics (a committed run's room is refused, naming
 * the run) as the employee carry-ins. Employer carry-ins are org-level facts
 * — no employee scope applies — and levy kinds come from the packs, so this
 * names no country.
 */

async function parseYear(orgId: string, raw: string | null): Promise<number> {
  if (!raw) return Number((await businessToday(orgId)).slice(0, 4))
  const year = Number(raw)
  return Number.isInteger(year) ? year : Number((await businessToday(orgId)).slice(0, 4))
}

export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  let year: number
  try {
    year = assertTaxYear(await parseYear(gate.user.orgId, new URL(req.url).searchParams.get('year')))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'invalid request' }, { status: 422 })
  }
  // Subsidiary scoping is an employee question; employer carry-ins are read
  // whole like the engine stores them.
  return NextResponse.json({
    year,
    levies: await declaredEmployerLevyFields(year),
    rows: await employerLevyOpeningsForYear(gate.user.orgId, year),
  })
}

interface SaveBody {
  taxYear?: unknown
  rows?: unknown
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate

  let body: SaveBody
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = (parsedBody.data) as SaveBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: 'rows must be an array' }, { status: 422 })
  }
  const rows: EmployerLevyOpeningWrite[] = []
  for (const raw of body.rows) {
    const row = raw as { country?: unknown; levyKey?: unknown; region?: unknown; baseYtd?: unknown }
    if (typeof row?.country !== 'string' || row.country.trim() === '') {
      return NextResponse.json({ error: 'each row needs a country pack code' }, { status: 422 })
    }
    if (typeof row?.levyKey !== 'string' || row.levyKey.trim() === '') {
      return NextResponse.json({ error: 'each row needs a levy key' }, { status: 422 })
    }
    if (row.baseYtd == null || (typeof row.baseYtd !== 'string' && typeof row.baseYtd !== 'number')) {
      return NextResponse.json({ error: 'each row needs a base year-to-date amount' }, { status: 422 })
    }
    const region = row.region == null || String(row.region).trim() === '' ? null : String(row.region).trim()
    rows.push({ country: row.country.trim(), levyKey: row.levyKey.trim(), region, baseYtd: row.baseYtd })
  }

  try {
    const result = await saveEmployerLevyOpening({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      taxYear: assertTaxYear(body.taxYear),
      rows,
    })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof EmployerLevyOpeningSaveError) {
      return NextResponse.json(
        { error: error.message, errors: error.result.errors, created: 0, updated: 0, deleted: 0 },
        { status: 409 },
      )
    }
    if (error instanceof PayrollError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    throw error
  }
}

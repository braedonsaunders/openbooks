import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { exactMoney, parseJsonBody } from "@/lib/api/json"
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
import { guardUnrestrictedScope } from '../../../../../lib/authz'

const requestBodySchema = z.strictObject({
  taxYear: z.union([
    z.number().int(),
    z.string().regex(/^\d{4}$/, 'taxYear must be a four-digit year').transform(Number),
  ]).pipe(z.number().int()),
  rows: z.array(z.strictObject({
    country: z.string().trim().min(2).max(3),
    levyKey: z.string().trim().min(1).max(120),
    region: z.string().trim().max(80).nullable().optional(),
    baseYtd: exactMoney('baseYtd must be an exact decimal string with at most four decimal places'),
  })).max(500),
})


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

export const GET = defineRoute({
  permission: 'payroll.read',
  feature: 'payroll',
  handler: async ({ request: req, authz: gate }) => {
    const scopeDenied = guardUnrestrictedScope(gate)
    if (scopeDenied) return scopeDenied
    let year: number
    try {
      year = assertTaxYear(await parseYear(gate.user.orgId, new URL(req.url).searchParams.get('year')))
    } catch (error) {
      return apiErrorResponse(error, { safeStatus: 422 })
    }
    // Employer carry-ins are organization-wide facts, so only unrestricted
    // callers reach the unscoped reader.
    return NextResponse.json({
      year,
      levies: await declaredEmployerLevyFields(year),
      rows: await employerLevyOpeningsForYear(gate.user.orgId, year),
    })

  },
})

export const POST = defineRoute({
  permission: 'payroll.manage',
  feature: 'payroll',
  handler: async ({ request: req, authz: gate }) => {
    const scopeDenied = guardUnrestrictedScope(gate)
    if (scopeDenied) return scopeDenied

    let body: z.output<typeof requestBodySchema>
    try {
      const parsedBody = await parseJsonBody(req, requestBodySchema);
      if (!parsedBody.ok) return parsedBody.response;
      body = parsedBody.data
    } catch {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
    }
    const rows: EmployerLevyOpeningWrite[] = []
    for (const row of body.rows) {
      rows.push({ country: row.country.trim(), levyKey: row.levyKey.trim(), region: row.region?.trim() || null, baseYtd: row.baseYtd })
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
        return apiErrorResponse(error, {
          safeStatus: 409,
          details: { errors: error.result.errors, created: 0, updated: 0, deleted: 0 },
        })
      }
      if (error instanceof PayrollError) {
        return apiErrorResponse(error, { safeStatus: 422 })
      }
      throw error
    }

  },
})

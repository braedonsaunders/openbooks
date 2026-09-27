import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json"
import { NextResponse } from 'next/server'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { PayrollError } from "@openbooks/engine/src/payroll/error.ts";
import {
  deleteParallelTolerance,
  parallelTolerances,
  saveParallelTolerance,
} from '@openbooks/engine/src/payroll/parallel-run-store.ts'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'
import { moneyRefusal } from '../../../../../lib/payroll-decimal-refusal'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { guardSubsidiaryScope } from '../../../../../lib/authz'

const toleranceAmount = z.string().superRefine((value, ctx) => {
  const parsed = canonicalDecimal(value, 4)
  if (parsed === null) ctx.addIssue({ code: 'custom', message: moneyRefusal('Tolerance', value) })
})
const requestBodySchema = z.strictObject({
  kind: z.enum(['earning', 'deduction', 'employer_contribution', 'credit', 'total']),
  slot: z.string().trim().min(1),
  tolerance: toleranceAmount,
  reason: z.string().trim().min(1),
})


export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const KINDS = new Set(['earning', 'deduction', 'employer_contribution', 'credit', 'total'])

type ToleranceKind = 'earning' | 'deduction' | 'employer_contribution' | 'credit' | 'total'

// Tolerances are one org-wide comparison policy, not subsidiary-owned rows.
// Keep that exception explicit at every verb so a future subsidiary-scoped
// tolerance cannot accidentally bypass the shared boundary.
function guardToleranceScope(gate: Parameters<typeof guardSubsidiaryScope>[0]): NextResponse | null {
  return guardSubsidiaryScope(gate, null, { orgWideNull: true })
}

/**
 * Per-component tolerance configuration.
 *
 * Nothing here has a default other than zero. A slot with no row compares
 * exactly, and saving a zero deletes the row rather than storing an allowance
 * that allows nothing — so the disclosure list on a comparison only ever
 * contains tolerances that actually did something.
 *
 * `reason` is required by the service, not by this route, so the API and the
 * screen cannot disagree about it.
 */
export const GET = defineRoute({
  permission: 'payroll.read',
  feature: 'payroll',
  handler: async ({ authz: gate }) => {
    const denied = guardToleranceScope(gate)
    if (denied) return denied
    return NextResponse.json({ tolerances: await parallelTolerances(gate.user.orgId) })

  },
})

export const POST = defineRoute({
  permission: 'payroll.manage',
  feature: 'payroll',
  handler: async ({ request: req, authz: gate }) => {
    const denied = guardToleranceScope(gate)
    if (denied) return denied

    const parsedBody = await parseJsonBody(req, requestBodySchema)
    if (!parsedBody.ok) return parsedBody.response
    const body = parsedBody.data

    const toleranceRaw = canonicalDecimal(body.tolerance, 4)!
    let tolerance: string
    try {
      tolerance = normalizeMoney(toleranceRaw)
    } catch {
      return NextResponse.json({ error: 'Tolerance is out of range for the ledger' }, { status: 422 })
    }

    try {
      await saveParallelTolerance({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        kind: body.kind as ToleranceKind,
        slot: body.slot.trim(),
        tolerance,
        reason: body.reason.trim(),
      })
    } catch (error) {
      if (error instanceof PayrollError) {
        return apiErrorResponse(error, { safeStatus: 422 })
      }
      throw error
    }
    return NextResponse.json({ tolerances: await parallelTolerances(gate.user.orgId) })

  },
})

export const DELETE = defineRoute({
  permission: 'payroll.manage',
  feature: 'payroll',
  handler: async ({ request: req, authz: gate }) => {
    const denied = guardToleranceScope(gate)
    if (denied) return denied
    const params = new URL(req.url).searchParams
    const kind = params.get('kind')
    const slot = params.get('slot')
    if (!kind || !KINDS.has(kind) || !slot) {
      return NextResponse.json({ error: 'kind and slot are required' }, { status: 422 })
    }
    await deleteParallelTolerance(gate.user.orgId, kind as ToleranceKind, slot, gate.user.id)
    return NextResponse.json({ tolerances: await parallelTolerances(gate.user.orgId) })

  },
})

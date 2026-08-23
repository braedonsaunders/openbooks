import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import {
  deleteParallelTolerance,
  parallelTolerances,
  saveParallelTolerance,
} from '@openbooks/engine/src/payroll-parallel-run-store.ts'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const KINDS = new Set(['earning', 'deduction', 'employer_contribution', 'total'])

type ToleranceKind = 'earning' | 'deduction' | 'employer_contribution' | 'total'

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
export async function GET() {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  return NextResponse.json({ tolerances: await parallelTolerances(gate.user.orgId) })
}

interface ToleranceBody {
  kind?: unknown
  slot?: unknown
  tolerance?: unknown
  reason?: unknown
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate

  let body: ToleranceBody
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = (parsedBody.data) as ToleranceBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (typeof body.kind !== 'string' || !KINDS.has(body.kind)) {
    return NextResponse.json({ error: 'kind must be a component kind or "total"' }, { status: 422 })
  }
  if (typeof body.slot !== 'string' || !body.slot.trim()) {
    return NextResponse.json({ error: 'slot is required' }, { status: 422 })
  }

  const toleranceRaw = canonicalDecimal(body.tolerance ?? '0', 4)
  if (toleranceRaw === null) {
    return NextResponse.json({ error: 'Tolerance must be an exact decimal' }, { status: 422 })
  }
  let tolerance: string
  try {
    tolerance = normalizeMoney(toleranceRaw)
  } catch {
    return NextResponse.json({ error: 'Tolerance must be an exact decimal' }, { status: 422 })
  }

  try {
    await saveParallelTolerance({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      kind: body.kind as ToleranceKind,
      slot: body.slot.trim(),
      tolerance,
      reason: String(body.reason ?? ''),
    })
  } catch (error) {
    if (error instanceof PayrollError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    throw error
  }
  return NextResponse.json({ tolerances: await parallelTolerances(gate.user.orgId) })
}

export async function DELETE(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const params = new URL(req.url).searchParams
  const kind = params.get('kind')
  const slot = params.get('slot')
  if (!kind || !KINDS.has(kind) || !slot) {
    return NextResponse.json({ error: 'kind and slot are required' }, { status: 422 })
  }
  await deleteParallelTolerance(gate.user.orgId, kind as ToleranceKind, slot, gate.user.id)
  return NextResponse.json({ tolerances: await parallelTolerances(gate.user.orgId) })
}

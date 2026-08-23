import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import {
  comparablePayRuns,
  comparableSlots,
  parallelComparisons,
  parallelTolerances,
  priorRegisters,
  runParallelComparison,
  suggestedPayRunForRegister,
} from '@openbooks/engine/src/payroll-parallel-run-store.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Parallel run: prior-provider reconciliation.
 *
 * Reading is `payroll.read`; running a comparison is `payroll.manage`, because
 * a filed comparison is audit evidence with an actor on it, not a query.
 *
 * Every rule — the classification, the zero-tolerance default, the refusal to
 * report a clean result off an empty or non-intersecting population, and the
 * self-check that must pass before anything is stored — lives in
 * engine/src/payroll-parallel-run.ts and its store. This route only translates
 * HTTP, so a second caller cannot reach a different verdict.
 */

export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const params = new URL(req.url).searchParams
  const registerId = params.get('registerId')

  const [registers, runs, comparisons, tolerances, slots] = await Promise.all([
    priorRegisters(orgId),
    comparablePayRuns(orgId),
    parallelComparisons(orgId, {
      registerId: registerId && isUuid(registerId) ? registerId : undefined,
    }),
    parallelTolerances(orgId),
    comparableSlots(orgId),
  ])

  const suggestedRun =
    registerId && isUuid(registerId) ? await suggestedPayRunForRegister(orgId, registerId) : null

  return NextResponse.json({
    registers,
    runs,
    comparisons,
    tolerances,
    slots: slots.map((slot) => ({
      fieldKey: slot.fieldKey, kind: slot.kind, slot: slot.slot, label: slot.label,
    })),
    suggestedRun,
  })
}

interface RunBody {
  registerId?: unknown
  payRunDocumentId?: unknown
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate

  let body: RunBody
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = (parsedBody.data) as RunBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (typeof body.registerId !== 'string' || !isUuid(body.registerId)) {
    return NextResponse.json({ error: 'registerId must be a prior register' }, { status: 422 })
  }
  if (typeof body.payRunDocumentId !== 'string' || !isUuid(body.payRunDocumentId)) {
    return NextResponse.json({ error: 'payRunDocumentId must be a pay run' }, { status: 422 })
  }

  try {
    const { comparisonId, comparison } = await runParallelComparison({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      registerId: body.registerId,
      payRunDocumentId: body.payRunDocumentId,
    })
    // The result is returned in full, including `blockedReason` and the
    // tolerances in force. A caller that only reads `status` still cannot
    // mistake "nothing to compare" for "no differences" — they are different
    // values of the same field.
    return NextResponse.json({ comparisonId, comparison })
  } catch (error) {
    if (error instanceof PayrollError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    throw error
  }
}

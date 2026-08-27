import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
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
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type ScopeRow = { id: string }

/** A prior register's legal-entity boundary is each employee stub. */
async function visibleRegisterIds(orgId: string, allowed: ReadonlySet<string> | null): Promise<Set<string> | null> {
  if (allowed === null) return null
  const ids = [...allowed]
  if (ids.length === 0) return new Set()
  const outside = ids.length
    ? sql`and (p.id is null or p.subsidiary_id is null or not (p.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])))`
    : sql`and true`
  const rows = await db.execute<ScopeRow>(sql`
    select r.id
      from payroll_prior_registers r
     where r.org_id = ${orgId}
       and not exists (
         select 1
           from payroll_prior_stubs s
           left join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
          where s.org_id = r.org_id and s.register_id = r.id ${outside})`)
  return new Set(rows.rows.map((row) => row.id))
}

async function visibleRunIds(orgId: string, allowed: ReadonlySet<string> | null): Promise<Set<string> | null> {
  if (allowed === null) return null
  const rows = await db.execute<ScopeRow>(sql`
    select r.document_id as id
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId}${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed)}`)
  return new Set(rows.rows.map((row) => row.id))
}

async function scopeComparisonIds(
  orgId: string,
  allowed: ReadonlySet<string> | null,
  registerIds: Set<string> | null,
  runIds: Set<string> | null,
): Promise<Set<string> | null> {
  if (allowed === null) return null
  const registers = registerIds ? [...registerIds] : []
  const runs = runIds ? [...runIds] : []
  if (registers.length === 0 || runs.length === 0) return new Set()
  const rows = await db.execute<ScopeRow>(sql`
    select c.id
      from payroll_parallel_comparisons c
     where c.org_id = ${orgId}
       and c.register_id = any(${`{${registers.join(',')}}`}::uuid[])
       and c.pay_run_document_id = any(${`{${runs.join(',')}}`}::uuid[])
       and not exists (
         select 1
           from payroll_parallel_findings f
           left join parties p on p.id = f.employee_party_id and p.org_id = f.org_id
          where f.org_id = c.org_id and f.comparison_id = c.id
            and (p.id is null or p.subsidiary_id is null
              or not (p.subsidiary_id = any(${`{${[...allowed].join(',')}}`}::uuid[]))))`)
  return new Set(rows.rows.map((row) => row.id))
}

async function assertComparisonInputsInScope(
  orgId: string,
  allowed: ReadonlySet<string> | null,
  registerId: string,
  payRunDocumentId: string,
): Promise<NextResponse | null> {
  if (allowed === null) return null
  const registers = await visibleRegisterIds(orgId, allowed)
  if (!registers?.has(registerId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const runs = await visibleRunIds(orgId, allowed)
  if (!runs?.has(payRunDocumentId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return null
}

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

  const [registerIds, runIds] = await Promise.all([
    visibleRegisterIds(orgId, gate.allowedSubsidiaryIds),
    visibleRunIds(orgId, gate.allowedSubsidiaryIds),
  ])
  const comparisonIds = await scopeComparisonIds(
    orgId, gate.allowedSubsidiaryIds, registerIds, runIds,
  )

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
  const visibleSuggested = suggestedRun
    && (runIds === null || runIds.has(suggestedRun))
    && (registerIds === null || registerIds.has(registerId ?? ''))
    ? suggestedRun
    : null

  return NextResponse.json({
    registers: registerIds === null ? registers : registers.filter((row) => registerIds.has(row.id)),
    runs: runIds === null ? runs : runs.filter((row) => runIds.has(row.documentId)),
    comparisons: comparisonIds === null ? comparisons : comparisons.filter((row) => comparisonIds.has(row.id)),
    tolerances,
    slots: slots.map((slot) => ({
      fieldKey: slot.fieldKey, kind: slot.kind, slot: slot.slot, label: slot.label,
    })),
    suggestedRun: visibleSuggested,
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

  const denied = await assertComparisonInputsInScope(
    gate.user.orgId,
    gate.allowedSubsidiaryIds,
    body.registerId,
    body.payRunDocumentId,
  )
  if (denied) return denied

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

import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { PayrollError } from '@openbooks/engine/src/payroll-error.ts'
import {
  createRetroPayRun,
  proposeRetroPay,
} from '@openbooks/engine/src/payroll-retro-store.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Retroactive pay: detect → quantify → review → pay.
 *
 * `POST` with `{ action: 'propose' }` writes NOTHING. It re-runs each affected
 * committed period through the pay run's own calculation
 * (engine/src/payroll-retro-store.ts) and differences the earnings, so it is
 * expensive and unsafe to cache — which is exactly why it is a POST and not a
 * GET. It requires `payroll.run` rather than `payroll.read` for the same
 * reason: it is real payroll computation, not a query.
 *
 * `POST` with `{ action: 'create' }` builds the retro pay run and files the
 * settlements that are its evidence — `payroll.run`.
 *
 * Every rule (what counts as a trigger, what a difference is, what is payable,
 * how "exactly once" is enforced) lives in the engine. This route only
 * translates HTTP, so no second caller can reach a different answer.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

interface Body {
  action?: unknown
  payScheduleId?: unknown
  payDate?: unknown
  employeePartyIds?: unknown
  excludeSourcePayRunDocumentIds?: unknown
}

function uuidList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = value.filter((entry): entry is string => typeof entry === 'string' && isUuid(entry))
  return ids.length > 0 ? ids : undefined
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate

  let body: Body
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = (parsedBody.data) as Body
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (typeof body.payScheduleId !== 'string' || !isUuid(body.payScheduleId)) {
    return NextResponse.json({ error: 'payScheduleId must be a pay schedule' }, { status: 422 })
  }
  if (typeof body.payDate !== 'string' || !ISO_DATE.test(body.payDate)) {
    return NextResponse.json({ error: 'payDate must be a date' }, { status: 422 })
  }

  const input = {
    orgId: gate.user.orgId,
    actorId: gate.user.id,
    payScheduleId: body.payScheduleId,
    payDate: body.payDate,
    employeePartyIds: uuidList(body.employeePartyIds),
  }

  try {
    if (body.action === 'create') {
      const result = await createRetroPayRun({
        ...input,
        excludeSourcePayRunDocumentIds: uuidList(body.excludeSourcePayRunDocumentIds),
      })
      return NextResponse.json(result)
    }
    return NextResponse.json(await proposeRetroPay(input))
  } catch (error) {
    // A refusal is the product working: nothing to pay, a decrease that is an
    // overpayment recovery, a period in another statutory year. It reaches the
    // operator as its own sentence, never as a 500.
    if (error instanceof PayrollError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    throw error
  }
}

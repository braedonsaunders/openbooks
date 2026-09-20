import { NextResponse } from 'next/server'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import {
  EmploymentReadError,
  getEmploymentRecord,
} from '@openbooks/engine/src/hrm/employment-read.ts'
import { HrmAuthorizationError } from '@openbooks/engine/src/hrm/authorization.ts'
import { TemporalError } from '@openbooks/engine/src/hrm/temporal.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * One employment's HRM record: episodes, the as-of resolution at the
 * requested effective date, and the change-request list — all from the
 * canonical read service. The as-of leg may refuse (ambiguity, missing
 * version) while the employment is authorized: that refusal travels as
 * DATA inside the envelope (asOfRefusal) so the Employment tab renders it
 * as a refusal beside the episodes and requests. Whole-call denials
 * (authorization, gate, malformed input) are HTTP errors with `{ error }`
 * bodies — the client checks res.ok before parsing.
 *
 * Managers arrive through the structural team fallback: employment.read
 * first, then self.read for a direct report as of today. The service
 * resolves the team and refuses strangers with the employment remedy
 * intact — a widened gate with an unchanged refusal.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const employmentGate = await guardFeaturePermission('hrm.employment.read', 'hrm')
  const gate = employmentGate instanceof NextResponse
    ? await guardFeaturePermission('hrm.self.read', 'hrm')
    : employmentGate
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'invalid employment' }, { status: 422 })

  const { searchParams } = new URL(req.url)
  const rawDate = searchParams.get('effectiveDate')
  const effectiveDate = rawDate ?? (await businessToday(gate.user.orgId))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    return NextResponse.json({ error: 'effectiveDate must be YYYY-MM-DD' }, { status: 422 })
  }

  try {
    const record = await getEmploymentRecord({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId: id,
      effectiveDate,
      knownAt: new Date().toISOString(),
    })
    return NextResponse.json({ record })
  } catch (error) {
    // Authorization denial is uniform and safe to surface: it names the
    // permission and the remedy, never the record.
    if (error instanceof HrmAuthorizationError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    // Computed domain refusals (gate off, malformed as-of, missing or
    // ambiguous revision) reach the caller with their code and remedy.
    if (error instanceof EmploymentReadError || error instanceof TemporalError) {
      return NextResponse.json({ error: error.message, code: error.name }, { status: 422 })
    }
    throw error
  }
}

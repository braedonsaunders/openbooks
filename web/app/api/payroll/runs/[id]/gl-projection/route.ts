import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'
import { uuidString } from '@openbooks/engine/platform/identifiers'
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/db'
import { readPayRunGlProjection, rebuildPayRunGlProjection } from '@openbooks/engine/payroll/run-gl-rebuild'
import { PayrollError } from "@openbooks/engine/payroll/error";
import { guardSubsidiaryScope } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";

const bodySchema = z.strictObject({
  reason: z.string().trim().min(1).max(2000),
  expectedRevision: z.string().trim().min(1).max(40),
  entitlementRelief: z.strictObject({
    expectedProjectionHash: z.string().regex(/^[0-9a-f]{64}$/),
    bindings: z.array(z.strictObject({
      planId: uuidString(),
      liabilityAccountId: uuidString(),
    })).min(1).max(50),
  }).optional(),
})

async function ownedRun(orgId: string, id: string) {
  return (await db.execute<{ subsidiaryId: string | null }>(sql`
    select d.subsidiary_id as "subsidiaryId"
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${id}`, 'objects'))[0]
}

async function payrollRefusal(error: unknown) {
  if (!(error instanceof PayrollError)) throw error
  const refusal = await apiErrorResponse(error, { safeStatus: 409 })
  refusal.headers.set('Cache-Control', 'no-store')
  return refusal
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The revision and projection hash of a pay run's GL projection, which a
 * governed entitlement-coding correction quotes back.
 */
export const GET = defineRoute({
  permission: 'payroll.read',
  feature: 'payroll',
  params: z.object({ "id": z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = params
    if (!isUuid(id)) return notFound("record")
    const owned = await ownedRun(gate.user.orgId, id)
    if (!owned) return notFound("record")
    const denied = guardSubsidiaryScope(gate, owned.subsidiaryId)
    if (denied) return denied
    try {
      const result = await readPayRunGlProjection({
        orgId: gate.user.orgId,
        documentId: id,
        actorId: gate.user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      })
      return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      return payrollRefusal(error)
    }
  },
})

/**
 * Rebuild the GL projection of a committed, never-posted pay run from its own
 * committed records. Amounts and accounts cannot change; the rebuilt lines
 * carry the current line identity. With `entitlementRelief`, lines proven to
 * settle a bound entitlement bank also move from expense to the plan's
 * liability. Refused once the run is released, posted, paid or referenced.
 */
export const POST = defineRoute({
  permission: 'payroll.manage',
  feature: 'payroll',
  params: z.object({ "id": z.string() }),
  body: bodySchema,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params, body }) => {
    const { id } = params
    if (!isUuid(id)) return notFound("record")
    const owned = await ownedRun(gate.user.orgId, id)
    if (!owned) return notFound("record")
    const denied = guardSubsidiaryScope(gate, owned.subsidiaryId)
    if (denied) return denied
    try {
      const result = await rebuildPayRunGlProjection({
        orgId: gate.user.orgId,
        documentId: id,
        actorId: gate.user.id,
        reason: body.reason,
        expectedRevision: body.expectedRevision,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        entitlementRelief: body.entitlementRelief,
      })
      return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      return payrollRefusal(error)
    }
  },
})

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { parseJsonBody } from '@/lib/api/json'
import { isUuid } from '@/lib/list-params'
import { createSetupRecord, deleteSetupRecord, preflightSetupWrite, updateSetupRecord, type SetupWriteResult } from '@/lib/setup/write'

export const runtime = 'nodejs'

// Rehomed Benefits forms share the native registry's validation, scope,
// idempotency and audit commands. HR management authorizes only these Benefits
// entities; it does not grant access to the general configuration API.
const params = z.object({ entity: z.enum(['benefit-plans', 'benefit-contribution-rules', 'benefit-contribution-classes', 'benefit-contribution-tiers', 'benefit-recovery-sources', 'benefit-enrollment-configuration', 'benefit-enrollment-terms', 'entitlement-plans', 'entitlement-plan-limits', 'entitlement-service-tiers', 'payroll-vacation-terms', 'payroll-service-credits']) })
const requestBody = z.record(z.string(), z.json())
const response = (result: SetupWriteResult) => NextResponse.json(result.body, { status: result.status })

export const POST = defineRoute({
  permission: 'hrm.benefits.manage',
  feature: 'hrm',
  params,
  handler: async ({ request, params, authz }) => {
    const requestId = request.headers.get('Idempotency-Key')?.trim() ?? ''
    if (!isUuid(requestId)) {
      return NextResponse.json({ error: 'Idempotency-Key must be a UUID', code: 'invalid' }, { status: 400 })
    }
    const actor = { ...authz.user, permissions: authz.permissions, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }
    const refused = await preflightSetupWrite(actor, params.entity, 'create')
    if (refused) return response(refused)
    const parsed = await parseJsonBody(request, requestBody)
    if (!parsed.ok) return parsed.response
    return response(await createSetupRecord(actor, params.entity, parsed.data, { requestId }))
  },
})

export const PATCH = defineRoute({
  permission: 'hrm.benefits.manage',
  feature: 'hrm',
  params,
  handler: async ({ request, params, authz }) => {
    const actor = { ...authz.user, permissions: authz.permissions, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }
    const refused = await preflightSetupWrite(actor, params.entity, 'update')
    if (refused) return response(refused)
    const parsed = await parseJsonBody(request, requestBody)
    if (!parsed.ok) return parsed.response
    return response(await updateSetupRecord(actor, params.entity, parsed.data))
  },
})

export const DELETE = defineRoute({
  permission: 'hrm.benefits.manage',
  feature: 'hrm',
  params,
  handler: async ({ request, params, authz }) => {
    const actor = { ...authz.user, permissions: authz.permissions, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }
    const refused = await preflightSetupWrite(actor, params.entity, 'delete')
    if (refused) return response(refused)
    return response(await deleteSetupRecord(actor, params.entity, new URL(request.url).searchParams.get('id') ?? ''))
  },
})

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { created, notFound, unprocessable } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { guardSubsidiaryScope } from '@/lib/authz'
import { createReturnAuthorization, loadReturnAuthorizations } from '@/lib/returns'
import { uuidId } from '@/lib/api/json'

const lineSchema = z.object({
  accountId: uuidId,
  itemId: uuidId.nullable().optional(),
  description: z.string().nullable().optional(),
  quantity: z.string().max(40).nullable().optional(),
  unit: z.string().nullable().optional(),
  unitPrice: z.string().max(40).nullable().optional(),
  amount: z.string().max(40),
  taxCodeId: uuidId.nullable().optional(),
  taxGroupId: uuidId.nullable().optional(),
  taxOverridden: z.boolean().optional(),
  taxAmount: z.string().max(40).nullable().optional(),
  stockLocationId: uuidId.nullable().optional(),
  departmentId: uuidId.nullable().optional(),
  projectId: uuidId.nullable().optional(),
  locationId: uuidId.nullable().optional(),
  classId: uuidId.nullable().optional(),
  extraDims: z.record(z.string(), z.string().nullable()).optional(),
  custom: z.record(z.string(), z.json()).optional(),
}).passthrough()

const createBody = z.object({
  document: z.object({
    partyId: uuidId,
    subsidiaryId: uuidId,
    documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    referenceNumber: z.string().nullable().optional(),
    memo: z.string().nullable().optional(),
    currency: z.string().length(3).optional(),
    custom: z.record(z.string(), z.json()).optional(),
    lines: z.array(lineSchema).min(1).max(500),
  }).passthrough(),
  sourceSelections: z.array(z.object({
    lineNumber: z.number().int().min(1).max(500),
    sourceIssueMovementId: uuidId,
    lotId: uuidId.nullable().optional(),
    serialId: uuidId.nullable().optional(),
  })).min(1).max(500),
})

export const GET = defineRoute({
  permission: 'orders.fulfill',
  feature: 'returnAuthorizations',
  handler: async ({ authz }) => {
    const authorizations = await loadReturnAuthorizations(authz.user.orgId, authz.allowedSubsidiaryIds)
    return NextResponse.json({ authorizations })
  },
})

export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'returnAuthorizations',
  body: createBody,
  handler: async ({ request, authz, body }) => {
    const key = request.headers.get('Idempotency-Key')?.trim() ?? ''
    if (!z.string().uuid().safeParse(key).success) {
      return unprocessable('invalid_idempotency_key', { status: 400 })
    }
    if (guardSubsidiaryScope(authz, body.document.subsidiaryId)) return notFound('subsidiary')
    const authorization = await createReturnAuthorization({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      key,
      body: body.document,
      sourceSelections: body.sourceSelections,
      requestBody: body,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    })
    return created({ doc: { id: authorization.id }, authorization })
  },
})

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { proposeDropShipAssessment } from '@openbooks/engine/inventory'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { isoDate,uuidId } from '@/lib/api/json'
export const runtime='nodejs'
export const POST=defineRoute({permission:'ar.post',feature:'dropShipping',body:z.object({salesOrderLineId:uuidId,controlsBeforeTransfer:z.boolean(),passThroughAccountId:uuidId.nullable(),controlEvidence:z.string().trim().min(40).max(10000),effectiveOn:isoDate(),reason:z.string().trim().min(8).max(1000),idempotencyKey:z.string().min(1).max(120)}).strict(),
  handler:async({authz,body})=>{try{return NextResponse.json({id:await proposeDropShipAssessment(authz.user.orgId,authz.user.id,body)},{status:201})}catch(error){return apiErrorResponse(error)}}})

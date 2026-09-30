import { z } from 'zod'
import { NextResponse } from 'next/server'
import { proposeExpectedBreakage } from '@openbooks/engine/revenue'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { exactMoney,isoDate,uuidId } from '@/lib/api/json'
export const runtime='nodejs'
export const POST=defineRoute({permission:'ar.post',feature:'revenueRecognition',body:z.object({grantId:uuidId,effectiveOn:isoDate(),reason:z.string().trim().min(8).max(1000),idempotencyKey:z.string().min(1).max(120),
  estimate:z.object({method:z.enum(['expected_proportional','remaining_use_remote']),expectedBreakage:exactMoney(),entitled:z.boolean(),meetsReversalConstraint:z.boolean(),thirdPartyObligation:z.boolean(),evidence:z.string().trim().min(40).max(10000)}).strict()}).strict(),
  handler:async({authz,body})=>{try{return NextResponse.json({id:await proposeExpectedBreakage(authz.user.orgId,authz.user.id,body)},{status:201})}catch(error){return apiErrorResponse(error)}}})

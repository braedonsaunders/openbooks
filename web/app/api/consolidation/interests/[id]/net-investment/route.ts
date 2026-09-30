import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from '@/lib/api/json'
import { loadNetInvestmentOptions,proposeNetInvestmentAssessment } from '@openbooks/engine/consolidation'
const params=z.object({id:z.uuid()})
const schema=z.object({pairId:z.uuid(),bookId:z.uuid(),eliminationSubsidiaryId:z.uuid(),ociAccountId:z.uuid(),profitLossAccountId:z.uuid(),
  sourceLineIds:z.array(z.uuid()).min(1).max(200),notPlannedOrLikely:z.literal(true),nonTrade:z.literal(true),qualificationEvidence:z.string().trim().min(40).max(10000),
  effectiveOn:z.string(),reason:z.string().trim().min(8).max(1000),idempotencyKey:z.string().min(1).max(120)}).strict()
export const GET=defineRoute({permission:'close.run',feature:'multiSubsidiary',params,handler:async({authz,params})=>{
  try{return NextResponse.json(await loadNetInvestmentOptions(authz.user.orgId,params.id,authz.user.id))}catch(error){return apiErrorResponse(error)}
}})
export const POST=defineRoute({permission:'close.run',feature:'multiSubsidiary',params,handler:async({request,authz,params})=>{
  const body=await parseJsonBody(request,schema,{status:422});if(!body.ok)return body.response
  try{return NextResponse.json({changeId:await proposeNetInvestmentAssessment(authz.user.orgId,params.id,authz.user.id,body.data)})}catch(error){return apiErrorResponse(error)}
}})

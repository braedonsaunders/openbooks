import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from '@/lib/api/json'
import { proposeNetInvestmentReversal } from '@openbooks/engine/consolidation'
export const POST=defineRoute({permission:'close.run',feature:{none:"Correcting posted OCI remains available when its creation features are disabled"},params:z.object({id:z.uuid()}),handler:async({request,authz,params})=>{
  const body=await parseJsonBody(request,z.object({effectiveOn:z.string(),reason:z.string().trim().min(8).max(1000),idempotencyKey:z.string().min(1).max(120)}).strict(),{status:422})
  if(!body.ok)return body.response
  try{return NextResponse.json({changeId:await proposeNetInvestmentReversal(authz.user.orgId,params.id,authz.user.id,body.data)})}catch(error){return apiErrorResponse(error)}
}})

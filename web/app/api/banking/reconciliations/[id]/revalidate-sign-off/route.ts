import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { uuidId } from '@/lib/api/json'
import { previewSignOffRevalidation, revalidateReconciliationSignOff } from '@openbooks/engine/banking/banking'

export const runtime = 'nodejs'
const params = z.strictObject({id:uuidId})

export const GET = defineRoute({
  permission:'banking.reconcile',feature:'banking',params,
  handler:async ({authz,params}) => NextResponse.json(await previewSignOffRevalidation(params.id,{
    orgId:authz.user.orgId,userId:authz.user.id,allowedSubsidiaryIds:authz.allowedSubsidiaryIds,
  })),
})

export const POST = defineRoute({
  permission:'banking.reconcile',feature:'banking',params,
  body:z.strictObject({expectedDigest:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string().trim().min(10).max(500)}),
  handler:async ({authz,params,body}) => NextResponse.json(await revalidateReconciliationSignOff(params.id,body,{
    orgId:authz.user.orgId,userId:authz.user.id,allowedSubsidiaryIds:authz.allowedSubsidiaryIds,
  })),
})

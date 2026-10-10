import { z } from 'zod'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { lockActorCommandAuthority } from '@openbooks/engine/src/organization/actor-command-authority.ts'
import { searchProductionTimeChoices } from '@openbooks/engine/src/manufacturing/workspace.ts'
import { defineRoute } from '@/lib/api/route'
import { authorizeTimeWorkspace } from '@/lib/time-workspace'
const Query = z.strictObject({ workFamily: z.literal('production'), q:z.string().max(200).optional(), selected:z.uuid().optional(), workOrderId:z.uuid().optional() })
export const runtime = 'nodejs'
export const GET = defineRoute({
  authorize: authorizeTimeWorkspace('time.read'),
  feature: 'manufacturing',
  handler: async ({authz,request}) => {
    const input=Query.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!input.success) return Response.json({error:'Invalid production time filters.'},{status:422})
    return withOrgTransaction(authz.user.orgId,async()=>{
      const actualScope=await lockActorCommandAuthority(db,authz.user.orgId,authz.user.id,null,'time.read')
      await lockActorCommandAuthority(db,authz.user.orgId,authz.user.id,null,'manufacturing.read')
      // The session may narrow current authority, never enlarge it.
      const scope=actualScope===null ? authz.allowedSubsidiaryIds : authz.allowedSubsidiaryIds===null ? actualScope : new Set([...actualScope].filter(id=>authz.allowedSubsidiaryIds!.has(id)))
      return Response.json(await searchProductionTimeChoices(db,authz.user.orgId,scope,input.data))
    })
  }
})

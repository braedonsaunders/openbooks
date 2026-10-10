import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { guardPermission } from '@/lib/authz'
import { db,withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { searchOperatingDepartments } from '@openbooks/engine/src/organization/operating-profiles.ts'
const Query=z.strictObject({family:z.enum(['project','production']),q:z.string().max(200).optional(),selected:z.uuid().optional()})
export const runtime='nodejs'
export const GET=defineRoute({
  authorize:async({request})=>{
    const family=new URL(request.url).searchParams.get('family')
    if(family!=='project'&&family!=='production') return NextResponse.json({error:'Choose project or production.'},{status:422})
    return guardPermission(family==='project'?'projects.read':'manufacturing.read')
  },
  feature:{none:'Native workflow family reads enforce their current feature and department scope.'},
  handler:async({request,authz})=>{
    const query=Query.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if(!query.success) return NextResponse.json({error:'Invalid department filters.'},{status:422})
    return withOrgTransaction(authz.user.orgId,()=>searchOperatingDepartments(db,authz.user.orgId,authz.user.id,query.data.family,query.data.q,query.data.selected).then(rows=>Response.json(rows)))
  }
})

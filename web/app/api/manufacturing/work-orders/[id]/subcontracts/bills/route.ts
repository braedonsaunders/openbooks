import {z} from 'zod';
import {defineRoute} from '@/lib/api/route';
import {db,withOrgTransaction} from '@openbooks/engine/src/platform/db.ts';
import {searchProductionServiceBills} from '@openbooks/engine/src/manufacturing/subcontract-workspace.ts';
const params=z.object({id:z.uuid()}).strict();
export const GET=defineRoute({permission:'ap.read',feature:'manufacturingSubcontract',params,handler:({authz,params,request})=>{
 const query=z.object({contractId:z.uuid(),q:z.string().max(200).optional(),selected:z.uuid().optional()}).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams));
 if(!query.success)return Response.json({error:'Choose a valid subcontract and bill search.'},{status:422});
 return withOrgTransaction(authz.user.orgId,async()=>Response.json(await searchProductionServiceBills(db,authz.user.orgId,authz.user.id,params.id,query.data.contractId,query.data.q??'',query.data.selected)));
}});

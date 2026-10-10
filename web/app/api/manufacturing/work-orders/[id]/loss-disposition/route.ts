import {z} from 'zod';
import {defineRoute} from '@/lib/api/route';
import {db,withOrgTransaction} from '@openbooks/engine/src/platform/db.ts';
import {proposeProductionLoss} from '@openbooks/engine/src/manufacturing/loss-disposition.ts';
const uuid=z.string().uuid();
export const POST=defineRoute({permission:'items.post',feature:'manufacturing',params:z.object({id:uuid}),body:z.object({operationId:uuid,reasonId:uuid,quantity:z.string(),reason:z.string().trim().min(8).max(1000),times:z.array(z.object({operationId:uuid,attemptedQty:z.string(),actualSetupMinutes:z.string(),actualRunMinutes:z.string(),actualLaborMinutes:z.string().nullable().optional()}).strict()).max(500)}).strict(),handler:({authz,params,body,request})=>withOrgTransaction(authz.user.orgId,async()=>Response.json(await proposeProductionLoss(db,authz.user.orgId,authz.user.id,params.id,{...body,requestKey:uuid.parse(request.headers.get('Idempotency-Key'))}))) });

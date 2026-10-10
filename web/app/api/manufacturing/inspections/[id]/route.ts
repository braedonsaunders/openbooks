import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts';
import { readManufacturingInspection } from '@openbooks/engine/src/manufacturing/quality-workspace.ts';
import { recordQualityInspection } from '@openbooks/engine/src/manufacturing/quality-execution.ts';
import { disposeQualityInspection } from '@openbooks/engine/src/manufacturing/quality-disposition.ts';
const params=z.object({id:z.string().uuid()}).strict();
export const GET=defineRoute({permission:'manufacturing.read',feature:'manufacturing',params,handler:async({authz,params})=>withOrgTransaction(authz.user.orgId,async()=>Response.json(await readManufacturingInspection(db,authz.user.orgId,authz.user.id,params.id)))});
const body=z.discriminatedUnion('command',[
  z.object({command:z.literal('inspect'),outcome:z.enum(['pass','fail']),measurements:z.record(z.string(),z.string()),reason:z.string().trim().min(5).max(500),quantity:z.string().optional(),lotId:z.string().uuid().nullable().optional(),serialId:z.string().uuid().nullable().optional()}).strict(),
  z.object({command:z.literal('dispose'),action:z.enum(['use_as_is','scrap','rework']),reason:z.string().trim().min(5).max(500),requestKey:z.string().uuid(),scrapReasonId:z.string().uuid().optional(),reworkRoutingId:z.string().uuid().optional(),reworkSequence:z.number().int().positive().optional()}).strict(),
]);
export const POST=defineRoute({permission:'manufacturing.manage',feature:'manufacturing',params,body,handler:async({authz,params,body})=>withOrgTransaction(authz.user.orgId,async()=>{
  const value=body.command==='inspect'?await recordQualityInspection(db,authz.user.orgId,authz.user.id,params.id,body):await disposeQualityInspection(db,authz.user.orgId,authz.user.id,params.id,body);
  return Response.json(value);
})});

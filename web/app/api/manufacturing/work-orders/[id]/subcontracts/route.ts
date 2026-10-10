import {z} from 'zod';
import {sql} from 'drizzle-orm';
import {defineRoute} from '@/lib/api/route';
import {db,withOrgTransaction} from '@openbooks/engine/src/platform/db.ts';
import {readSubcontractWorkspace} from '@openbooks/engine/src/manufacturing/subcontract-workspace.ts';
import {createProductionSubcontract,shipSubcontractMaterial,recordSubcontractReturn,capitalizeSubcontractServiceBill,reverseSubcontractServiceCost,returnSubcontractComponents,cancelProductionSubcontract} from '@openbooks/engine/src/manufacturing/subcontracts.ts';
import {ManufacturingNotFoundError} from '@openbooks/engine/src/manufacturing/errors.ts';
const params=z.object({id:z.string().uuid()}).strict();
export const GET=defineRoute({permission:'manufacturing.read',feature:'manufacturingSubcontract',params,handler:({authz,params,request})=>withOrgTransaction(authz.user.orgId,async()=>{
  const selected=new URL(request.url).searchParams.get('selected');
  const selection=z.string().uuid().optional().parse(selected??undefined);
  return Response.json(await readSubcontractWorkspace(db,authz.user.orgId,authz.user.id,params.id,selection));
})});
const id=z.string().uuid(),reason=z.string().trim().min(5).max(500),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const body=z.discriminatedUnion('command',[
  z.object({command:z.literal('create'),id,operationId:id,vendorId:id,custodyLocationId:id}).strict(),
  z.object({command:z.literal('ship'),id,subcontractId:id,materialId:id,sourceLocationId:id,quantity:z.string(),date,lotId:id.nullable().optional(),serialId:id.nullable().optional()}).strict(),
  z.object({command:z.literal('return'),id,subcontractId:id,quantity:z.string(),finish:z.boolean(),finishReason:reason.nullable().optional(),consumption:z.array(z.object({shipmentId:id,quantity:z.string()}).strict()).max(100).optional(),measuredQty:z.string().nullable().optional(),actualSetupMinutes:z.string().nullable().optional(),actualRunMinutes:z.string().nullable().optional(),actualLaborMinutes:z.string().nullable().optional()}).strict(),
  z.object({command:z.literal('service'),id,subcontractId:id,billId:id}).strict(),
  z.object({command:z.literal('reverseService'),subcontractId:id,claimId:id,date,reason}).strict(),
  z.object({command:z.literal('returnComponents'),id,subcontractId:id,shipmentId:id,date,reason}).strict(),
  z.object({command:z.literal('cancel'),subcontractId:id,reason}).strict(),
]);
export const POST=defineRoute({permission:'items.post',feature:'manufacturingSubcontract',params,body,handler:({authz,params,body})=>withOrgTransaction(authz.user.orgId,async()=>{
  const org=authz.user.orgId,actor=authz.user.id;
  if(body.command==='create')return Response.json(await createProductionSubcontract(db,org,actor,{id:body.id,workOrderId:params.id,operationId:body.operationId,vendorId:body.vendorId,custodyLocationId:body.custodyLocationId}));
  if(!(await db.execute(sql`select id from mfg_subcontracts where org_id=${org} and id=${body.subcontractId} and work_order_id=${params.id}`)).rows.length)throw new ManufacturingNotFoundError();
  const subcontractId=body.subcontractId;
  // Each command derives fresh authority on the actual retained work order before replay or writes.
  if(body.command==='ship')return Response.json(await shipSubcontractMaterial(db,org,actor,subcontractId,body));
  if(body.command==='return')return Response.json(await recordSubcontractReturn(db,org,actor,subcontractId,body));
  if(body.command==='service')return Response.json(await capitalizeSubcontractServiceBill(db,org,actor,subcontractId,body.billId,body.id));
  if(body.command==='reverseService')return Response.json(await reverseSubcontractServiceCost(db,org,actor,subcontractId,body.claimId,body.date,body.reason));
  if(body.command==='returnComponents')return Response.json(await returnSubcontractComponents(db,org,actor,subcontractId,body));
  return Response.json(await cancelProductionSubcontract(db,org,actor,subcontractId,body.reason));
})});

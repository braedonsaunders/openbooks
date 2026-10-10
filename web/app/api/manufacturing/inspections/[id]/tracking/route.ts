import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts';
import { readManufacturingInspection } from '@openbooks/engine/src/manufacturing/quality-workspace.ts';
import { inventoryTrackingOptions } from '@openbooks/engine/src/inventory/tracking-options.ts';
import { registerInspectionIdentifier } from '@openbooks/engine/src/manufacturing/quality-execution.ts';
import { isoDate } from '@/lib/api/json';
export const GET=defineRoute({permission:'manufacturing.read',feature:'manufacturing',params:z.object({id:z.string().uuid()}).strict(),handler:async({request,authz,params})=>withOrgTransaction(authz.user.orgId,async()=>{
  const inspection=await readManufacturingInspection(db,authz.user.orgId,authz.user.id,params.id);
  const sp=new URL(request.url).searchParams;
  const options=await inventoryTrackingOptions(authz.user.orgId,authz.user.id,{itemId:inspection.itemId,q:sp.get('q')??'',...Object.fromEntries(['lotId','selectedLotId','selectedSerialId'].filter(key=>sp.get(key)).map(key=>[key,z.string().uuid().parse(sp.get(key))]))});
  return Response.json(options);
})});
export const POST=defineRoute({permission:'manufacturing.manage',feature:'manufacturing',params:z.object({id:z.string().uuid()}).strict(),body:z.object({kind:z.enum(['lot','serial']),number:z.string().trim().min(1).max(200),expiresOn:isoDate().nullable().optional()}).strict(),handler:async({authz,params,body})=>withOrgTransaction(authz.user.orgId,async()=>Response.json(await registerInspectionIdentifier(db,authz.user.orgId,authz.user.id,params.id,body))) });

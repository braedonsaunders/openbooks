import { defineRoute } from '@/lib/api/route';
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts';
import { saveInspectionPlan } from '@openbooks/engine/src/inventory/inspections.ts';
import { InspectionPlanBody } from './contract';
import { z } from 'zod';
export const POST=defineRoute({permission:'admin.setup.manage',scope:'unrestricted',feature:'manufacturing',body:InspectionPlanBody,handler:async({request,authz,body})=>{
  const id=z.string().uuid().parse(request.headers.get('Idempotency-Key'));
  return withOrgTransaction(authz.user.orgId,async()=>Response.json(await saveInspectionPlan(db,authz.user.orgId,authz.user.id,{...body,id}),{status:201}));
}});

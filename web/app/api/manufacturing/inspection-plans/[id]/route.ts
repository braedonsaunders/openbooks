import { defineRoute } from '@/lib/api/route';
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts';
import { saveInspectionPlan } from '@openbooks/engine/src/inventory/inspections.ts';
import { InspectionPlanBody } from '../contract';
import { z } from 'zod';
export const PATCH=defineRoute({permission:'admin.setup.manage',scope:'unrestricted',feature:'manufacturing',params:z.object({id:z.string().uuid()}).strict(),body:InspectionPlanBody.extend({expectedRevision:z.number().int().positive()}),handler:async({authz,body,params})=>withOrgTransaction(authz.user.orgId,async()=>Response.json(await saveInspectionPlan(db,authz.user.orgId,authz.user.id,{...body,id:params.id}))) });

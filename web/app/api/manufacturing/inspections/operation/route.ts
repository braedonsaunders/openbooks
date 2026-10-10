import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts';
import { createOperationInspection } from '@openbooks/engine/src/manufacturing/quality-execution.ts';
export const POST=defineRoute({permission:'manufacturing.manage',feature:'manufacturing',body:z.object({workOrderId:z.string().uuid(),operationId:z.string().uuid(),id:z.string().uuid(),quantity:z.string()}).strict(),handler:async({authz,body})=>withOrgTransaction(authz.user.orgId,async()=>Response.json(await createOperationInspection(db,authz.user.orgId,authz.user.id,body.workOrderId,body.operationId,{id:body.id,quantity:body.quantity}))) });

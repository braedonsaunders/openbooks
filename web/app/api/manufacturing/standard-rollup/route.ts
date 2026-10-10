import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { previewStandardRollup, proposeStandardRollup } from "@openbooks/engine/src/manufacturing/standard-rollup.ts";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../_transaction";

const Basis=z.object({itemId:z.string().uuid(),subsidiaryId:z.string().uuid(),onDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),batchQuantity:z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,4})?$/)});
const Body=z.discriminatedUnion("action",[Basis.extend({action:z.literal("preview")}).strict(),Basis.extend({action:z.literal("propose"),reason:z.string().trim().min(8).max(1000),idempotencyKey:z.string().uuid(),expectedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()]);
export const POST=defineRoute({permission:"manufacturing.manage",feature:"manufacturing",scope:"unrestricted",body:Body,handler:async({authz,body})=>manufacturingTransaction(authz.user.orgId,async()=>{
  const {action,...input}=body;
  return Response.json(action==="preview"?await previewStandardRollup(db,authz.user.orgId,authz.user.id,input):await proposeStandardRollup(db,authz.user.orgId,authz.user.id,input as z.infer<typeof Basis>&{reason:string;idempotencyKey:string;expectedDigest:string}));
})});

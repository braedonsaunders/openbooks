import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { createScratchUser, seedApprovalFlow } from "./fixtures.ts";
import { proposeRoutingActivation, activateRouting } from "../manufacturing/routings.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";

/** Disposable callers obtain a real independent decision through the native flow. */
export async function approveFixtureRouting(tx:SqlExecutor,orgId:string,actorId:string,routingId:string) {
  const subsidiary=(await tx.execute<{id:string}>(sql`select id from subsidiaries where org_id=${orgId} and is_active and not is_elimination order by id limit 1`)).rows[0];
  if(!subsidiary)throw new Error("Routing fixture requires an operating legal entity.");
  const approver=await createScratchUser(orgId,"Engineering approver "+randomUUID(),"admin");
  const flow=await seedApprovalFlow(orgId,{subjectKind:"financial_change",assignees:[{type:"user",userId:approver}],mode:"any",preventSelfApproval:true});
  const proposal=await proposeRoutingActivation(tx,orgId,actorId,routingId,{subsidiaryId:subsidiary.id,reason:"Approve the configured production revision",idempotencyKey:randomUUID()});
  await submitFinancialChange(orgId,proposal.changeId,actorId);
  const gates=(await db.execute<{id:string}>(sql`select id from flow_gates where org_id=${orgId} and flow_id=${flow.flowId} and subject_kind='financial_change' and subject_id=${proposal.changeId} and status='pending'`)).rows;
  if(gates.length!==1)throw new Error("Routing fixture must create one independent approval gate.");
  await decideGate({gateId:gates[0]!.id,userId:approver,decision:"approved"});
  const result=await activateRouting(tx,orgId,actorId,routingId,proposal.changeId);
  const disabled=await db.execute(sql`update flows set enabled=false where org_id=${orgId} and id=${flow.flowId} returning id`);
  if(disabled.rows.length!==1)throw new Error("Routing fixture must retire its isolated approval policy.");
  return result;
}

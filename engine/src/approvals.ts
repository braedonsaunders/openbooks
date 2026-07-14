import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { cmp } from "./money.ts";

/**
 * Approval engine runtime. A policy's rules declare ordered steps with
 * amount thresholds and role/person assignees; submitting a target builds
 * the concrete request + steps; decisions advance or reject; when the last
 * step approves, the target is releasable (documents flip to 'approved').
 */

interface Rule {
  step: number;
  minAmount?: number;
  approverRole?: string;
  approverPartyId?: string;
}

export async function submitForApproval(targetKind: string, targetId: string): Promise<string> {
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, targetId));
  if (!doc) throw new Error("target document not found");
  if (doc.status !== "draft") throw new Error(`document is ${doc.status}, not draft`);

  const [policy] = await db
    .select()
    .from(schema.approvalPolicies)
    .where(and(
      eq(schema.approvalPolicies.orgId, doc.orgId),
      eq(schema.approvalPolicies.targetKind, targetKind),
      eq(schema.approvalPolicies.isActive, true),
    ));
  if (!policy) throw new Error(`no active approval policy for ${targetKind}`);

  const rules = (policy.rules as Rule[])
    .filter((r) => cmp(doc.total, String(r.minAmount ?? 0)) >= 0)
    .sort((a, b) => a.step - b.step);
  if (rules.length === 0) throw new Error("policy produced no steps");

  const [request] = await db
    .insert(schema.approvalRequests)
    .values({
      orgId: doc.orgId,
      policyId: policy.id,
      targetKind,
      targetId,
      amount: doc.total,
      submittedBy: doc.createdBy ?? doc.partyId ?? doc.id,
    })
    .returning();

  await db.insert(schema.approvalSteps).values(
    rules.map((r, i) => ({
      orgId: doc.orgId,
      requestId: request.id,
      stepNumber: i + 1,
      assigneeRole: r.approverRole ?? null,
      assigneePartyId: r.approverPartyId ?? null,
    })),
  );

  await db.update(schema.documents)
    .set({ status: "pending_approval" })
    .where(eq(schema.documents.id, targetId));
  return request.id;
}

export async function decide(
  requestId: string,
  stepNumber: number,
  decision: "approved" | "rejected",
  deciderId: string,
  note?: string,
): Promise<{ requestStatus: string }> {
  const [request] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, requestId));
  if (!request || request.status !== "pending") throw new Error("request is not pending");
  if (stepNumber !== request.currentStep) throw new Error(`current step is ${request.currentStep}`);

  const steps = await db
    .select()
    .from(schema.approvalSteps)
    .where(eq(schema.approvalSteps.requestId, requestId))
    .orderBy(asc(schema.approvalSteps.stepNumber));
  const step = steps.find((s) => s.stepNumber === stepNumber);
  if (!step || step.decision !== "pending") throw new Error("step is not pending");

  await db.update(schema.approvalSteps)
    .set({ decision, decidedBy: deciderId, decidedAt: new Date(), note: note ?? null })
    .where(eq(schema.approvalSteps.id, step.id));

  let requestStatus: "pending" | "approved" | "rejected" = "pending";
  if (decision === "rejected") {
    requestStatus = "rejected";
  } else if (stepNumber === steps.length) {
    requestStatus = "approved";
  }

  if (requestStatus === "pending") {
    await db.update(schema.approvalRequests)
      .set({ currentStep: stepNumber + 1 })
      .where(eq(schema.approvalRequests.id, requestId));
  } else {
    await db.update(schema.approvalRequests)
      .set({ status: requestStatus, resolvedAt: new Date() })
      .where(eq(schema.approvalRequests.id, requestId));
    await db.update(schema.documents)
      .set({ status: requestStatus === "approved" ? "approved" : "draft" })
      .where(eq(schema.documents.id, request.targetId));
  }
  return { requestStatus };
}

/** Pending steps assigned to a role (worklist query). */
export async function worklist(orgId: string, role: string) {
  const { sql } = await import("drizzle-orm");
  const r = (await db.execute(sql`
    select s.id as step_id, s.step_number, r.id as request_id, r.amount,
           d.id as document_id, d.document_number, d.kind, d.document_date, d.memo,
           p.display_name as party
      from approval_steps s
      join approval_requests r on r.id = s.request_id and r.status = 'pending'
      join documents d on d.id = r.target_id
      left join parties p on p.id = d.party_id
     where s.decision = 'pending' and s.step_number = r.current_step
       and (s.assignee_role = ${role} or ${role} = 'admin')
       and s.org_id = ${orgId}
     order by d.document_date
  `)) as any;
  return r.rows;
}

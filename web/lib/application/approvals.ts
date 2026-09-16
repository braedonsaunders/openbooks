import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  decideDocumentApproval,
  DocumentApprovalError,
  worklistApprovals,
  type WorklistDocument,
  type WorklistPayRun,
} from "@openbooks/engine/src/approval-worklist.ts";
import {
  decideGate,
  GateError,
  type WorklistGate,
} from "@openbooks/engine/src/flows/index.ts";
import { decidePaymentRun } from "@openbooks/engine/src/payment-operations.ts";
import { PaymentError } from "@openbooks/engine/src/payments.ts";
import { can, type Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import { isUuid } from "../list-params";
import { paymentRunScopeSql } from "../payment-run-access";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, forbidden, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

export type ApprovalWorklistItem =
  | ({ kind: "flow_gate" } & WorklistGate)
  | ({ kind: "document" } & WorklistDocument)
  | ({ kind: "pay_run" } & WorklistPayRun);

type PayDirection = "outbound" | "inbound";

function payApproveDirectionsForAuthz(authz: Authz): PayDirection[] {
  const directions: PayDirection[] = [];
  if (can(authz, "ap.approve")) directions.push("outbound");
  if (can(authz, "ar.approve")) directions.push("inbound");
  return directions;
}

/**
 * One worklist for every thing awaiting the caller's approval: pending Flows
 * gates (assigned, role-held, or delegated), document-status approvals with
 * no pending gate, and pending payment runs. Gate rows keep their exact
 * shape; document and pay-run rows carry a kind discriminator and their own
 * decide handle. get_vitals counts this same array, so the two can never
 * disagree.
 */
export async function listApprovalWorklist(context: ApplicationContext): Promise<ApprovalWorklistItem[]> {
  return approvalWorklistForAuthz(context.authz);
}

/**
 * The unified worklist for a bare Authz (no transport context): pending Flows
 * gates, gateless document-status approvals, and pending payment runs. The
 * read path only ever touches authz, so surfaces that hold no
 * ApplicationContext (dashboard metrics, cron summaries) share this exact
 * reader instead of re-querying one leg of the union. Callers that cannot
 * approve anything must apply the same doorway as get_vitals (flows.approve,
 * ap.approve, or ar.approve) and treat the result as empty — the reader
 * itself throws for a caller with no approve path, mirroring the worklist.
 */
export async function approvalWorklistForAuthz(authz: Authz): Promise<ApprovalWorklistItem[]> {
  const orgId = authz.user.orgId;
  const flowsOn = await isFeatureEnabled(orgId, "flows");
  const mayFlows = flowsOn && can(authz, "flows.approve");
  const payDirections = payApproveDirectionsForAuthz(authz);
  if (!mayFlows && payDirections.length === 0) {
    if (!flowsOn) return [];
    throw forbidden("flows.approve");
  }
  const items = await worklistApprovals(orgId, authz.user.id, {
    roles: authz.user.roles.map((role) => role.key),
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    includePayRuns: payDirections.length > 0,
  });
  const out: ApprovalWorklistItem[] = [];
  const payCandidates = items.filter((item) => item.kind === "pay_run");
  let payAllowed = new Set<string>();
  if (payCandidates.length > 0) {
    // The run's full record boundary (header plus retained source evidence),
    // shared with the lists, drawers, and API verbs.
    const scoped = (await db.execute<{ id: string; direction: string }>(sql`
      select r.id, r.direction from payment_runs r
       where r.org_id = ${orgId}
         and r.id in (select jsonb_array_elements_text(${JSON.stringify(payCandidates.map((item) => item.id))}::jsonb)::uuid)
         and ${paymentRunScopeSql(authz, "r")}`)).rows;
    payAllowed = new Set(
      scoped.filter((row) => payDirections.includes(row.direction as PayDirection)).map((row) => row.id),
    );
  }
  for (const item of items) {
    if (item.kind === "flow_gate") {
      if (mayFlows) out.push({ ...item.gate, kind: "flow_gate" });
    } else if (item.kind === "document") {
      if (mayFlows) out.push({ ...item.document, kind: "document" });
    } else if (payAllowed.has(item.id)) {
      out.push({ ...item.payRun, kind: "pay_run" });
    }
  }
  return out;
}

export interface DecideApprovalInput {
  gateId?: string;
  documentId?: string;
  paymentRunId?: string;
  decision: "approved" | "rejected";
  comment?: string;
  signature?: string;
  idempotencyKey: string;
}

export async function decideApproval(
  context: ApplicationContext,
  input: DecideApprovalInput,
): Promise<{ replayed: boolean; result: unknown }> {
  const subjects = [input.gateId, input.documentId, input.paymentRunId].filter((id) => id != null);
  if (subjects.length !== 1) {
    throw invalidInput("exactly one of gateId, documentId, or paymentRunId is required");
  }
  if (input.decision !== "approved" && input.decision !== "rejected") {
    throw invalidInput("decision must be approved or rejected");
  }
  if (input.decision === "rejected" && !input.comment?.trim()) {
    throw invalidInput("a rejection comment is required");
  }
  if (input.gateId) {
    if (!(await isFeatureEnabled(context.authz.user.orgId, "flows"))) throw notFound("approval");
    assertApplicationPermission(context, "flows.approve");
    return decideGateSubject(context, input as DecideApprovalInput & { gateId: string });
  }
  if (input.documentId) {
    assertApplicationPermission(context, "flows.approve");
    return decideDocumentSubject(context, input as DecideApprovalInput & { documentId: string });
  }
  return decidePayRunSubject(context, input as DecideApprovalInput & { paymentRunId: string });
}

async function decideGateSubject(
  context: ApplicationContext,
  input: DecideApprovalInput & { gateId: string },
): Promise<{ replayed: boolean; result: unknown }> {
  if (!isUuid(input.gateId)) throw invalidInput("gateId must be a UUID");
  const visible = await listApprovalWorklist(context);
  const gate = visible.find(
    (candidate): candidate is Extract<ApprovalWorklistItem, { kind: "flow_gate" }> =>
      candidate.kind === "flow_gate" && candidate.id === input.gateId,
  );
  if (!gate) throw notFound("approval");
  if (gate.signatureRequired && input.decision === "approved" && !input.signature?.trim()) {
    throw invalidInput("this approval requires the actor's explicit signature");
  }
  const outcome = await executeIdempotent({
    context,
    operation: "approvals.decide",
    idempotencyKey: input.idempotencyKey,
    request: {
      gateId: input.gateId,
      decision: input.decision,
      comment: input.comment ?? null,
      signature: input.signature ?? null,
    },
    execute: async () => {
      try {
        return await decideGate({
          gateId: input.gateId,
          decision: input.decision,
          userId: context.authz.user.id,
          comment: input.comment,
          signature: input.signature,
        });
      } catch (error) {
        if (error instanceof GateError) {
          throw new ApplicationError("invalid_input", error.message, 422);
        }
        throw error;
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

async function decideDocumentSubject(
  context: ApplicationContext,
  input: DecideApprovalInput & { documentId: string },
): Promise<{ replayed: boolean; result: unknown }> {
  if (!isUuid(input.documentId)) throw invalidInput("documentId must be a UUID");
  const outcome = await executeIdempotent({
    context,
    operation: "approvals.decide-document",
    idempotencyKey: input.idempotencyKey,
    request: {
      documentId: input.documentId,
      decision: input.decision,
      comment: input.comment ?? null,
    },
    execute: async () => {
      try {
        return await decideDocumentApproval(
          context.authz.user.orgId,
          input.documentId,
          context.authz.user.id,
          input.decision,
          input.comment,
          context.authz.allowedSubsidiaryIds,
        );
      } catch (error) {
        if (error instanceof DocumentApprovalError) {
          throw new ApplicationError("invalid_input", error.message, 422);
        }
        throw error;
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

async function decidePayRunSubject(
  context: ApplicationContext,
  input: DecideApprovalInput & { paymentRunId: string },
): Promise<{ replayed: boolean; result: unknown }> {
  if (!isUuid(input.paymentRunId)) throw invalidInput("paymentRunId must be a UUID");
  // Same boundary as the pay-run decision route: the run's record scope plus
  // the direction-matched approval permission.
  const row = (await db.execute<{ direction: string }>(sql`
    select r.direction from payment_runs r
     where r.id = ${input.paymentRunId} and ${paymentRunScopeSql(context.authz, "r")}`)).rows[0];
  if (!row) throw notFound("approval");
  assertApplicationPermission(context, `${row.direction === "inbound" ? "ar" : "ap"}.approve`);
  const outcome = await executeIdempotent({
    context,
    operation: "approvals.decide-pay-run",
    idempotencyKey: input.idempotencyKey,
    request: {
      paymentRunId: input.paymentRunId,
      decision: input.decision,
      comment: input.comment ?? null,
    },
    execute: async () => {
      try {
        await decidePaymentRun(
          input.paymentRunId,
          context.authz.user.orgId,
          context.authz.user.id,
          input.decision === "approved" ? "approve" : "reject",
          input.comment,
        );
        return { status: input.decision };
      } catch (error) {
        if (error instanceof PaymentError) {
          throw new ApplicationError("invalid_input", error.message, 422);
        }
        throw error;
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

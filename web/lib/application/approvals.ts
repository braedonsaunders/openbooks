import "server-only";
import {
  decideDocumentApproval,
  DocumentApprovalError,
  worklistApprovals,
  worklistApprovalsPage,
  type WorklistBudget,
  type WorklistDocument,
} from "@openbooks/engine/src/flows/approval-worklist.ts";
import {
  decideGate,
  GateError,
  type WorklistGate,
} from "@openbooks/engine/src/flows/index.ts";
import { can, type Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import { isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, forbidden, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

export type ApprovalWorklistItem =
  | ({ kind: "flow_gate" } & WorklistGate)
  | ({ kind: "document" } & WorklistDocument)
  | ({ kind: "budget" } & WorklistBudget);

/**
 * One worklist for every thing awaiting the caller's approval: pending Flows
 * gates (assigned, role-held, or delegated — payment runs included),
 * document-status approvals with no pending gate, and pending budget
 * scenarios. Gate rows keep their exact shape; document and budget rows
 * carry a kind discriminator and their own decide handle. get_vitals counts this
 * same array, so the two can never disagree.
 */
export async function listApprovalWorklist(context: ApplicationContext): Promise<ApprovalWorklistItem[]> {
  return approvalWorklistForAuthz(context.authz);
}

/**
 * The unified worklist for a bare Authz (no transport context): pending Flows
 * gates, gateless document-status approvals, and pending budget scenarios. The read path only ever touches authz, so surfaces
 * that hold no ApplicationContext (dashboard metrics, cron summaries) share
 * this exact reader instead of re-querying one leg of the union. Callers
 * that cannot approve anything must apply the same doorway as get_vitals
 * (flows.approve or budgets.approve) and treat the
 * result as empty — the reader itself throws for a caller with no approve
 * path, mirroring the worklist.
 */
export async function approvalWorklistForAuthz(authz: Authz): Promise<ApprovalWorklistItem[]> {
  const orgId = authz.user.orgId;
  const flowsOn = await isFeatureEnabled(orgId, "flows");
  const mayFlows = flowsOn && can(authz, "flows.approve");
  const budgetsOn = await isFeatureEnabled(orgId, "budgets");
  const mayBudgets = budgetsOn && can(authz, "budgets.approve");
  if (!mayFlows && !mayBudgets) {
    if (!flowsOn) return [];
    throw forbidden("flows.approve");
  }
  const items = await worklistApprovals(orgId, authz.user.id, {
    roles: authz.user.roles.map((role) => role.key),
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    includeBudgets: mayBudgets,
  });
  const out: ApprovalWorklistItem[] = [];
  for (const item of items) {
    if (item.kind === "flow_gate") {
      if (mayFlows) out.push({ ...item.gate, kind: "flow_gate" });
    } else if (item.kind === "document") {
      if (mayFlows) out.push({ ...item.document, kind: "document" });
    } else if (item.kind === "budget") {
      if (mayBudgets) out.push({ ...item.budget, kind: "budget" });
    }
  }
  return out;
}

export interface ApprovalWorklistWindow {
  limit: number;
  offset: number;
  kind?: string;
  query?: string;
  overdue?: boolean;
}

/**
 * One server-side page over the unified worklist: same doorway, same legs,
 * same per-item shape as approvalWorklistForAuthz, but each leg fetches only
 * its leading offset+limit rows in SQL and the total/kind counts come from
 * GROUP BY aggregates. The dashboard tile keeps the full reader; the center
 * reads here so a real approval backlog cannot slow the page.
 */
export async function approvalWorklistPageForAuthz(
  authz: Authz,
  window: ApprovalWorklistWindow,
): Promise<{ items: ApprovalWorklistItem[]; total: number; kindCounts: Map<string, number> }> {
  const orgId = authz.user.orgId;
  const flowsOn = await isFeatureEnabled(orgId, "flows");
  const mayFlows = flowsOn && can(authz, "flows.approve");
  const budgetsOn = await isFeatureEnabled(orgId, "budgets");
  const mayBudgets = budgetsOn && can(authz, "budgets.approve");
  if (!mayFlows && !mayBudgets) {
    if (!flowsOn) return { items: [], total: 0, kindCounts: new Map() };
    throw forbidden("flows.approve");
  }
  const page = await worklistApprovalsPage(
    orgId,
    authz.user.id,
    {
      roles: authz.user.roles.map((role) => role.key),
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      includeFlows: mayFlows,
      includeBudgets: mayBudgets,
    },
    { limit: window.limit, offset: window.offset, kind: window.kind, query: window.query, overdue: window.overdue },
  );
  const out: ApprovalWorklistItem[] = [];
  for (const item of page.items) {
    if (item.kind === "flow_gate") {
      if (mayFlows) out.push({ ...item.gate, kind: "flow_gate" });
    } else if (item.kind === "document") {
      if (mayFlows) out.push({ ...item.document, kind: "document" });
    } else if (item.kind === "budget") {
      if (mayBudgets) out.push({ ...item.budget, kind: "budget" });
    }
  }
  return { items: out, total: page.total, kindCounts: page.kindCounts };
}

export interface DecideApprovalInput {
  gateId?: string;
  documentId?: string;
  decision: "approved" | "rejected";
  comment?: string;
  signature?: string;
  idempotencyKey: string;
}

export async function decideApproval(
  context: ApplicationContext,
  input: DecideApprovalInput,
): Promise<{ replayed: boolean; result: unknown }> {
  const subjects = [input.gateId, input.documentId].filter((id) => id != null);
  if (subjects.length !== 1) {
    throw invalidInput("exactly one of gateId or documentId is required");
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
  assertApplicationPermission(context, "flows.approve");
  return decideDocumentSubject(context, input as DecideApprovalInput & { documentId: string });
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

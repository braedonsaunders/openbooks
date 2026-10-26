import "server-only";
import {
  worklistApprovals,
  worklistApprovalsCount,
  worklistApprovalsPage,
  worklistGatesAwaitingAnotherApprover,
} from "@openbooks/engine/flows/approval-worklist";
import {
  decideGate,
  gateDecisionCapability,
  GateError,
  type WorklistGate,
} from "@openbooks/engine/flows/module";
import { can, type Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import { isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, forbidden, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

export type ApprovalWorklistItem = {
  kind: "flow_gate";
  awaitingAnotherApprover?: boolean;
  /**
   * The viewer may decide this gate through the native decide path
   * (assigned directly, by role or by active delegation, and permitted
   * by its frozen separation policy). Set by the
   * organization reader, whose rows are not all the viewer's to decide;
   * the caller's own worklist carries only gates that reach them.
   */
  canDecide?: boolean;
  /** The viewer may hand this gate to another user (delegateGate's rule). */
  canDelegate?: boolean;
} & WorklistGate;

/** One tenant Flow gate population feeds the worklist and dashboard counts. */
export async function listApprovalWorklist(
  context: ApplicationContext,
): Promise<ApprovalWorklistItem[]> {
  return approvalWorklistForAuthz(context.authz);
}

/** Authenticated surfaces share the same native gate reader and scope. */
export async function approvalWorklistForAuthz(authz: Authz): Promise<ApprovalWorklistItem[]> {
  const scope = await approvalWorklistScopeForAuthz(authz);
  if (!scope) return [];
  const { orgId, mayFlows } = scope;
  const items = await worklistApprovals(orgId, authz.user.id, {
    roles: authz.user.roles.map((role) => role.key),
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
  });
  const out: ApprovalWorklistItem[] = [];
  for (const item of items) {
    if (item.kind === "flow_gate") {
      if (mayFlows) out.push({ ...item.gate, kind: "flow_gate" });
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
): Promise<{
  items: ApprovalWorklistItem[];
  total: number;
  kindCounts: Map<string, number>;
}> {
  const scope = await approvalWorklistScopeForAuthz(authz);
  if (!scope) return { items: [], total: 0, kindCounts: new Map() };
  const { orgId, mayFlows } = scope;
  const page = await worklistApprovalsPage(
    orgId,
    authz.user.id,
    {
      roles: authz.user.roles.map((role) => role.key),
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      includeFlows: mayFlows,
    },
    {
      limit: window.limit,
      offset: window.offset,
      kind: window.kind,
      query: window.query,
      overdue: window.overdue,
    },
  );
  const out: ApprovalWorklistItem[] = [];
  for (const item of page.items) {
    if (item.kind === "flow_gate") {
      // Resolve the SoD outcome per row through the native gate check, so
      // the page renders "awaiting another approver" instead of offering an
      // Approve that refuses on click. Bounded by the page window.
      if (mayFlows) {
        const capability = await gateDecisionCapability(item.gate.id, authz.user.id);
        out.push({
          ...item.gate,
          kind: "flow_gate",
          canDecide: capability.canAct,
          awaitingAnotherApprover: capability.sodBlocked,
          canDelegate: capability.canDelegate,
        });
      }
    }
  }
  return { items: out, total: page.total, kindCounts: page.kindCounts };
}

/** Oversight lists all live tenant gates inside the viewer's entity scope.
 * Each row resolves actual assignment, permission and frozen separation policy. */
export async function approvalWorklistOrganizationPageForAuthz(
  authz: Authz,
  window: ApprovalWorklistWindow,
): Promise<{
  items: ApprovalWorklistItem[];
  total: number;
  kindCounts: Map<string, number>;
}> {
  if (!can(authz, "flows.manage")) throw forbidden("flows.manage");
  const orgId = authz.user.orgId;
  const flowsOn = await isFeatureEnabled(orgId, "flows");
  if (!flowsOn) return { items: [], total: 0, kindCounts: new Map() };
  const page = await worklistApprovalsPage(
    orgId,
    authz.user.id,
    {
      roles: authz.user.roles.map((role) => role.key),
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      includeFlows: flowsOn,
      audience: "organization",
    },
    {
      limit: window.limit,
      offset: window.offset,
      kind: window.kind,
      query: window.query,
      overdue: window.overdue,
    },
  );
  const out: ApprovalWorklistItem[] = [];
  for (const item of page.items) {
    if (item.kind === "flow_gate") {
      // Bounded by the page window, like the caller reader's SoD check.
      const capability = await gateDecisionCapability(item.gate.id, authz.user.id);
      out.push({
        ...item.gate,
        kind: "flow_gate",
        canDecide: capability.canAct,
        awaitingAnotherApprover: capability.sodBlocked,
        canDelegate: capability.canDelegate,
      });
    }
  }
  return { items: out, total: page.total, kindCounts: page.kindCounts };
}

/**
 * How many of the caller's union approvals await ANOTHER approver
 * (SoD-blocked gates). Counted separately from actionable items: the My
 * approvals tab keeps its headline total while the awaiting rows render
 * without decision actions under their own figure.
 */
export async function approvalWorklistAwaitingForAuthz(authz: Authz): Promise<number> {
  const scope = await approvalWorklistScopeForAuthz(authz);
  if (!scope || !scope.mayFlows) return 0;
  return (
    await worklistGatesAwaitingAnotherApprover(
      scope.orgId,
      authz.user.id,
      authz.user.roles.map((role) => role.key),
      authz.allowedSubsidiaryIds,
    )
  ).length;
}

async function approvalWorklistScopeForAuthz(authz: Authz) {
  const orgId = authz.user.orgId;
  const flowsOn = await isFeatureEnabled(orgId, "flows");
  if (!flowsOn) return null;
  if (!can(authz, "flows.approve")) throw forbidden("flows.approve");
  return { orgId, mayFlows: true };
}

/** Count the same approval union while retaining live feature and grant checks. */
export async function approvalWorklistCountForAuthz(authz: Authz): Promise<number> {
  const scope = await approvalWorklistScopeForAuthz(authz);
  if (!scope) return 0;
  return worklistApprovalsCount(scope.orgId, authz.user.id, {
    roles: authz.user.roles.map((role) => role.key),
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    includeFlows: scope.mayFlows,
  });
}

export interface DecideApprovalInput {
  gateId: string;
  decision: "approved" | "rejected";
  comment?: string;
  signature?: string;
  idempotencyKey: string;
}

export async function decideApproval(
  context: ApplicationContext,
  input: DecideApprovalInput,
): Promise<{ replayed: boolean; result: unknown }> {
  if (input.decision !== "approved" && input.decision !== "rejected") {
    throw invalidInput("decision must be approved or rejected");
  }
  if (input.decision === "rejected" && !input.comment?.trim()) {
    throw invalidInput("a rejection comment is required");
  }
  if (!(await isFeatureEnabled(context.authz.user.orgId, "flows"))) throw notFound("approval");
  assertApplicationPermission(context, "flows.approve");
  return decideGateSubject(context, input);
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

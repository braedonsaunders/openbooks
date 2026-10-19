import "server-only";
import {
  decideDocumentApproval,
  DocumentApprovalError,
  worklistApprovals,
  worklistApprovalsCount,
  worklistApprovalsPage,
  worklistGatesAwaitingAnotherApprover,
  type WorklistBudget,
  type WorklistDocument,
  type WorklistTimesheet,
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

export type ApprovalWorklistItem =
  | ({
      kind: "flow_gate";
      awaitingAnotherApprover?: boolean;
      /**
       * The viewer may decide this gate through the native decide path
       * (assigned directly, by role, by delegation, or as an organization
       * admin, and not barred by separation of duties). Set by the
       * organization reader, whose rows are not all the viewer's to decide;
       * the caller's own worklist carries only gates that reach them.
       */
      canDecide?: boolean;
      /** The viewer may hand this gate to another user (delegateGate's rule). */
      canDelegate?: boolean;
    } & WorklistGate)
  | ({ kind: "document" } & WorklistDocument)
  | ({ kind: "budget" } & WorklistBudget)
  | ({ kind: "timesheet"; canDecide?: boolean } & WorklistTimesheet);

/**
 * One worklist for every thing awaiting the caller's approval: pending Flows
 * gates (assigned, role-held, or delegated — payment runs included),
 * document-status approvals with no pending gate, pending budget
 * scenarios, and gateless submitted timesheet weeks. Gate rows keep their
 * exact shape; document, budget, and week rows carry a kind discriminator
 * and their own decide handle. get_vitals counts this
 * same array, so the two can never disagree.
 */
export async function listApprovalWorklist(context: ApplicationContext): Promise<ApprovalWorklistItem[]> {
  return approvalWorklistForAuthz(context.authz);
}

/**
 * The unified worklist for a bare Authz (no transport context): pending Flows
 * gates, gateless document-status approvals, pending budget scenarios, and
 * gateless submitted timesheet weeks. The read path only ever touches authz, so surfaces
 * that hold no ApplicationContext (dashboard metrics, cron summaries) share
 * this exact reader instead of re-querying one leg of the union. Callers
 * that cannot approve anything must apply the same doorway as get_vitals
 * (flows.approve or budgets.approve) and treat the
 * result as empty — the reader itself throws for a caller with no approve
 * path, mirroring the worklist.
 */
export async function approvalWorklistForAuthz(authz: Authz): Promise<ApprovalWorklistItem[]> {
  const scope = await approvalWorklistScopeForAuthz(authz);
  if (!scope) return [];
  const { orgId, mayFlows, mayBudgets, mayTimesheets } = scope;
  const items = await worklistApprovals(orgId, authz.user.id, {
    roles: authz.user.roles.map((role) => role.key),
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    includeBudgets: mayBudgets,
    includeTimesheets: mayTimesheets,
  });
  const out: ApprovalWorklistItem[] = [];
  for (const item of items) {
    if (item.kind === "flow_gate") {
      if (mayFlows) out.push({ ...item.gate, kind: "flow_gate" });
    } else if (item.kind === "document") {
      if (mayFlows) out.push({ ...item.document, kind: "document" });
    } else if (item.kind === "budget") {
      if (mayBudgets) out.push({ ...item.budget, kind: "budget" });
    } else if (item.kind === "timesheet") {
      if (mayTimesheets) out.push({ ...item.timesheet, kind: "timesheet" });
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
  const scope = await approvalWorklistScopeForAuthz(authz);
  if (!scope) return { items: [], total: 0, kindCounts: new Map() };
  const { orgId, mayFlows, mayBudgets, mayTimesheets } = scope;
  const page = await worklistApprovalsPage(
    orgId,
    authz.user.id,
    {
      roles: authz.user.roles.map((role) => role.key),
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      includeFlows: mayFlows,
      includeBudgets: mayBudgets,
      includeTimesheets: mayTimesheets,
    },
    { limit: window.limit, offset: window.offset, kind: window.kind, query: window.query, overdue: window.overdue },
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
          awaitingAnotherApprover: capability.sodBlocked,
          canDelegate: capability.canDelegate,
        });
      }
    } else if (item.kind === "document") {
      if (mayFlows) out.push({ ...item.document, kind: "document" });
    } else if (item.kind === "budget") {
      if (mayBudgets) out.push({ ...item.budget, kind: "budget" });
    } else if (item.kind === "timesheet") {
      // The leg already excludes the actor's own weeks under
      // prevent-self-approval, so every row here is actionable.
      if (mayTimesheets) out.push({ ...item.timesheet, kind: "timesheet" });
    }
  }
  return { items: out, total: page.total, kindCounts: page.kindCounts };
}

/**
 * Every pending, live approval in the organization, inside the viewer's
 * legal-entity boundary: Flows gates of every subject kind whatever their
 * assignee, gateless pending documents, pending budget scenarios and
 * gateless submitted timesheet weeks, whoever submitted them. This is the
 * oversight view behind Inbox → All approvals, so it requires flows.manage;
 * the caller's own worklist (My approvals, the dashboard tile, the badge and
 * get_vitals) stays on approvalWorklistPageForAuthz.
 *
 * Each leg follows its own feature switch and read grant: gates and gateless
 * documents ride the Flows feature, budgets ride Budgets with budgets.read or
 * budgets.approve, and weeks ride Time Tracking with time.read or
 * time.approve. Whether the viewer may decide a row is resolved per row:
 * a gate through gateDecisionCapability — the same check the decide route's
 * decideGate enforces, which admits the assignee, a role holder, an active
 * delegate and an organization admin, and refuses the submitter under
 * separation of duties — and a week by time.approve plus the week's own
 * self-approval bar. Gateless documents and budgets decide in their record
 * drawers, so their rows carry no inline decision.
 */
export async function approvalWorklistOrganizationPageForAuthz(
  authz: Authz,
  window: ApprovalWorklistWindow,
): Promise<{ items: ApprovalWorklistItem[]; total: number; kindCounts: Map<string, number> }> {
  if (!can(authz, "flows.manage")) throw forbidden("flows.manage");
  const orgId = authz.user.orgId;
  const [flowsOn, budgetsOn, timeTrackingOn] = await Promise.all([
    isFeatureEnabled(orgId, "flows"),
    isFeatureEnabled(orgId, "budgets"),
    isFeatureEnabled(orgId, "timeTracking"),
  ]);
  const includeBudgets = budgetsOn && (can(authz, "budgets.read") || can(authz, "budgets.approve"));
  const includeTimesheets = timeTrackingOn && (can(authz, "time.read") || can(authz, "time.approve"));
  const mayDecideTimesheets = timeTrackingOn && can(authz, "time.approve");
  if (!flowsOn && !includeBudgets && !includeTimesheets) return { items: [], total: 0, kindCounts: new Map() };
  const page = await worklistApprovalsPage(
    orgId,
    authz.user.id,
    {
      roles: authz.user.roles.map((role) => role.key),
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      includeFlows: flowsOn,
      includeBudgets,
      includeTimesheets,
      audience: "organization",
    },
    { limit: window.limit, offset: window.offset, kind: window.kind, query: window.query, overdue: window.overdue },
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
    } else if (item.kind === "document") {
      out.push({ ...item.document, kind: "document" });
    } else if (item.kind === "budget") {
      out.push({ ...item.budget, kind: "budget" });
    } else if (item.kind === "timesheet") {
      out.push({ ...item.timesheet, kind: "timesheet", canDecide: mayDecideTimesheets && item.timesheet.actorMayApprove });
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
  return (await worklistGatesAwaitingAnotherApprover(
    scope.orgId,
    authz.user.id,
    authz.user.roles.map((role) => role.key),
    authz.allowedSubsidiaryIds,
  )).length;
}

async function approvalWorklistScopeForAuthz(authz: Authz) {
  const orgId = authz.user.orgId;
  const [flowsOn, budgetsOn, timeTrackingOn] = await Promise.all([
    isFeatureEnabled(orgId, "flows"),
    isFeatureEnabled(orgId, "budgets"),
    isFeatureEnabled(orgId, "timeTracking"),
  ]);
  const mayFlows = flowsOn && can(authz, "flows.approve");
  const mayBudgets = budgetsOn && can(authz, "budgets.approve");
  const mayTimesheets = timeTrackingOn && can(authz, "time.approve");
  if (!mayFlows && !mayBudgets && !mayTimesheets) {
    if (!flowsOn) return null;
    throw forbidden("flows.approve");
  }
  return { orgId, mayFlows, mayBudgets, mayTimesheets };
}

/** Count the same approval union while retaining live feature and grant checks. */
export async function approvalWorklistCountForAuthz(authz: Authz): Promise<number> {
  const scope = await approvalWorklistScopeForAuthz(authz);
  if (!scope) return 0;
  return worklistApprovalsCount(scope.orgId, authz.user.id, {
    roles: authz.user.roles.map((role) => role.key),
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    includeFlows: scope.mayFlows,
    includeBudgets: scope.mayBudgets,
    includeTimesheets: scope.mayTimesheets,
  });
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

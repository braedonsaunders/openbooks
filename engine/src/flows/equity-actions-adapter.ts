import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import { EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import { tableScope } from "./subject-scope.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";

/**
 * Governed equity actions as one Flow subject.
 *
 * Approval of an equity action is optional and belongs to Flows: an
 * organization that authors an Equity action Flow with approval gates routes
 * the actions it selects (by kind, amount, holder or class) through it;
 * without one, every action applies when it is recorded. The subject is one
 * equity_action_requests row — the action, its frozen command input and the
 * figures a Flow condition reads. The Flow decides only: the equity module
 * applies the approved action through the registered release handler, on
 * the requester's authority, inside the gate decision's transaction, so its
 * validation, ledger posting and audit run exactly as for an ungated action.
 *
 * Each submitted gate freezes the tenant’s separation policy, including
 * whether the requester may decide an assigned gate.
 */
export const EQUITY_ACTION_SUBJECT_KIND = "equity_action";

export const EQUITY_ACTION_KINDS = [
  { value: "void", label: "Void a security" },
  { value: "reverse", label: "Reverse an event" },
  { value: "repurchase", label: "Repurchase shares" },
  { value: "repay", label: "Repay a SAFE or note" },
  { value: "cancel_convertible", label: "Cancel a SAFE or note" },
  { value: "class_amendment", label: "Amend a share class" },
  { value: "split", label: "Stock split" },
  { value: "reserve_change", label: "Change a plan reserve" },
  { value: "mfn_election", label: "MFN election" },
  { value: "mfn_reversal", label: "Reverse an MFN election" },
  { value: "compensation_run", label: "Stock compensation run" },
  { value: "interest_run", label: "Note interest run" },
  { value: "account_policy", label: "Equity account policy version" },
  { value: "round_amendment", label: "Amend a financing round" },
  { value: "round_void", label: "Void a financing round" },
] as const;

const STATUSES = [
  { value: "pending_approval", label: "Pending approval" },
  { value: "applied", label: "Applied" },
  { value: "rejected", label: "Rejected" },
  { value: "withdrawn", label: "Withdrawn" },
] as const;

export const equityActionSubjectProfile: FlowSubjectProfile = {
  subjectKind: EQUITY_ACTION_SUBJECT_KIND,
  pinsSubmissionPolicy: true,
  label: "Equity action",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...STATUSES],
  fields: [
    {
      key: "action",
      label: "Action",
      type: "enum",
      options: EQUITY_ACTION_KINDS.map((kind) => ({ ...kind })),
    },
    { key: "subjectLabel", label: "Record", type: "text" },
    {
      key: "securityKind",
      label: "Security kind",
      type: "enum",
      options: [
        { value: "share", label: "Share certificate" },
        { value: "option", label: "Option" },
        { value: "rsu", label: "RSU" },
        { value: "warrant", label: "Warrant" },
        { value: "safe", label: "SAFE" },
        { value: "note", label: "Convertible note" },
      ],
    },
    { key: "holderName", label: "Holder", type: "text" },
    { key: "shareClassCode", label: "Share class", type: "text" },
    { key: "quantity", label: "Shares", type: "number" },
    { key: "amount", label: "Amount", type: "number" },
    { key: "currency", label: "Currency", type: "text" },
    { key: "effectiveOn", label: "Effective date", type: "date" },
    { key: "reason", label: "Reason", type: "text" },
    { key: "legalEntity", label: "Legal entity", type: "text" },
    { key: "status", label: "Status", type: "enum" },
    { key: "requestedBy", label: "Requested by", type: "user" },
    {
      key: "event_source",
      label: "Event source",
      type: "enum",
      options: [...EVENT_SOURCE_OPTIONS],
    },
  ],
};

type RequestRow = {
  org_id: string;
  subsidiary_id: string;
  action: string;
  subject_id: string | null;
  subject_label: string;
  effective_on: string;
  reason: string | null;
  summary: Record<string, unknown>;
  status: string;
  requested_by: string;
  legal_entity: string | null;
};

async function loadRequest(subjectId: string): Promise<RequestRow | null> {
  if (!isUuid(subjectId)) return null;
  // Adapter parity (documents, leave requests): the gate row scopes every
  // caller to its organization; findCandidateIds keeps the explicit boundary.
  return (
    (
      await db.execute<RequestRow>(
        sql`
    select r.org_id, r.subsidiary_id, r.action, r.subject_id, r.subject_label, r.effective_on::text as effective_on,
           r.reason, r.summary, r.status, r.requested_by, s.name as legal_entity
      from equity_action_requests r
      left join subsidiaries s on s.org_id = r.org_id and s.id = r.subsidiary_id
     where r.id = ${subjectId}`,
        "objects",
      )
    )[0] ?? null
  );
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const number = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value)) return null;
  return Number(value);
};

/**
 * Where the action lands in the equity workspace: the view of the record it
 * concerns, on the reader's own date. The action's effective date is not
 * pinned as a custom as-of: the pending action is listed on its view
 * whatever date the view reads, with its effective date beside it.
 */
function deepLinkFor(request: Pick<RequestRow, "action" | "subject_id" | "subsidiary_id">): string {
  const base = `/equity?sub=${request.subsidiary_id}`;
  switch (request.action) {
    case "void":
    case "reverse":
    case "repurchase":
    case "repay":
    case "cancel_convertible":
    case "mfn_election":
    case "mfn_reversal":
      return `${base}&view=securities&security=${request.subject_id}`;
    case "round_amendment":
    case "round_void":
      return `${base}&view=rounds&round=${request.subject_id}`;
    case "reserve_change":
      return `${base}&view=plans`;
    case "class_amendment":
    case "split":
      return `${base}&view=classes`;
    case "compensation_run":
      return `${base}&view=compensation`;
    case "interest_run":
      return `${base}&view=compensation&run=interest`;
    case "account_policy":
      return "/admin/setup/equity-account-policies";
    default:
      return base;
  }
}

export const equityActionsFlowAdapter: FlowSubjectAdapter = defineTableSubjectAdapter({
  subjectKind: EQUITY_ACTION_SUBJECT_KIND,
  // Recording an action is equity.manage; deciding one is the equity.approve grant.
  permissions: {
    read: "equity.read",
    edit: "equity.manage",
    approve: "equity.approve",
  },
  scope: tableScope("column", "equity_action_requests", "subsidiary_id"),
  profile: equityActionSubjectProfile,
  releaseViaHandler: true,

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const request = await loadRequest(subjectId);
    if (!request) return null;
    const summary = request.summary ?? {};
    return {
      values: {
        id: subjectId,
        action: request.action,
        subjectLabel: request.subject_label,
        securityKind: text(summary.securityKind),
        holderName: text(summary.holderName),
        shareClassCode: text(summary.shareClassCode),
        quantity: number(summary.quantity),
        amount: number(summary.amount),
        currency: text(summary.currency),
        effectiveOn: request.effective_on,
        reason: request.reason,
        legalEntity: request.legal_entity,
        status: request.status,
        requestedBy: request.requested_by,
      },
      submitterUserId: request.requested_by,
      makerUserId: request.requested_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const action =
      EQUITY_ACTION_KINDS.find((kind) => kind.value === values.action)?.label ?? "Equity action";
    return `${action} · ${String(values.subjectLabel ?? subjectId)}`;
  },

  deepLink(subjectId: string): string {
    return `/equity?request=${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadRequest(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error("equity action status is released by the approval engine, not a flow action");
  },

  async releaseApproval(
    subjectId: string,
    outcome: "approved" | "rejected",
    ctx: FlowExecCtx,
    detail?: { comment?: string | null },
    run?: { id: string; dispatchValues: Record<string, unknown> | null },
  ): Promise<void> {
    await releaseFlowApproval({
      subjectKind: EQUITY_ACTION_SUBJECT_KIND,
      subjectId,
      outcome,
      comment: detail?.comment,
      ctx,
      approvalRunId: run?.id,
    });
  },

  async setField(): Promise<void> {
    throw new Error("equity action requests are frozen when recorded; record a new action instead");
  },

  /** Requests awaiting a decision, for scheduled fan-out (reminders). */
  async findCandidateIds(limit: number): Promise<string[]> {
    const orgId = ambientTenantOrgId();
    if (!orgId)
      throw new Error(
        `findCandidateIds for "${EQUITY_ACTION_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`,
      );
    const rows = await db.execute<{ id: string }>(
      sql`
      select id::text as id from equity_action_requests
       where org_id = ${orgId} and status = 'pending_approval'
       order by created_at desc limit ${limit}`,
      "objects",
    );
    return rows.map((row) => row.id);
  },
});

export { deepLinkFor as equityActionDeepLink };

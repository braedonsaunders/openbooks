import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import { resolveSodBlockedIds } from "./sod-identities.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { hasFlowDecisionAuthority } from "./decision-authority.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { planFromGate, type GateData } from "@openbooks/forms-core";
import {
  db,
  pool,
  schema,
  withOrg,
  withBypassContext,
  withOrgContext,
  withTransactionSavepoint,
} from "../platform/db.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { getFlowAdapter, listFlowSubjectProfiles } from "./registry.ts";
import { DOCUMENT_FLOW_KINDS } from "./subject-profiles.ts";
import { resolveSubjectSubsidiaries, subjectSubsidiarySql } from "./subject-scope.ts";
import { CLOSE_RUN_SUBJECT_KIND } from "./close-runs-adapter.ts";
import { canonicalPeriodLabelSql } from "../periods/period-policy.ts";
import {
  MANUFACTURING_BOM_APPROVAL_OPERATION,
  MANUFACTURING_LOSS_DISPOSITION_OPERATION,
  MANUFACTURING_ROUTING_APPROVAL_OPERATION,
  MANUFACTURING_SCRAP_RESTATEMENT_OPERATION,
  MANUFACTURING_STANDARD_ROLLUP_OPERATION,
} from "../platform/financial-changes.ts";
import { executeFlowPlan } from "./execute.ts";
import { enqueueApprovalEscalation, enqueueFlowEmail } from "../delivery/outbox-enqueue.ts";
import { parseFlowGraph } from "./run.ts";
import { resolveQuorumOutcome, type SiblingGate } from "./quorum.ts";
import {
  resolveAssigneeUsers,
  roleUsers,
  userRoleKeys,
  verifyUser,
  type ResolvedUser,
} from "./targets.ts";
import { activeDelegationPrincipal, activeDelegationPrincipals } from "./delegations.ts";
import { emailActionUrls } from "./email-tokens.ts";
import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { resolveApprovalRequestNotices } from "./approval-notices.ts";
import { sanitizeDecisionCause } from "./decision-cause.ts";

export { sodBlockedIds } from "./sod.ts";

/**
 * Gate lifecycle — decide / worklist / delegate / timers. OpenBooks resumes
 * in process: the decide is an atomic conditional UPDATE (pending → decided,
 * so two concurrent approvals can never both resume the branch), quorum
 * evaluation (quorum.ts) picks the branch, and planFromGate → executeFlowPlan
 * re-runs on the SAME runId — flow_run_effects checkpoints keep earlier nodes
 * from double-firing.
 *
 * Reminders hold a per-gate session lock through notification and stamp
 * flow_gates.reminded_at only after the idempotent notification effect. A
 * crashed process releases the lock and leaves the reminder due. Escalations
 * enqueue a durable scheduler_outbox row (claim / fail with reason / backoff)
 * so a crash cannot drop the hop.
 */

type GateRow = typeof schema.flowGates.$inferSelect;

/** A caller's legal-entity visibility. Null/undefined means unrestricted. */
export type GateSubsidiaryScope = ReadonlySet<string> | null | undefined;

/**
 * In-memory twin of the API's subsidiary direct-record guard. A restricted
 * caller must name the subject's subsidiary explicitly; an absent subsidiary
 * fails closed because it cannot be proven to belong to the caller's scope.
 */
export function gateSubsidiaryScopeAllows(
  allowedSubsidiaryIds: GateSubsidiaryScope,
  subsidiaryId: string | null | undefined,
): boolean {
  if (allowedSubsidiaryIds == null) return true;
  return (
    subsidiaryId !== null &&
    subsidiaryId !== undefined &&
    subsidiaryId !== "" &&
    allowedSubsidiaryIds.has(subsidiaryId)
  );
}

export class GateError extends Error {
  /** Machine-readable refusal code; absent on legacy message-only throws. */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    if (code !== undefined) this.code = code;
  }
}

/**
 * The unified atomic decision failure: ANY failure after the gate flip —
 * resume setup (flow/adapter/graph/subject), branch execution, or release —
 * rolls the whole decide unit back to its savepoint and records NOTHING. The
 * gate stays pending and the same decision can be retried. Retry-the-RUN is
 * never the remedy here: the gate checkpoint is already stamped, so a
 * re-drive would skip the branch and complete vacuously (original-trigger
 * retryFlowRun plans from the trigger and stops at the gate). The savepoint
 * (not the throw alone) is the guarantee: an outer caller may catch this and
 * still commit without preserving anything from the attempt. The message
 * carries the stage, the cause, and the remedy for every caller.
 */
/**
 * What failed underneath a decision: a typed domain refusal from the
 * release adapter (the approver's missing person link, an unmet business
 * rule) versus the infrastructure giving way (a dropped connection, a
 * statement timeout, a serialization failure). Set where the failure is
 * constructed from the cause's CLASS — never by regexing its message —
 * so the route answers a data condition and an outage differently.
 */
export type DecisionFailureCause = "domain" | "infrastructure";

/**
 * True when the error is the infrastructure giving way: a Postgres error
 * with a connection (08), insufficient-resources (53), or operator-
 * intervention (57) SQLSTATE, a serialization failure (40001) or deadlock
 * (40P01), or a connection error with no SQLSTATE at all. Walks the
 * driver-error cause chain (Drizzle wraps the pg error) exactly like the
 * refusal helpers elsewhere: an infrastructure match on ANY level decides,
 * and a typed domain refusal (HrmChangeRequestError REFUSED and its kin)
 * never matches, so it stays a data condition.
 */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EPIPE",
  "ECONNRESET",
  "ETIMEDOUT",
]);
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01"]);

export function causeKindOf(error: unknown): DecisionFailureCause {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      (code.startsWith("08") ||
        code.startsWith("53") ||
        code.startsWith("57") ||
        TRANSIENT_SQLSTATES.has(code) ||
        CONNECTION_ERROR_CODES.has(code))
    ) {
      return "infrastructure";
    }
    current = (current as { cause?: unknown }).cause ?? null;
  }
  return "domain";
}

export class DecisionFailedError extends GateError {
  /** False when the cause is a defect (a TypeError and its kin): retrying replays it. */
  readonly retryable: boolean;
  /** Domain refusal vs infrastructure outage, set where constructed. */
  readonly causeKind: DecisionFailureCause;
  override readonly cause?: unknown;
  constructor(args: {
    decision: "approved" | "rejected";
    stage: string;
    cause: string;
    retryable?: boolean;
    causeKind?: DecisionFailureCause;
    originalCause?: unknown;
  }) {
    const retryable = args.retryable ?? true;
    super(
      `approval ${args.stage} failed: ${args.cause}. ` +
        `The decision to ${args.decision === "approved" ? "approve" : "reject"} was not recorded ` +
        `and the approval is still pending — ` +
        (retryable
          ? `retry your decision.`
          : `this is a defect in the ${args.stage} path, not a data condition: retrying will fail the ` +
            `same way. Report the message above; the approval stays pending until the defect is fixed.`),
    );
    this.name = "DecisionFailedError";
    this.retryable = retryable;
    this.causeKind = args.causeKind ?? "domain";
    this.cause = args.originalCause;
  }
}

/**
 * A thrown value that can only come from broken code, never from data: a
 * remedy that says "retry" for these invites an infinite loop on an
 * approval. Everything else (adapter refusals, storage errors) stays
 * retryable because the next attempt may genuinely succeed.
 */
export function isProgrammingError(e: unknown): boolean {
  return (
    e instanceof TypeError ||
    e instanceof ReferenceError ||
    e instanceof RangeError ||
    e instanceof SyntaxError
  );
}

/**
 * A release failure — the adapter threw while releasing the subject. Kept as
 * a named subclass so callers can distinguish the stage; the contract is the
 * unified one above (nothing recorded, retry the decision).
 */
export class ReleaseError extends DecisionFailedError {
  constructor(
    decision: "approved" | "rejected",
    cause: string,
    retryable = true,
    causeKind: DecisionFailureCause = "domain",
    originalCause?: unknown,
  ) {
    super({ decision, stage: "release", cause, retryable, causeKind, originalCause });
    this.name = "ReleaseError";
  }
}

/** Administrators may repair assignments and receive unresolved-routing notices. */
const GATE_ADMIN_ROLE = "admin";

function liveApprovalRunSql(orgId: SQL, runId: SQL, kind: SQL, subjectId: SQL): SQL {
  return sql`exists(select 1 from flow_runs r where r.org_id=${orgId} and r.id=${runId}
  and r.subject_kind=${kind} and r.subject_id=${subjectId} and r.status in('waiting','running') and r.error is null
  and r.context->'submissionPolicy'->>'flowId'=r.flow_id::text
  and (r.trigger<>'on_submit' or exists(select 1 from flow_submissions receipt where receipt.org_id=r.org_id
    and receipt.subject_kind=r.subject_kind and receipt.subject_id=r.subject_id and receipt.policy->'runIds' ? r.id::text
    and not exists(select 1 from flow_submissions newer where newer.org_id=receipt.org_id and newer.subject_kind=receipt.subject_kind
      and newer.subject_id=receipt.subject_id and (newer.created_at,newer.id)>(receipt.created_at,receipt.id)))))`;
}

async function loadGate(gateId: string, orgId?: string): Promise<GateRow | null> {
  const [gate] = await db
    .select()
    .from(schema.flowGates)
    .where(
      and(eq(schema.flowGates.id, gateId), orgId ? eq(schema.flowGates.orgId, orgId) : undefined),
    );
  return gate ?? null;
}
async function hasLiveApprovalRun(gate: GateRow): Promise<boolean> {
  return (
    (
      await db.execute<{ live: boolean }>(
        sql`select ${liveApprovalRunSql(sql`${gate.orgId}::uuid`, sql`${gate.runId}::uuid`, sql`${gate.subjectKind}`, sql`${gate.subjectId}::uuid`)} as live`,
        "objects",
      )
    )[0]?.live === true
  );
}

/**
 * Dispatch-time subject snapshot pinned on the run row
 * (flow_runs.context holds the adapter's values object from dispatch).
 * Release paths that spend dispatch-time vetting bind to this; a missing
 * row or snapshot returns null so the adapter refuses instead of
 * releasing blind.
 */
async function loadRunDispatchValues(
  orgId: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const [run] = await db
    .select({ context: schema.flowRuns.context })
    .from(schema.flowRuns)
    .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, orgId)));
  const context = run?.context as Record<string, unknown> | null | undefined;
  return context && typeof context === "object" ? context : null;
}

function hasGateDecisionAuthority(gate: GateRow, userId: string): Promise<boolean> {
  return hasFlowDecisionAuthority({
    orgId: gate.orgId,
    subjectKind: gate.subjectKind,
    subjectId: gate.subjectId,
    userId,
  });
}

async function canActOnGate(gate: GateRow, userId: string): Promise<boolean> {
  if (!(await hasLiveApprovalRun(gate))) return false;
  return canActOnLiveGate(gate, userId, () => hasGateDecisionAuthority(gate, userId));
}

/** Decision authority plus direct or role assignment, on a gate already known to be live. */
async function canActOnLiveGate(
  gate: GateRow,
  userId: string,
  authority: () => Promise<boolean>,
): Promise<boolean> {
  if (!(await authority())) return false;
  if (gate.assigneeUserId === userId) return true;
  const roles = await userRoleKeys(gate.orgId, userId);
  return !!gate.assigneeRole && roles.has(gate.assigneeRole);
}

/**
 * Refuse a restricted caller acting on a gate whose subject lies outside
 * their legal entities. The subject's entity resolves through its adapter's
 * declared scope; a subject with no provable entity fails closed.
 */
async function assertGateSubsidiaryScope(
  gate: Pick<GateRow, "subjectKind" | "subjectId" | "orgId">,
  allowedSubsidiaryIds: GateSubsidiaryScope,
): Promise<void> {
  if (allowedSubsidiaryIds == null) return;
  const adapter = getFlowAdapter(gate.subjectKind);
  if (!adapter)
    throw new GateError(`approval subject kind "${gate.subjectKind}" is not registered`);
  const owners = await resolveSubjectSubsidiaries(
    gate.orgId,
    gate.subjectKind,
    adapter.scope,
    [gate.subjectId],
    allowedSubsidiaryIds,
  );
  if (!gateSubsidiaryScopeAllows(allowedSubsidiaryIds, owners.get(gate.subjectId))) {
    throw new GateError("approval not found");
  }
}

/**
 * Separation-of-duties identities for a subject: the submitter AND the maker
 * (author). A third-party submit rebinds submitted_by but never unbinds
 * authorship — excluding only the submitter lets the maker approve their own
 * record. Adapters that do not separate the two leave makerUserId unset and
 * behave exactly as before.
 */
async function gateDecisionSodBlocked(
  gate: GateRow,
  adapter: FlowSubjectAdapter | null | undefined,
  subject: FlowSubjectContext | null | undefined,
  identities: readonly (string | null | undefined)[],
): Promise<boolean> {
  const author = (
    await db.execute<{ created_by: string | null }>(
      sql`select created_by from flow_runs where org_id=${gate.orgId} and id=${gate.runId}`,
      "objects",
    )
  )[0]?.created_by;
  const blocked = await resolveSodBlockedIds(gate.orgId, subject ?? null, author ? [author] : []);
  if (!identities.some((id) => id !== null && id !== undefined && blocked.has(id))) return false;
  const node = await gateNodeData(gate.orgId, gate.flowId, gate.nodeId, gate.runId);
  return !node || node.preventSelfApproval !== false;
}

/**
 * Viewer-aware decision capability for contextual record drawers — and for
 * every surface that must resolve the separation-of-duties outcome BEFORE
 * offering an Approve action. `sodBlocked` names the SoD denial
 * specifically (the viewer is assigned but the gate's prevent-self-approval
 * excludes them as submitter/maker): surfaces render those rows as
 * "awaiting another approver" with no decision actions, instead of offering
 * Approve and refusing on click. Any other denial (not assigned, not
 * pending) leaves `sodBlocked` false. `canDelegate` is delegateGate's own
 * rule — the gate's direct assignee or an organization admin — so a surface
 * offers Delegate exactly where the hand-off will be accepted.
 */
export async function gateDecisionCapability(
  gateId: string,
  userId: string,
): Promise<{
  canAct: boolean;
  signatureRequired: boolean;
  sodBlocked: boolean;
  canDelegate: boolean;
}> {
  const gate = await loadGate(gateId);
  if (!gate || gate.status !== "pending" || !(await hasLiveApprovalRun(gate))) {
    return { canAct: false, signatureRequired: false, sodBlocked: false, canDelegate: false };
  }
  // One capability read resolves the viewer's decision authority over this
  // live gate once, however many of the checks below consult it. Deciding
  // re-resolves liveness and authority from scratch (decideGate).
  let authorityRead: Promise<boolean> | undefined;
  const authority = () => (authorityRead ??= hasGateDecisionAuthority(gate, userId));
  const canDelegate =
    gate.assigneeUserId === userId
      ? await authority()
      : !!(await verifyUser(gate.orgId, userId)) &&
        (await actorHasPermission(db, gate.orgId, userId, "flows.manage"));
  let authorized = await canActOnLiveGate(gate, userId, authority);
  let onBehalfOf: ResolvedUser | null = null;
  if (!authorized && gate.assigneeUserId) {
    onBehalfOf = await activeDelegationPrincipal(gate.orgId, gate.assigneeUserId, userId);
    authorized = onBehalfOf !== null && (await authority());
  }
  if (!authorized) {
    return {
      canAct: false,
      signatureRequired: gate.signatureRequired,
      sodBlocked: false,
      canDelegate,
    };
  }
  const adapter = getFlowAdapter(gate.subjectKind);
  const subject = await adapter?.loadContext(gate.subjectId);
  if (
    await gateDecisionSodBlocked(gate, adapter, subject, [
      userId,
      onBehalfOf?.id,
      gate.delegatedFromUserId,
    ])
  ) {
    return {
      canAct: false,
      signatureRequired: gate.signatureRequired,
      sodBlocked: true,
      canDelegate,
    };
  }
  return {
    canAct: true,
    signatureRequired: gate.signatureRequired,
    sodBlocked: false,
    canDelegate,
  };
}

/** The gate node's authored GateData, for escalation targets. */
async function gateNodeData(
  orgId: string,
  flowId: string,
  nodeId: string,
  runId: string,
): Promise<GateData | null> {
  const [flow] = await db
    .select()
    .from(schema.flows)
    .where(and(eq(schema.flows.id, flowId), eq(schema.flows.orgId, orgId)));
  if (!flow) return null;
  const dispatch = await loadRunDispatchValues(orgId, runId);
  const policy = dispatch?.submissionPolicy as { graph?: unknown; flowId?: unknown } | undefined;
  if (!policy?.graph || policy.flowId !== flow.id)
    throw new GateError(
      "This submission has no frozen Flow policy. Withdraw it and submit the current record again.",
    );
  const graph = parseFlowGraph(flow.id, policy.graph);
  if (!graph)
    throw new GateError(
      "The submitted Flow policy is invalid. Withdraw this submission and correct the Flow before retrying.",
    );
  const node = graph.nodes.find((n) => n.id === nodeId);
  return node?.data.kind === "gate" ? node.data.gate : null;
}

/** Recompute a run's status once gates move: waiting | completed | failed. */
async function finalizeRunStatus(
  runId: string,
  orgId: string,
  hadFailure: boolean,
  error?: string | null,
): Promise<void> {
  const pending = await db.execute<{ n: number }>(
    sql`
    select count(*)::int as n from flow_gates where run_id = ${runId} and org_id = ${orgId} and status in ('pending', 'escalated')
  `,
    "objects",
  );
  const stillWaiting = (pending[0]?.n ?? 0) > 0;
  const status = hadFailure ? "failed" : stillWaiting ? "waiting" : "completed";
  await db
    .update(schema.flowRuns)
    .set({
      status,
      error: hadFailure ? (error ?? "gate branch failed") : null,
      finishedAt: status === "waiting" ? null : new Date(),
    })
    .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, orgId)));
}

/**
 * A recorded decision whose branch completed: the gate flipped, the branch
 * (if any) ran, and the engine release landed. There is no recorded-failure
 * variant — ANY failure after the flip rolls the whole decide unit back to
 * its savepoint and throws DecisionFailedError (nothing recorded, gate still
 * pending, retry the decision).
 */
export interface DecideGateResult {
  ok: true;
  /** Which branch resumed; null = quorum 'all' still waiting on siblings. */
  resumed: "approve" | "reject" | null;
  runStatus: "waiting" | "completed";
}

/**
 * Approve/reject one gate row. Authorization: the row's assignee, a holder of
 * the row's assigneeRole, an org admin, or an ACTIVE out-of-office delegate
 * of the row's direct assignee (approval_delegations — the principal's gate
 * assignment is the grant being borrowed; a delegation never extends to
 * role-assigned gates the principal merely could have claimed, so it can't
 * raise authority). Quorum satisfied → resume the branch on the same run.
 *
 * On-behalf-of audit: a delegated decision records decidedBy = the DELEGATE
 * with the principal in the structured on_behalf_of_user_id column (and a
 * delegated hand-off keeps its origin in delegated_from_user_id) — the
 * decision comment carries only the decider's own words, never a forged
 * provenance marker.
 */
export async function decideGate(args: {
  gateId: string;
  decision: "approved" | "rejected";
  userId: string;
  /** Subsidiaries visible to this caller; restricted sets are fail-closed. */
  allowedSubsidiaryIds?: GateSubsidiaryScope;
  comment?: string | null;
  /** Typed attestation — required to approve a signature-required gate. */
  signature?: string | null;
}): Promise<DecideGateResult> {
  const gate = await loadGate(args.gateId);
  if (!gate) throw new GateError("approval not found");
  return withOrg(gate.orgId, () => decideGateCore(args));
}

/** Decide only as an authorized actor assigned by the frozen tenant Flow. */
async function decideGateCore(args: Parameters<typeof decideGate>[0]): Promise<DecideGateResult> {
  const { gateId, decision, userId } = args;
  const signature = args.signature?.trim() || null;

  // -- Pre-flight (existence, authorization, separation of duties) -----------
  const pre = await loadGate(gateId);
  if (!pre) throw new GateError("approval not found");
  if (pre.status !== "pending") throw new GateError("this approval was already resolved");

  // Re-check the legal-entity boundary at the engine write authority. The
  // route performs an early 404 for UX/anti-enumeration, but this second check
  // closes races and protects every caller that carries an Authz scope.
  await assertGateSubsidiaryScope(pre, args.allowedSubsidiaryIds);

  // E-signature: a signature-required gate cannot be APPROVED without a typed
  // attestation. Enforced here (not just in the UI) so it holds for the bulk,
  // one-click email, and API paths alike. Rejection needs only a reason.
  if (pre.signatureRequired && decision === "approved" && !signature) {
    throw new GateError("this approval requires your signature");
  }

  let onBehalfOf: ResolvedUser | null = null;
  {
    if (!(await canActOnGate(pre, userId))) {
      onBehalfOf = pre.assigneeUserId
        ? await activeDelegationPrincipal(pre.orgId, pre.assigneeUserId, userId)
        : null;
      if (!onBehalfOf) throw new GateError("you are not an approver for this gate");
    }
  }

  // Separation of duties, enforced at DECISION time (not just gate creation):
  // the record's submitter AND its maker may never decide their own approval —
  // closing the admin / later-role-grant / delegated-actor bypasses, plus the
  // third-party-submit bypass (submitting rebinds submitted_by but never
  // unbinds authorship). Secure by default; only an explicit
  // preventSelfApproval:false on the gate node opts out. Submitting someone
  // else's draft stays legal — only the decision is refused, so legitimate
  // teamwork (maker, submitter, and an independent approver) keeps working.
  const preAdapter = getFlowAdapter(pre.subjectKind);
  const preSubject = await preAdapter?.loadContext(pre.subjectId);
  if (
    await gateDecisionSodBlocked(pre, preAdapter, preSubject, [
      userId,
      onBehalfOf?.id,
      pre.delegatedFromUserId,
    ])
  ) {
    // A timesheet's enterer reads a timesheet-worded refusal; every other
    // subject keeps the established generic text its tests assert.
    const message =
      pre.subjectKind === "timesheet_week"
        ? "You entered this timesheet; another approver must approve it."
        : "you cannot approve your own submission — you created or submitted this record. " +
          "Route it to another approver to decide.";
    throw new GateError(message, "self_approval_forbidden");
  }

  // -- Serialized decision: a subject lock coordinates every governing policy,
  // then a run lock holds through flip → quorum → cancel → resume → release.
  // Concurrent deciders can
  // never both resume (double-post) and the whole decision is atomic (a crash
  // rolls back to a still-pending gate, safely re-decidable). ----------------
  return withOrg(pre.orgId, async () => {
    await lockApprovalSubject(pre.orgId, pre.subjectKind, pre.subjectId);
    await preAdapter?.lockDecisionResources?.(pre.orgId, pre.subjectId);
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${pre.runId}))`);

    // Whole-decision savepoint: withOrg joins an ambient transaction when the
    // caller already owns one (and db.transaction likewise participates), so a
    // throw alone cannot guarantee rollback — an outer caller may catch
    // ReleaseError and still commit. Rolling back to this savepoint first
    // removes the attempt's writes (flip, audit, notifications, branch
    // effects, run status) before the error propagates, whatever the outer
    // scope then does. This is the exact swallowed-error topology this slice
    // handles: catch inside an outer withOrgTransaction + outer commit still
    // leaves the gate pending with nothing recorded.
    return withTransactionSavepoint(db, async () => {
      const gate = await loadGate(gateId, pre.orgId);
      if (!gate || gate.status !== "pending") {
        throw new GateError("this approval was already resolved");
      }
      if (!(await hasLiveApprovalRun(gate)))
        throw new GateError(
          "This submission is no longer active. Recall it and submit the current record through Flows.",
        );
      {
        const currentAdapter = getFlowAdapter(gate.subjectKind);
        const permission = currentAdapter?.decisionPermission
          ? await currentAdapter.decisionPermission(gate.subjectId, userId)
          : currentAdapter?.permissions?.approve;
        if (!currentAdapter || !permission)
          throw new GateError("This subject has no native approval authority contract.");
        const currentScope = await lockActorCommandAuthority(
          db,
          gate.orgId,
          userId,
          null,
          permission,
        );
        await assertGateSubsidiaryScope(gate, currentScope);
        const delegated = gate.assigneeUserId
          ? await activeDelegationPrincipal(gate.orgId, gate.assigneeUserId, userId)
          : null;
        if (!(await canActOnGate(gate, userId)) && !delegated)
          throw new GateError("You are no longer assigned to this gate.");
        const currentSubject = await currentAdapter.loadContext(gate.subjectId);
        if (
          await gateDecisionSodBlocked(gate, currentAdapter, currentSubject, [
            userId,
            delegated?.id,
            gate.delegatedFromUserId,
          ])
        )
          throw new GateError(
            "The submitted tenant Flow does not permit this self-approval.",
            "self_approval_forbidden",
          );
      }
      // The subject may have been edited after the pre-flight read. Re-resolve
      // its legal entity while holding the same transaction that flips the gate.
      await assertGateSubsidiaryScope(gate, args.allowedSubsidiaryIds);

      const comment = args.comment?.trim() || null;
      const decided = await db
        .update(schema.flowGates)
        .set({
          status: decision,
          decidedBy: userId,
          decidedAt: new Date(),
          comment,
          // Attestation stored with the decision (only meaningful on approve).
          signature: decision === "approved" ? signature : null,
          // Structured provenance: whose gate this was, when a delegate decided it.
          onBehalfOfUserId: onBehalfOf?.id ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.flowGates.id, gateId),
            eq(schema.flowGates.orgId, pre.orgId),
            eq(schema.flowGates.status, "pending"),
          ),
        )
        .returning({ id: schema.flowGates.id });
      if (decided.length === 0) throw new GateError("this approval was already resolved");

      // Quorum over the sibling rows of this gate node instance.
      const siblings = (await db
        .select({
          id: schema.flowGates.id,
          status: schema.flowGates.status,
          escalatedFromGateId: schema.flowGates.escalatedFromGateId,
        })
        .from(schema.flowGates)
        .where(
          and(
            eq(schema.flowGates.runId, gate.runId),
            eq(schema.flowGates.orgId, gate.orgId),
            eq(schema.flowGates.groupKey, gate.groupKey),
          ),
        )) as SiblingGate[];
      const outcome = resolveQuorumOutcome(gate.quorum, decision, siblings);

      if (outcome.cancelIds.length > 0) {
        await db
          .update(schema.flowGates)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(
            and(
              inArray(schema.flowGates.id, outcome.cancelIds),
              eq(schema.flowGates.orgId, gate.orgId),
              inArray(schema.flowGates.status, ["pending", "escalated"]),
            ),
          );
      }

      // Durable decision evidence, part of the same atomic unit: the flip above
      // releases or returns a financial document, so who decided it, from what
      // state, with what rationale (and on whose behalf for delegates) must
      // commit with the flip — an audit failure rolls the decision back, and a
      // later resume failure rolls the evidence back with it.
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.orgId}, 'flow_gates', ${gateId}, 'update', ${JSON.stringify({
          event: decision,
          actor: { kind: "user", userId },
          ...(onBehalfOf ? { onBehalfOfUserId: onBehalfOf.id } : {}),
          before: { status: "pending" },
          after: {
            status: decision,
            comment,
            signatureProvided: decision === "approved" ? signature !== null : false,
          },
          ...(comment ? { reason: comment } : {}),
          runId: gate.runId,
          flowId: gate.flowId,
          subjectKind: gate.subjectKind,
          subjectId: gate.subjectId,
          cancelledGateIds: outcome.cancelIds,
        })}::jsonb, ${userId})
      `);
      // The decider's request (and any sibling a quorum just cancelled) is no
      // longer waiting on them: their "Approval requested" notices resolve in
      // the same unit as the decision.
      await resolveApprovalRequestNotices(gate.orgId, gate.subjectKind, gate.subjectId);

      if (!outcome.resume) {
        // 'all' quorum still collecting approvals — the run keeps waiting.
        return { ok: true, resumed: null, runStatus: "waiting" };
      }

      // --- Resume the decided branch on the SAME run -------------------------
      const [flow] = await db
        .select()
        .from(schema.flows)
        .where(and(eq(schema.flows.id, gate.flowId), eq(schema.flows.orgId, gate.orgId)));
      const adapter = getFlowAdapter(gate.subjectKind);
      if (!flow || !adapter) {
        throw new DecisionFailedError({
          decision,
          stage: "resume",
          cause: "flow definition or subject adapter is unavailable",
        });
      }
      const dispatchValues = await loadRunDispatchValues(gate.orgId, gate.runId);
      const policy = dispatchValues?.submissionPolicy as
        { graph?: unknown; flowId?: unknown } | undefined;
      if (!policy?.graph || policy.flowId !== flow.id)
        throw new DecisionFailedError({
          decision,
          stage: "resume",
          cause:
            "The submission has no valid frozen Flow policy. Withdraw it and submit the current record again.",
        });
      const graph = parseFlowGraph(flow.id, policy.graph);
      if (!graph) {
        throw new DecisionFailedError({
          decision,
          stage: "resume",
          cause: "flow graph failed validation",
        });
      }

      const ctx: FlowExecCtx = {
        orgId: gate.orgId,
        userId,
        allowedSubsidiaryIds: args.allowedSubsidiaryIds ?? null,
      };
      const subject = await adapter.loadContext(gate.subjectId);

      // The quorum is resolved — tell the requester what happened to their record
      // (best-effort: a notification hiccup must never fail the decision).
      try {
        await notifySubmitterOfDecision({
          gate,
          adapter,
          subject,
          branch: outcome.resume,
          deciderUserId: userId,
          reason: args.comment?.trim() || null,
        });
      } catch (e) {
        console.error(`[flows] gate ${gateId} submitter notification failed:`, e);
      }

      // Release a fully-approved aggregate before executing its approve branch.
      // A continuation that reaches another gate remains awaiting approval.
      // This makes a terminal authored post_document action consume an APPROVED record;
      // the action can never use its flow context to bypass lifecycle controls.
      //
      // A release throw rolls back to the whole-decision savepoint above: the
      // gate flip, audit evidence, notifications, and any partial adapter
      // writes are removed before the error propagates (a write-before-throw
      // adapter leaves nothing committed — even when an outer caller catches
      // and commits), the gate stays pending, and the caller gets a
      // ReleaseError stating the decision was NOT recorded. Retrying the
      // failed RUN would be wrong here — its gate checkpoint is already
      // stamped, so a re-drive would skip release and complete vacuously —
      // the truthful remedy is retrying the DECISION.
      const continuationContext = subject
        ? {
            values: {
              ...subject.values,
              ...(dispatchValues?.command
                ? {
                    command: dispatchValues.command,
                    commandAction: dispatchValues.commandAction ?? null,
                  }
                : {}),
            },
            rows: subject.rows ?? {},
          }
        : null;
      const continuationPlan = continuationContext
        ? planFromGate(graph, gate.nodeId, outcome.resume, continuationContext)
        : null;
      const release = adapter.releaseApproval;
      // Dispatch-time subject snapshot for engine-enforced release: adapters
      // whose release spends dispatch-time vetting bind to this run's pinned
      // values, so a subject rehomed after dispatch cannot release under a
      // stale gate. Loaded once for every release below.
      const releaseRun = {
        id: gate.runId,
        dispatchValues,
      };
      // A terminal branch may post the approved record. Park it while another
      // governing Flow still has decisions open, retaining its exact facts.
      if (
        subject &&
        release &&
        outcome.resume === "approve" &&
        continuationPlan?.gates.length === 0 &&
        continuationPlan.actionNodes.length > 0 &&
        (await subjectOpenGateCount(gate.orgId, gate.subjectKind, gate.subjectId)) > 0
      ) {
        const pending = await db.execute(
          sql`update flow_runs set context=jsonb_set(context,'{approvalContinuation}',
          ${JSON.stringify({ version: 1, gateId: gate.id, nodeId: gate.nodeId, actorId: userId, comment: args.comment?.trim() || null, evalCtx: continuationContext })}::jsonb),
          status='waiting',finished_at=null,error=null where org_id=${gate.orgId} and id=${gate.runId} returning id`,
          "objects",
        );
        if (pending.length !== 1)
          throw new DecisionFailedError({
            decision,
            stage: "resume",
            cause: "The pending approval branch was not retained.",
          });
        return { ok: true, resumed: "approve", runStatus: "waiting" };
      }
      let releasedBeforeActions = false;
      if (
        subject &&
        outcome.resume === "approve" &&
        release &&
        continuationPlan?.gates.length === 0 &&
        (await subjectOpenGateCount(gate.orgId, gate.subjectKind, gate.subjectId)) === 0
      ) {
        try {
          await release(
            gate.subjectId,
            "approved",
            ctx,
            {
              comment: args.comment?.trim() || null,
            },
            releaseRun,
          );
          releasedBeforeActions = true;
        } catch (e) {
          throw new ReleaseError(
            decision,
            sanitizeDecisionCause(e),
            !isProgrammingError(e),
            causeKindOf(e),
            e,
          );
        }
      }

      let hadFailure = false;
      let error: string | null = null;
      let branchCause: unknown;
      if (!subject) {
        hadFailure = true;
        error = "subject record no longer exists";
      } else {
        const evalCtx = continuationContext!;
        const plan = continuationPlan!;
        if (plan.actionNodes.length > 0 || plan.gates.length > 0) {
          const res = await executeFlowPlan(ctx, adapter, {
            flow: { id: flow.id, name: flow.name, subjectKind: gate.subjectKind, graph },
            runId: gate.runId,
            subjectId: gate.subjectId,
            plan,
            evalCtx,
            submitterUserId: subject.submitterUserId,
          });
          hadFailure = res.failed.length > 0;
          branchCause = res.failureCauses[0];
          error = hadFailure ? res.failed.join("; ") : null;
        }
      }

      // --- Engine-enforced release (deterministic, not author-dependent) -----
      // The document leaves pending_approval because the ENGINE reconciles the
      // subject's aggregate gate state — never because an author happened to wire
      // a change_status node. Reject returns to draft and cancels every other
      // open gate for the subject; approve releases only once no gate remains
      // open across ALL runs (multi-step and multi-flow safe).
      // --- Engine-enforced release (deterministic, not author-dependent) -----
      // (see the block comment above for the lifecycle rules). Like the
      // pre-action release, a throw here rolls back to the whole-decision
      // savepoint above: the whole decision —
      // including already-executed branch effects, whose checkpoints roll back
      // so a retried decision re-fires them exactly once — is undone, the gate
      // stays pending, and the caller gets a ReleaseError. It is deliberately
      // NOT converted to hadFailure: committing a failed release is what
      // stranded subjects with a success result.
      if (!hadFailure && release) {
        try {
          if (outcome.resume === "reject") {
            await cancelSubjectApprovals(gate.orgId, gate.subjectKind, gate.subjectId, gate.runId);
            await release(
              gate.subjectId,
              "rejected",
              ctx,
              {
                comment: args.comment?.trim() || null,
              },
              releaseRun,
            );
          } else if (
            !releasedBeforeActions &&
            (await subjectOpenGateCount(gate.orgId, gate.subjectKind, gate.subjectId)) === 0
          ) {
            await release(
              gate.subjectId,
              "approved",
              ctx,
              {
                comment: args.comment?.trim() || null,
              },
              releaseRun,
            );
          }
        } catch (e) {
          throw new ReleaseError(
            decision,
            sanitizeDecisionCause(e),
            !isProgrammingError(e),
            causeKindOf(e),
            e,
          );
        }
      }

      // A branch failure (missing subject, failed action) rolls the whole
      // decide unit back like a release failure: the savepoint removes the
      // flip, the audit, the notifications, and every effect the branch ran
      // before failing — including a pre-action release that already landed.
      // Retry-the-RUN cannot heal this (the gate checkpoint is stamped, so a
      // re-drive skips the branch and completes vacuously); the caller gets
      // DecisionFailedError and retries the DECISION, which re-runs the full
      // branch on the still-pending gate.
      if (hadFailure) {
        throw new DecisionFailedError({
          decision,
          stage: "branch",
          cause: error ?? "gate branch failed",
          originalCause: branchCause,
          retryable: !isProgrammingError(branchCause),
          causeKind: causeKindOf(branchCause),
        });
      }
      if (
        outcome.resume === "approve" &&
        (await subjectOpenGateCount(gate.orgId, gate.subjectKind, gate.subjectId)) === 0
      )
        await completeSubjectApprovalContinuations(
          gate.orgId,
          gate.subjectKind,
          gate.subjectId,
          gate.runId,
        );
      await finalizeRunStatus(gate.runId, gate.orgId, hadFailure, error);
      const runStatus =
        ((
          await db
            .select({ status: schema.flowRuns.status })
            .from(schema.flowRuns)
            .where(and(eq(schema.flowRuns.id, gate.runId), eq(schema.flowRuns.orgId, gate.orgId)))
        )[0]?.status as "waiting" | "completed") ?? "completed";
      return { ok: true, resumed: outcome.resume, runStatus };
    });
  });
}

/** Finish terminal branches after every governing Flow has released the subject. */
async function completeSubjectApprovalContinuations(
  orgId: string,
  subjectKind: string,
  subjectId: string,
  currentRunId: string,
): Promise<void> {
  const rows = await db.execute<{
    id: string;
    flow_id: string;
    name: string;
    context: Record<string, unknown>;
  }>(
    sql`
    select r.id,r.flow_id,f.name,r.context from flow_runs r join flows f on f.org_id=r.org_id and f.id=r.flow_id
      where r.org_id=${orgId} and r.subject_kind=${subjectKind} and r.subject_id=${subjectId}
        and r.id<>${currentRunId} and r.status='waiting' and r.context ? 'approvalContinuation'
      order by r.created_at,r.id for update of r`,
    "objects",
  );
  const adapter = getFlowAdapter(subjectKind);
  if (!adapter && rows.length) throw new Error("The pending approval subject is unavailable.");
  for (const row of rows) {
    const pending = row.context.approvalContinuation as {
      version?: unknown;
      gateId?: unknown;
      nodeId?: unknown;
      actorId?: unknown;
      evalCtx?: {
        values: Record<string, unknown>;
        rows: Record<string, Array<Record<string, unknown>>>;
      };
    };
    const policy = row.context.submissionPolicy as
      { graph?: unknown; flowId?: unknown } | undefined;
    if (
      pending.version !== 1 ||
      !isUuid(pending.gateId) ||
      !isUuid(pending.actorId) ||
      typeof pending.nodeId !== "string" ||
      !pending.evalCtx ||
      !pending.evalCtx.values ||
      !pending.evalCtx.rows ||
      policy?.flowId !== row.flow_id
    )
      throw new Error(
        "The pending approval branch has incomplete retained evidence. Recall the submission and review its Flows.",
      );
    const original = await loadGate(pending.gateId, orgId);
    if (
      !original ||
      original.runId !== row.id ||
      original.subjectKind !== subjectKind ||
      original.subjectId !== subjectId ||
      original.nodeId !== pending.nodeId ||
      original.status !== "approved" ||
      original.decidedBy !== pending.actorId ||
      !(await hasLiveApprovalRun(original))
    )
      throw new Error("The pending branch does not match its recorded native approval decision.");
    const permission = adapter!.decisionPermission
      ? await adapter!.decisionPermission(subjectId, pending.actorId)
      : adapter!.permissions?.approve;
    if (!permission) throw new Error("The pending branch has no native decision authority.");
    const scope = await lockActorCommandAuthority(db, orgId, pending.actorId, null, permission);
    await assertGateSubsidiaryScope(original, scope);
    const graph = parseFlowGraph(row.flow_id, policy.graph);
    const subject = await adapter!.loadContext(subjectId);
    if (!graph || !subject)
      throw new Error("The pending approval branch or subject is unavailable.");
    if (
      row.context.command &&
      canonicalJson(row.context.command) !== canonicalJson(pending.evalCtx.values.command)
    )
      throw new Error("The pending branch command differs from its frozen submission.");
    const plan = planFromGate(graph, pending.nodeId, "approve", pending.evalCtx);
    if (plan.gates.length)
      throw new Error("The pending branch contains undecided approval stages.");
    const result = await executeFlowPlan(
      { orgId, userId: pending.actorId, allowedSubsidiaryIds: scope },
      adapter!,
      {
        flow: { id: row.flow_id, name: row.name, subjectKind, graph },
        runId: row.id,
        subjectId,
        plan,
        evalCtx: pending.evalCtx,
        submitterUserId: subject.submitterUserId,
      },
    );
    if (result.failed.length)
      throw new DecisionFailedError({
        decision: "approved",
        stage: "branch",
        cause: result.failed.join("; "),
        originalCause: result.failureCauses[0],
        retryable: !isProgrammingError(result.failureCauses[0]),
        causeKind: causeKindOf(result.failureCauses[0]),
      });
    const saved = await db.execute(
      sql`update flow_runs set context=context-'approvalContinuation',status='completed',finished_at=now(),error=null
      where org_id=${orgId} and id=${row.id} and status='waiting' returning id`,
      "objects",
    );
    if (saved.length !== 1) throw new Error("The completed approval branch was not saved.");
  }
}

/** Open (pending/escalated) gate rows for a subject across ALL its runs. */
async function subjectOpenGateCount(
  orgId: string,
  subjectKind: string,
  subjectId: string,
): Promise<number> {
  const r = await db.execute<{ n: number }>(
    sql`
    select count(*)::int as n from flow_gates
     where org_id = ${orgId} and subject_kind = ${subjectKind} and subject_id = ${subjectId}
       and status in ('pending', 'escalated')
  `,
    "objects",
  );
  return r[0]?.n ?? 0;
}

/**
 * A rejection returns the record to draft, so every other still-open approval
 * for the same subject (other steps, other flows) is moot — cancel those gates
 * and terminate their runs so nothing dangling can later re-release the record.
 */
async function cancelSubjectApprovals(
  orgId: string,
  subjectKind: string,
  subjectId: string,
  decidingRunId: string,
): Promise<void> {
  await db
    .update(schema.flowGates)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(schema.flowGates.orgId, orgId),
        eq(schema.flowGates.subjectKind, subjectKind),
        eq(schema.flowGates.subjectId, subjectId),
        inArray(schema.flowGates.status, ["pending", "escalated"]),
      ),
    )
    .returning({ runId: schema.flowGates.runId });
  await db.execute(sql`update flow_runs set status='cancelled',finished_at=now()
    where org_id=${orgId} and subject_kind=${subjectKind} and subject_id=${subjectId}
      and id<>${decidingRunId} and status in ('running','waiting')`);
  await resolveApprovalRequestNotices(orgId, subjectKind, subjectId);
}

/**
 * Notify the submitter of this gate's decision, without claiming that every
 * governing Flow has released the record. The rejection reason is retained.
 */
async function notifySubmitterOfDecision(args: {
  gate: GateRow;
  adapter: FlowSubjectAdapter;
  subject: FlowSubjectContext | null;
  branch: "approve" | "reject";
  deciderUserId: string;
  reason: string | null;
}): Promise<void> {
  const { gate, adapter, subject, branch } = args;
  const submitterUserId = subject?.submitterUserId ?? null;
  // No submitter, or the submitter decided their own gate — nothing to tell.
  if (!submitterUserId || submitterUserId === args.deciderUserId) return;
  const submitter = await verifyUser(gate.orgId, submitterUserId);
  if (!submitter) return;
  const decider = await verifyUser(gate.orgId, args.deciderUserId);
  const subjectLabel = subject ? adapter.label(gate.subjectId, subject.values) : gate.subjectKind;
  const verb = branch === "approve" ? "approved" : "rejected";
  const title = `${gate.title}: ${verb} by ${decider?.name ?? "an approver"} · ${subjectLabel}`;
  const reasonLine = branch === "reject" && args.reason ? `Reason: ${args.reason}` : null;
  const href = adapter.deepLink(gate.subjectId);

  await db.insert(schema.notifications).values({
    orgId: gate.orgId,
    userId: submitter.id,
    kind: "approval",
    title,
    body: reasonLine,
    href,
  });

  try {
    const { flowNotificationEmail } = await import("@openbooks/emails");
    const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, gate.orgId));
    const mail = flowNotificationEmail({
      orgName: org?.name ?? "OpenBooks",
      subject: title,
      body: reasonLine ? `${title}\n\n${reasonLine}` : title,
    });
    // Deferred through the durable outbox, NOT direct-to-Redis: the row rides
    // this decide transaction, so a rolled-back decision (release failure)
    // sends nothing — the submitter can never receive an "approved" email for
    // a decision that was never recorded. The occurrence key is bound to the
    // gate row, so a retried decision collapses onto one send.
    await enqueueFlowEmail({
      orgId: gate.orgId,
      runId: gate.runId,
      occurrenceKey: `${gate.runId}:decision-notify:${gate.id}`,
      payload: {
        to: [submitter.email],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        meta: { category: "approvals" },
      },
    });
  } catch (e) {
    // In-app row already landed; a down queue only costs the email copy.
    console.error(`[flows] submitter decision email enqueue failed (gate ${gate.id}):`, e);
  }
}

// --- Worklist -----------------------------------------------------------------

export interface WorklistGate {
  id: string;
  runId: string;
  flowId: string;
  nodeId: string;
  groupKey: string;
  quorum: "any" | "all";
  title: string;
  subjectKind: string;
  subjectId: string;
  signatureRequired: boolean;
  assigneeUserId: string | null;
  assigneeRole: string | null;
  createdAt: Date;
  remindAt: Date | null;
  escalateAt: Date | null;
  /**
   * Set when this gate reached the caller through an ACTIVE out-of-office
   * delegation (approval_delegations): the principal whose gate it is. Null
   * for the caller's own gates.
   */
  onBehalfOf: { userId: string; name: string } | null;
  /** Native subject label/link for non-document approvals such as close runs. */
  subjectLabel: string | null;
  href: string | null;
  /**
   * Legal entity owning the approval subject: the joined document's for
   * document approvals, resolved from the employee/bank party otherwise.
   * Null when unresolvable — restricted callers fail closed on null exactly
   * like the decide path (gateSubsidiaryScopeAllows).
   */
  subsidiaryId: string | null;
  /** Joined document header (null for future non-document subjects). */
  document: {
    subsidiaryId: string | null;
    documentNumber: string;
    kind: string;
    status: string;
    total: string;
    currency: string;
    documentDate: string;
    partyName: string | null;
    memo: string | null;
  } | null;
}

function mapWorklistRow(
  row: Record<string, unknown>,
  onBehalfOf: WorklistGate["onBehalfOf"],
): WorklistGate {
  return {
    id: String(row.id),
    runId: String(row.runId),
    flowId: String(row.flowId),
    nodeId: String(row.nodeId),
    groupKey: String(row.groupKey),
    quorum: row.quorum as "any" | "all",
    title: String(row.title),
    subjectKind: String(row.subjectKind),
    subjectId: String(row.subjectId),
    signatureRequired: !!row.signatureRequired,
    assigneeUserId: (row.assigneeUserId as string | null) ?? null,
    assigneeRole: (row.assigneeRole as string | null) ?? null,
    createdAt: row.createdAt as Date,
    remindAt: (row.remindAt as Date | null) ?? null,
    escalateAt: (row.escalateAt as Date | null) ?? null,
    onBehalfOf,
    subjectLabel: (row.subjectLabel as string | null) ?? null,
    subsidiaryId: (row.subsidiaryId as string | null) ?? null,
    href: getFlowAdapter(String(row.subjectKind))?.deepLink(String(row.subjectId)) ?? null,
    document: row.documentNumber
      ? {
          subsidiaryId: (row.subsidiaryId as string | null) ?? null,
          documentNumber: String(row.documentNumber),
          kind: String(row.docKind),
          status: String(row.docStatus),
          total: String(row.total),
          currency: String(row.currency),
          documentDate: String(row.documentDate),
          partyName: (row.partyName as string | null) ?? null,
          memo: (row.memo as string | null) ?? null,
        }
      : null,
  };
}

/**
 * Subject identity behind a gate row, resolved from the same sources the
 * inbox row renders (the per-kind subject resolvers read these identical
 * tables). One CASE feeds both the selected subjectLabel column and the
 * text search, so a query matches exactly what the row displays. The match
 * stays in SQL — never a filter after the page — so windowed rows and kind
 * counts cannot disagree. Financial-change branches mirror
 * loadFinancialChangeSubjectLabel domain by domain; the final else names
 * subsidiary subjects the same way.
 */
const WORKLIST_SUBJECT_JOINS = sql`
      left join budget_scenarios bs on bs.id = g.subject_id and bs.org_id = g.org_id and g.subject_kind = 'budget_scenario'
      left join financial_changes fc on fc.id = g.subject_id and fc.org_id = g.org_id and g.subject_kind = 'financial_change'
      left join items fci on fci.id = fc.subject_id and fci.org_id = fc.org_id and fc.domain = 'manufacturing'
        and fc.operation in (${MANUFACTURING_BOM_APPROVAL_OPERATION}, ${MANUFACTURING_STANDARD_ROLLUP_OPERATION})
      left join mfg_routings fcr on fcr.id = fc.subject_id and fcr.org_id = fc.org_id and fc.domain = 'manufacturing' and fc.operation = ${MANUFACTURING_ROUTING_APPROVAL_OPERATION}
      left join mfg_work_orders fcwol on fcwol.id = fc.subject_id and fcwol.org_id = fc.org_id and fc.domain = 'manufacturing' and fc.operation = ${MANUFACTURING_LOSS_DISPOSITION_OPERATION}
      left join mfg_scrap_events fcse on fcse.id = fc.subject_id and fcse.org_id = fc.org_id and fc.domain = 'manufacturing' and fc.operation = ${MANUFACTURING_SCRAP_RESTATEMENT_OPERATION}
      left join mfg_work_orders fcwos on fcwos.id = fcse.work_order_id and fcwos.org_id = fcse.org_id
      left join parties fcp on fcp.id = fc.subject_id and fcp.org_id = fc.org_id and fc.domain = 'payroll'
      left join document_lines fdcl on fdcl.id = fc.subject_id and fdcl.org_id = fc.org_id and fc.domain = 'sales'
      left join documents fdcd on fdcd.id = fdcl.document_id and fdcd.org_id = fdcl.org_id
      left join lease_agreements fcl on fcl.id = fc.subject_id and fcl.org_id = fc.org_id and fc.domain = 'lease'
      left join fixed_assets fca on fca.id = fc.subject_id and fca.org_id = fc.org_id and fc.domain = 'asset'
      left join revenue_contracts fcrc on fcrc.id = fc.subject_id and fcrc.org_id = fc.org_id and fc.domain = 'revenue'
      left join provision_obligations fcpv on fcpv.id = fc.subject_id and fcpv.org_id = fc.org_id and fc.domain = 'provision'
      left join subsidiary_ownership_interests fcsoi on fcsoi.id = fc.subject_id and fcsoi.org_id = fc.org_id
      left join subsidiaries fcsub on fcsub.id = fcsoi.subsidiary_id and fcsub.org_id = fcsoi.org_id
      left join equity_action_requests ear on ear.id = g.subject_id and ear.org_id = g.org_id and g.subject_kind = 'equity_action'
      left join hrm_employment_change_requests hcr on hcr.id = g.subject_id and hcr.org_id = g.org_id and g.subject_kind = 'hrm_employment_change_request'
      left join worker_employments hce on hce.id = hcr.employment_id and hce.org_id = hcr.org_id
      left join parties hcp on hcp.id = hce.worker_party_id and hcp.org_id = hce.org_id`;
const WORKLIST_SUBJECT_LABEL = sql`
      case when d.id is not null then d.document_number
           when bs.id is not null then bs.name
           when cp.id is not null then ${canonicalPeriodLabelSql("cp")} || ' close'
           when g.subject_kind = 'hrm_employment_change_request' then hcp.display_name
           when g.subject_kind = 'equity_action' then ear.subject_label
           when g.subject_kind = 'financial_change' then case
             when fc.domain = 'payroll' then fcp.display_name
             when fc.domain = 'sales' then fdcd.document_number || ' — line ' || fdcl.line_number
             when fc.domain = 'lease' then nullif(concat_ws(' — ', fcl.lease_number, nullif(btrim(fcl.description), '')), '')
             when fc.domain = 'asset' then fca.asset_number || ' — ' || fca.name
             when fc.domain = 'revenue' then nullif(concat_ws(' — ', fcrc.contract_number, nullif(btrim(fcrc.memo), '')), '')
             when fc.domain = 'provision' then fcpv.name
             when fc.domain = 'manufacturing' and fc.operation in (${MANUFACTURING_BOM_APPROVAL_OPERATION}, ${MANUFACTURING_STANDARD_ROLLUP_OPERATION}) then concat_ws(' — ', fci.code, fci.name)
             when fc.domain = 'manufacturing' and fc.operation = ${MANUFACTURING_ROUTING_APPROVAL_OPERATION} then concat_ws(' — ', fcr.code, fcr.name)
             when fc.domain = 'manufacturing' and fc.operation = ${MANUFACTURING_LOSS_DISPOSITION_OPERATION} then fcwol.number
             when fc.domain = 'manufacturing' and fc.operation = ${MANUFACTURING_SCRAP_RESTATEMENT_OPERATION} then fcwos.number || ' — scrap'
             when fc.domain = 'manufacturing' then null
             else fcsub.name end end`;

const WORKLIST_SELECT = sql`
    select g.id, g.run_id as "runId", g.flow_id as "flowId", g.node_id as "nodeId",
           g.group_key as "groupKey", g.quorum, g.title,
           g.subject_kind as "subjectKind", g.subject_id as "subjectId",
           g.signature_required as "signatureRequired",
           g.assignee_user_id as "assigneeUserId", g.assignee_role as "assigneeRole",
           g.created_at as "createdAt", g.remind_at as "remindAt", g.escalate_at as "escalateAt",
           d.document_number as "documentNumber", d.kind as "docKind", d.status as "docStatus",
           d.subsidiary_id as "subsidiaryId",
           d.total, d.currency, d.document_date as "documentDate", d.memo,
           p.display_name as "partyName", cp.name as "closePeriodName",
           ${WORKLIST_SUBJECT_LABEL} as "subjectLabel"
      from flow_gates g
      left join documents d on d.id = g.subject_id and d.org_id = g.org_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join close_runs cr on cr.id = g.subject_id and cr.org_id = g.org_id and g.subject_kind = ${CLOSE_RUN_SUBJECT_KIND}
      left join accounting_periods cp on cp.id = cr.period_id and cp.org_id = cr.org_id
      ${WORKLIST_SUBJECT_JOINS}`;

/**
 * Pending gates the user may act on: assigned to them directly, to a role
 * they hold, or — flagged with `onBehalfOf` — assigned to a principal who has
 * an ACTIVE delegation window pointing at them (out-of-office coverage).
 * `roles` defaults to the user's resolved role keys.
 */
/**
 * Fill in the legal entity behind worklist rows whose subject is not a
 * document, through each kind's declared scope (a timesheet week inherits
 * its employee party's, a work order carries its own). One query per
 * subject kind; subjects with no resolvable entity keep null so restricted
 * callers fail closed on them.
 */
async function resolveWorklistSubsidiaries(
  orgId: string,
  gates: WorklistGate[],
  allowedSubsidiaryIds?: GateSubsidiaryScope,
): Promise<void> {
  const missing = new Map<string, WorklistGate[]>();
  for (const gate of gates) {
    if (gate.subsidiaryId != null) continue;
    missing.set(gate.subjectKind, [...(missing.get(gate.subjectKind) ?? []), gate]);
  }
  await Promise.all(
    [...missing].map(async ([kind, kindGates]) => {
      const scope = getFlowAdapter(kind)?.scope;
      // Documents already carry their entity through the join, and org-wide
      // subjects have none; an unregistered kind keeps null and fails closed.
      if (!scope || scope.via === "document" || scope.via === "none") return;
      const owners = await resolveSubjectSubsidiaries(
        orgId,
        kind,
        scope,
        kindGates.map((gate) => gate.subjectId),
        allowedSubsidiaryIds ?? null,
      );
      for (const gate of kindGates) gate.subsidiaryId = owners.get(gate.subjectId) ?? null;
    }),
  );
}

/**
 * A server-side window over the gate leg of the approvals union. `prefix` is
 * the number of leading leg rows to fetch (offset+limit at the union level):
 * legs are disjoint and share the merge order, so the union slices its page
 * from per-leg prefixes without ever fetching the whole leg. `kind` filters
 * on the same expression the row mapper reports
 * (coalesce(document kind, subject kind)).
 */
export interface WorklistGatePage {
  prefix: number;
  gateId?: string;
  kind?: string;
  query?: string;
  overdue?: boolean;
  /**
   * Whose gates the leg reads. `caller` (the default) is the caller's own
   * worklist: gates assigned to them, to a role they hold, or delegated to
   * them. `organization` is every pending, live gate in the organization
   * inside the caller's legal-entity boundary, whatever its assignee — the
   * oversight view. Both share the liveness, scope, kind, search and
   * overdue predicates, so the two readings differ only in the assignee
   * condition.
   */
  audience?: WorklistAudience;
}

/** Whose approvals a worklist read covers (see WorklistGatePage.audience). */
export type WorklistAudience = "caller" | "organization";

/**
 * SQL pre-filter reproducing gateSubsidiaryScopeAllows exactly: a document
 * subject by its own entity, every other subject by the owner its kind's
 * declared scope names (subjectSubsidiarySql — the same owners
 * resolveSubjectSubsidiaries returns), and custom scopes by their own
 * worklist predicate. A subject with no provable entity fails closed. Custom
 * scopes without a worklist predicate pass through to
 * resolveWorklistSubsidiaries + the JS filter, so the predicate drops in SQL
 * only what the JS filter would drop: rows, page windows and kind counts all
 * read the same boundary.
 */
function worklistGateScopeSql(allowedSubsidiaryIds: GateSubsidiaryScope): SQL {
  if (allowedSubsidiaryIds == null) return sql``;
  const ids = JSON.stringify([...allowedSubsidiaryIds]);
  const scoped = listFlowSubjectProfiles().flatMap(({ subjectKind }) => {
    const scope = getFlowAdapter(subjectKind)?.scope;
    return scope ? [{ subjectKind, scope }] : [];
  });
  const predicates = scoped.flatMap(({ subjectKind, scope }) =>
    scope.via === "custom" && scope.worklistPredicate
      ? [{ subjectKind, predicate: scope.worklistPredicate(ids) }]
      : [],
  );
  const unfilteredCustomKinds = JSON.stringify(
    scoped
      .filter(({ scope }) => scope.via === "custom" && !scope.worklistPredicate)
      .map(({ subjectKind }) => subjectKind),
  );
  const owner = subjectSubsidiarySql(
    scoped.filter(({ scope }) => scope.via !== "custom"),
    { kind: sql`g.subject_kind`, id: sql`g.subject_id`, org: sql`g.org_id` },
  );
  return sql`and (
    d.subsidiary_id in (select jsonb_array_elements_text(${ids}::jsonb)::uuid)
    or (d.id is null and ${owner} in (select jsonb_array_elements_text(${ids}::jsonb)::uuid))
    or (d.id is null and g.subject_kind in (select jsonb_array_elements_text(${unfilteredCustomKinds}::jsonb)))
    ${sql.join(
      predicates.map(
        ({ subjectKind, predicate }) => sql`or (g.subject_kind = ${subjectKind} and ${predicate})`,
      ),
      sql` `,
    )}
  )`;
}

function worklistGateKindSql(kind: string | undefined): SQL {
  if (kind == null) return sql``;
  return sql`and coalesce(d.kind, g.subject_kind) = ${kind}`;
}

function worklistGateSearchSql(query: string | undefined): SQL {
  const needle = query?.trim().toLowerCase();
  if (!needle) return sql``;
  // The close period matches by its shown label and by its stored name.
  return sql`and position(${needle} in lower(concat_ws(' ', g.title, g.subject_kind, d.document_number, d.memo, cp.name, ${WORKLIST_SUBJECT_LABEL}))) > 0`;
}

function worklistGateOverdueSql(overdue: boolean | undefined): SQL {
  return overdue ? sql`and g.escalate_at is not null and g.escalate_at < now()` : sql``;
}

/**
 * Liveness shared by the gate leg's rows and its kind counts: a pending gate
 * is actionable only while its run still awaits a decision and its subject
 * still exists undecided. Decided, voided, or deleted subjects leave pending
 * rows behind (failed or superseded runs, removed records); listing them
 * would offer decisions the native path must refuse, and counting them
 * inflates the badge past the rows. One predicate feeds worklistGates and
 * worklistGateKindCounts, so the two cannot disagree.
 *
 * Document decisions release while the record awaits approval, so a pending
 * gate stays listed while its document does — the exclusion below drops only
 * subjects that cannot be decided at all (a run that already closed, an
 * accounting event that already left pending, a document row that no longer
 * exists), never a later gate in a multi-level chain.
 */
function worklistLiveGateSql(): SQL {
  const docKinds = JSON.stringify([...DOCUMENT_FLOW_KINDS]);
  return sql`and ${liveApprovalRunSql(sql`g.org_id`, sql`g.run_id`, sql`g.subject_kind`, sql`g.subject_id`)}
  and (g.subject_kind <> 'financial_change' or exists (
    select 1 from financial_changes fc
     where fc.org_id = g.org_id and fc.id = g.subject_id and fc.status = 'pending'
  ))
  and (g.subject_kind not in (select jsonb_array_elements_text(${docKinds}::jsonb)) or exists (
    select 1 from documents d
     where d.org_id = g.org_id and d.id = g.subject_id
  ))`;
}

function worklistDirectWhere(
  orgId: string,
  userId: string,
  roleList: string[],
  allowedSubsidiaryIds: GateSubsidiaryScope,
  kind: string | undefined,
  query: string | undefined,
  overdue: boolean | undefined,
  gateId?: string,
): SQL {
  return sql`g.org_id = ${orgId} and g.status = 'pending'
    ${worklistLiveGateSql()}
    and (g.assignee_user_id = ${userId}
         or (g.assignee_role is not null and g.assignee_role in
              (select jsonb_array_elements_text(${JSON.stringify(roleList)}::jsonb))))
    ${worklistGateScopeSql(allowedSubsidiaryIds)}
    ${gateId ? sql`and g.id = ${gateId}::uuid` : sql``}
    ${worklistGateKindSql(kind)}
    ${worklistGateSearchSql(query)}
    ${worklistGateOverdueSql(overdue)}`;
}

/**
 * Every pending, live gate in the organization, whatever its assignee, under
 * the same liveness, legal-entity, kind, search and overdue predicates the
 * caller's worklist applies.
 */
function worklistOrganizationWhere(
  orgId: string,
  allowedSubsidiaryIds: GateSubsidiaryScope,
  kind: string | undefined,
  query: string | undefined,
  overdue: boolean | undefined,
): SQL {
  return sql`g.org_id = ${orgId} and g.status = 'pending'
    ${worklistLiveGateSql()}
    ${worklistGateScopeSql(allowedSubsidiaryIds)}
    ${worklistGateKindSql(kind)}
    ${worklistGateSearchSql(query)}
    ${worklistGateOverdueSql(overdue)}`;
}

export async function worklistGates(
  orgId: string,
  userId: string,
  roles?: Iterable<string>,
  /**
   * Subsidiaries visible to this caller. A gate assignment is not a grant to
   * every legal entity: restricted sets filter the worklist with the same
   * fail-closed rule the decide path enforces, so financial details from
   * other entities are never listed. Null/undefined means unrestricted.
   */
  allowedSubsidiaryIds?: GateSubsidiaryScope,
  /**
   * Paged read: fetch only the leading `prefix` rows of this leg in leg
   * order. Omitted for the full read (dashboard tile, counts).
   */
  page?: WorklistGatePage,
): Promise<WorklistGate[]> {
  const kind = page?.kind;
  const query = page?.query;
  const overdue = page?.overdue;
  if (page?.audience === "organization") {
    // The oversight reading has no assignee condition and so no delegation
    // arm: a delegated gate is listed once, under its current assignee.
    const rows = (
      await db.execute<Record<string, unknown>>(
        sql`
      ${WORKLIST_SELECT}
       where ${worklistOrganizationWhere(orgId, allowedSubsidiaryIds, kind, query, overdue)}
       order by g.created_at, g.id
       limit ${page.prefix}
    `,
        "objects",
      )
    ).map((row) => mapWorklistRow(row, null));
    await resolveWorklistSubsidiaries(orgId, rows, allowedSubsidiaryIds);
    return allowedSubsidiaryIds != null
      ? rows.filter((g) => gateSubsidiaryScopeAllows(allowedSubsidiaryIds, g.subsidiaryId))
      : rows;
  }
  const roleList = roles ? [...roles] : [...(await userRoleKeys(orgId, userId))];
  // The id tiebreaker pins page boundaries: without a unique order key
  // Postgres may return tied rows in any order and rows duplicate or drop
  // across pages (same rule as the document list order clause).
  const r = await db.execute<Record<string, unknown>>(
    sql`
    ${WORKLIST_SELECT}
     where ${worklistDirectWhere(orgId, userId, roleList, allowedSubsidiaryIds, kind, query, overdue, page?.gateId)}
     order by g.created_at, g.id
     ${page ? sql`limit ${page.prefix}` : sql``}
  `,
    "objects",
  );
  const out = r.map((row) => mapWorklistRow(row, null));

  // Delegated gates: pending rows whose DIRECT assignee currently delegates
  // to the caller. Only user-assigned rows qualify (the principal's
  // assignment is the grant — role gates the principal merely could claim do
  // not travel), and rows already in the caller's own list win over the
  // delegated view of the same row. This arm stays unpaged by design: it
  // covers a handful of out-of-office principals, and windowing it would
  // break the dedup below (a delegated duplicate past the window would
  // resurface as a second row). The direct arm above carries the page.
  const principals = await activeDelegationPrincipals(orgId, userId);
  if (principals.length > 0) {
    const seen = new Set(out.map((g) => g.id));
    const byId = new Map(principals.map((p) => [p.id, p]));
    const d = await db.execute<Record<string, unknown>>(
      sql`
      ${WORKLIST_SELECT}
       where g.org_id = ${orgId} and g.status = 'pending'
         ${worklistLiveGateSql()}
         ${page?.gateId ? sql`and g.id = ${page.gateId}::uuid` : sql``}
         and g.assignee_user_id in
              (select jsonb_array_elements_text(${JSON.stringify(principals.map((p) => p.id))}::jsonb)::uuid)
         ${worklistGateScopeSql(allowedSubsidiaryIds)}
         ${worklistGateKindSql(kind)}
         ${worklistGateSearchSql(query)}
         ${worklistGateOverdueSql(overdue)}
       order by g.created_at, g.id
    `,
      "objects",
    );
    for (const row of d) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const principal = byId.get(String(row.assigneeUserId));
      if (!principal) continue;
      out.push(mapWorklistRow(row, { userId: principal.id, name: principal.name }));
    }
  }
  // Every row carries its legal entity (documents join it; other subjects
  // resolve above) so all worklist surfaces can apply the caller's boundary.
  await resolveWorklistSubsidiaries(orgId, out, allowedSubsidiaryIds);
  if (allowedSubsidiaryIds != null) {
    return out.filter((g) => gateSubsidiaryScopeAllows(allowedSubsidiaryIds, g.subsidiaryId));
  }
  return out;
}

/**
 * Per-kind totals for the gate leg under the exact predicates worklistGates
 * applies (direct + delegated-minus-direct, scope, kind; or, for the
 * organization audience, every live gate in scope). The approvals page
 * derives its total and kind chips from these aggregates instead of counting
 * fetched rows, so the counts stay exact while the rows stay windowed.
 */
export async function worklistGateKindCounts(
  orgId: string,
  userId: string,
  roles?: Iterable<string>,
  allowedSubsidiaryIds?: GateSubsidiaryScope,
  kind?: string,
  query?: string,
  overdue?: boolean,
  audience: WorklistAudience = "caller",
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const accumulate = (rows: Array<{ kind: string; n: string }>) => {
    for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + Number(row.n));
  };
  const baseJoins = sql`
      from flow_gates g
      left join documents d on d.id = g.subject_id and d.org_id = g.org_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join close_runs cr on cr.id = g.subject_id and cr.org_id = g.org_id and g.subject_kind = ${CLOSE_RUN_SUBJECT_KIND}
      left join accounting_periods cp on cp.id = cr.period_id and cp.org_id = cr.org_id
      ${WORKLIST_SUBJECT_JOINS}`;
  if (audience === "organization") {
    accumulate(
      await db.execute<{ kind: string; n: string }>(
        sql`
      select coalesce(d.kind, g.subject_kind) as kind, count(*) as n
        ${baseJoins}
       where ${worklistOrganizationWhere(orgId, allowedSubsidiaryIds, kind, query, overdue)}
       group by coalesce(d.kind, g.subject_kind)
    `,
        "objects",
      ),
    );
    return counts;
  }
  const roleList = roles ? [...roles] : [...(await userRoleKeys(orgId, userId))];
  accumulate(
    await db.execute<{ kind: string; n: string }>(
      sql`
    select coalesce(d.kind, g.subject_kind) as kind, count(*) as n
      ${baseJoins}
     where ${worklistDirectWhere(orgId, userId, roleList, allowedSubsidiaryIds, kind, query, overdue)}
     group by coalesce(d.kind, g.subject_kind)
  `,
      "objects",
    ),
  );
  const principals = await activeDelegationPrincipals(orgId, userId);
  if (principals.length > 0) {
    // Same dedup as the row merge, expressed as a predicate: a delegated row
    // satisfying the direct condition would already be counted above.
    accumulate(
      await db.execute<{ kind: string; n: string }>(
        sql`
      select coalesce(d.kind, g.subject_kind) as kind, count(*) as n
        ${baseJoins}
       where g.org_id = ${orgId} and g.status = 'pending'
         ${worklistLiveGateSql()}
         and g.assignee_user_id in
              (select jsonb_array_elements_text(${JSON.stringify(principals.map((p) => p.id))}::jsonb)::uuid)
         and not (g.assignee_user_id = ${userId}
              or (g.assignee_role is not null and g.assignee_role in
                   (select jsonb_array_elements_text(${JSON.stringify(roleList)}::jsonb))))
         ${worklistGateScopeSql(allowedSubsidiaryIds)}
         ${worklistGateKindSql(kind)}
         ${worklistGateSearchSql(query)}
         ${worklistGateOverdueSql(overdue)}
       group by coalesce(d.kind, g.subject_kind)
    `,
        "objects",
      ),
    );
  }
  return counts;
}

/**
 * Pending gates the shared worklist predicate holds back, with the reason
 * each one is unactionable. `run_closed` and `subject_missing`/`subject_decided`
 * rows are exactly what worklistLiveGateSql excludes from both the rows and
 * the counts; `awaiting_void` rows stay listed (a void-requested document may
 * still carry its void decision through the same gate) and are reported for
 * review, never for automatic cleanup.
 *
 * This is a read-only reconciliation readout. Clearing a held-back gate is a
 * governed act — cancel it through the Flows run with its audit reason, or
 * re-drive the run — never a direct delete: the gate row is decision
 * evidence even when its subject is gone.
 */
export interface OrphanedPendingGate {
  id: string;
  runId: string;
  flowId: string;
  subjectKind: string;
  subjectId: string;
  assigneeUserId: string | null;
  assigneeRole: string | null;
  createdAt: Date;
  reason: "run_closed" | "subject_decided" | "subject_missing" | "awaiting_void";
  runStatus: string | null;
}

export async function listOrphanedPendingGates(orgId: string): Promise<OrphanedPendingGate[]> {
  const docKinds = JSON.stringify([...DOCUMENT_FLOW_KINDS]);
  const rows = await db.execute<{
    id: string;
    runId: string;
    flowId: string;
    subjectKind: string;
    subjectId: string;
    assigneeUserId: string | null;
    assigneeRole: string | null;
    createdAt: Date;
    runStatus: string | null;
    fcStatus: string | null;
    fcExists: boolean;
    docExists: boolean;
    voidRequested: boolean;
  }>(
    sql`
    select g.id::text as id, g.run_id::text as "runId", g.flow_id::text as "flowId",
           g.subject_kind as "subjectKind", g.subject_id::text as "subjectId",
           g.assignee_user_id::text as "assigneeUserId", g.assignee_role as "assigneeRole",
           g.created_at as "createdAt", r.status as "runStatus",
           fc.status as "fcStatus", (fc.id is not null) as "fcExists",
           (d.id is not null) as "docExists", (d.void_requested_at is not null) as "voidRequested"
      from flow_gates g
      left join flow_runs r on r.org_id = g.org_id and r.id = g.run_id
      left join financial_changes fc on fc.org_id = g.org_id and fc.id = g.subject_id
        and g.subject_kind = 'financial_change'
      left join documents d on d.org_id = g.org_id and d.id = g.subject_id
        and g.subject_kind in (select jsonb_array_elements_text(${docKinds}::jsonb))
     where g.org_id = ${orgId} and g.status = 'pending'
     order by g.created_at, g.id
  `,
    "objects",
  );
  const docKindSet = new Set<string>(DOCUMENT_FLOW_KINDS);
  const out: OrphanedPendingGate[] = [];
  for (const row of rows) {
    const base = {
      id: row.id,
      runId: row.runId,
      flowId: row.flowId,
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      assigneeUserId: row.assigneeUserId,
      assigneeRole: row.assigneeRole,
      createdAt: row.createdAt,
      runStatus: row.runStatus,
    };
    if (row.runStatus !== "waiting" && row.runStatus !== "running") {
      out.push({ ...base, reason: "run_closed" });
      continue;
    }
    if (row.subjectKind === "financial_change") {
      if (row.fcStatus !== "pending") {
        out.push({ ...base, reason: row.fcExists ? "subject_decided" : "subject_missing" });
      }
      continue;
    }
    if (docKindSet.has(row.subjectKind)) {
      if (!row.docExists) out.push({ ...base, reason: "subject_missing" });
      else if (row.voidRequested) out.push({ ...base, reason: "awaiting_void" });
    }
  }
  return out;
}

// --- Delegation ----------------------------------------------------------------

/**
 * Reassign a pending gate to another in-org user. Authorization: the current
 * assignee or an org admin. The hand-off is recorded in a STRUCTURED column
 * (delegated_from_user_id) — not a free-text comment marker — so the audit
 * survives the decision and can't be forged by typing into a comment.
 *
 * The handover `note` (the delegator's covering note, parsed from the inbox
 * delegation reason) is persisted twice: in the delegate's notice body, so
 * the colleague taking over actually sees it, and in the audit row, so the
 * hand-off evidence keeps who said what. An empty note records as null.
 *
 * Callers that carry an Authz subsidiary scope pass it: a restricted actor
 * must not hand off a gate outside their legal-entity boundary by id, any
 * more than they may decide it. Absent scope means no boundary to enforce.
 */
export async function delegateGate(
  gateId: string,
  fromUserId: string,
  toUserId: string,
  allowedSubsidiaryIds?: GateSubsidiaryScope,
  note?: string | null,
): Promise<void> {
  const gate = await loadGate(gateId);
  if (!gate) throw new GateError("approval not found");
  if (gate.status !== "pending") throw new GateError("only a pending approval can be delegated");
  await assertGateSubsidiaryScope(gate, allowedSubsidiaryIds);
  if (!(
    gate.assigneeUserId === fromUserId ||
    (await actorHasPermission(db, gate.orgId, fromUserId, "flows.manage"))
  )) {
    throw new GateError(
      "Only the assigned approver or a tenant Flow manager can delegate this approval.",
    );
  }
  const to = await verifyUser(gate.orgId, toUserId);
  if (!to) throw new GateError("delegate target is not an active user in this org");
  const adapter = getFlowAdapter(gate.subjectKind);
  const subject = await adapter?.loadContext(gate.subjectId);
  if (await gateDecisionSodBlocked(gate, adapter, subject, [to.id])) {
    throw new GateError(
      "an approval cannot be delegated to its submitter or maker",
      "self_approval_forbidden",
    );
  }
  // Preserve the ORIGINAL assignee (the first hand-off wins — a chain of
  // delegations still points back to who the gate was authored to).
  const delegatedFrom = gate.delegatedFromUserId ?? gate.assigneeUserId ?? fromUserId;

  // One atomic unit: the reassignment, the delegate's notice, and the audit
  // evidence commit together, so a hand-off that changes who may release the
  // document can never persist without its actor-attributed trail.
  // The same subject-then-run locks decide/escalate hold: a concurrent decide that
  // flips pending → decided must win, and this write must then match zero
  // rows and refuse — never notify/audit a delegation that did not land.
  await withOrg(gate.orgId, async () => {
    await lockApprovalSubject(gate.orgId, gate.subjectKind, gate.subjectId);
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${gate.runId}))`);
    const current = await loadGate(gateId, gate.orgId);
    if (!current || current.status !== "pending" || !(await hasLiveApprovalRun(current)))
      throw new GateError(
        "This approval is no longer active. Reopen the current submission before delegating.",
      );
    const fromPermission =
      current.assigneeUserId === fromUserId
        ? adapter?.decisionPermission
          ? await adapter.decisionPermission(gate.subjectId, fromUserId)
          : adapter?.permissions?.approve
        : "flows.manage";
    const toPermission = adapter?.decisionPermission
      ? await adapter.decisionPermission(gate.subjectId, toUserId)
      : adapter?.permissions?.approve;
    if (!fromPermission || !toPermission)
      throw new GateError("This gate has no native delegation authority.");
    const fromScope = await lockActorCommandAuthority(
      db,
      gate.orgId,
      fromUserId,
      null,
      fromPermission,
    );
    await assertGateSubsidiaryScope(current, fromScope);
    const toScope = await lockActorCommandAuthority(db, gate.orgId, toUserId, null, toPermission);
    await assertGateSubsidiaryScope(current, toScope);
    if (
      await gateDecisionSodBlocked(
        current,
        adapter,
        await adapter?.loadContext(current.subjectId),
        [toUserId],
      )
    )
      throw new GateError(
        "The submitted tenant Flow does not permit this delegate's self-approval.",
        "self_approval_forbidden",
      );
    try {
      const delegated = await db
        .update(schema.flowGates)
        .set({
          assigneeUserId: toUserId,
          delegatedFromUserId: delegatedFrom,
          updatedBy: fromUserId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.flowGates.id, gateId),
            eq(schema.flowGates.orgId, gate.orgId),
            eq(schema.flowGates.status, "pending"),
          ),
        )
        .returning({ id: schema.flowGates.id });
      if (delegated.length === 0) {
        throw new GateError("this approval was already resolved");
      }
    } catch (e) {
      if (e instanceof GateError) throw e;
      // Unique (run_id, node_id, assignee_user_id): the target already
      // holds a sibling row of this gate — a data condition, not a
      // defect, so it keeps its own curated refusal.
      if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505") {
        throw new GateError(
          "the target already holds this approval — it cannot be delegated twice",
        );
      }
      throw new GateError(`could not delegate: ${sanitizeDecisionCause(e)}`);
    }

    const handoverNote = note?.trim() ? note.trim() : null;
    await db.insert(schema.notifications).values({
      orgId: gate.orgId,
      userId: toUserId,
      kind: "approval",
      title: `Approval delegated to you: ${gate.title}`,
      body: handoverNote,
      href: "/inbox",
    });

    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${gate.orgId}, 'flow_gates', ${gateId}, 'update', ${JSON.stringify({
        event: "delegated",
        actor: { kind: "user", userId: fromUserId },
        before: { assigneeUserId: gate.assigneeUserId },
        after: { assigneeUserId: toUserId, delegatedFromUserId: delegatedFrom, handoverNote },
        runId: gate.runId,
        flowId: gate.flowId,
        subjectKind: gate.subjectKind,
        subjectId: gate.subjectId,
      })}::jsonb, ${fromUserId})
    `);
  });
}

// --- Timers: reminders + escalation ---------------------------------------------

/**
 * Scan overdue gate timers — called from the 60s scheduler tick
 * (engine/src/scheduling/scheduler.ts), which runs org-less/bypass like the
 * user_scripts scan.
 *
 * Reminders: remind_at <= now, not yet reminded → acquire a session lease,
 * re-notify + email, then stamp reminded_at. The in-app notification id and
 * email job id are stable, so a crash after either effect can be retried.
 *
 * Escalations: escalate_at <= now, still pending → enqueue a scheduler_outbox
 * row. The outbox runner resolves the frozen tenant-authored escalateTo recipients; org
 * admins), inserts replacement pending rows, and flips the overdue row to
 * 'escalated'. A thrown hop stays failed with a reason for retry.
 */
export async function processGateTimers(
  now: Date = new Date(),
  notifyReminder: (gate: GateRow) => Promise<void> = (gate) => notifyGateAssignee(gate, "reminder"),
): Promise<{
  reminded: number;
  escalated: number;
}> {
  let reminded = 0;
  let escalated = 0;

  // --- Reminders -----------------------------------------------------------
  // Timer discovery and the claim span organizations and cross an explicit
  // trusted boundary; notifying the assignee then runs inside the gate's own
  // tenant. A scheduler tick holds no request store, so without these the
  // connection layer denies by default and no reminder ever fires.
  // bypass: scheduler-tick — due gate reminders are found across every production organization.
  const dueReminders = await withBypassContext(() =>
    db.execute<{ id: string; orgId: string }>(
      sql`
    select gate.id, gate.org_id as "orgId" from flow_gates gate
      join orgs organization on organization.id = gate.org_id
     where gate.status = 'pending' and gate.remind_at is not null and gate.remind_at <= ${now}
       and gate.reminded_at is null and organization.env_kind = 'production'
       -- Registry fallback shape (non-boolean stored values fall back to the
       -- default instead of throwing 22P02).
       and case (organization.settings->'features'->>'flows') when 'true' then true when 'false' then false else true end
     order by gate.remind_at
     limit 200
  `,
      "objects",
    ),
  );

  for (const { id, orgId } of dueReminders) {
    const client = await pool.connect();
    const lockKey = `openbooks:flow-gate-reminder:${orgId}:${id}`;
    let locked = false;
    let discardClient: Error | undefined;
    try {
      let lock;
      try {
        lock = await client.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
          [lockKey],
        );
      } catch (error) {
        discardClient = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
      locked = lock.rows[0]?.locked === true;
      if (!locked) continue;

      // The session lock is the recoverable lease. Do not make the durable
      // completion stamp until the notification effect has returned: a dead
      // process releases this lock and the still-due reminder is rediscovered.
      const [gate] = await withOrgContext(orgId, () =>
        db
          .select()
          .from(schema.flowGates)
          .where(
            and(
              eq(schema.flowGates.id, id),
              eq(schema.flowGates.orgId, orgId),
              eq(schema.flowGates.status, "pending"),
              sql`${schema.flowGates.remindAt} <= ${now}`,
              sql`${schema.flowGates.remindedAt} is null`,
            ),
          ),
      );
      if (!gate) continue;

      await withOrgContext(gate.orgId, () => notifyReminder(gate));
      const completed = await withOrgContext(orgId, () =>
        db.execute<Record<string, unknown>>(sql`
        update flow_gates set reminded_at = ${now}
         where id = ${id} and org_id = ${orgId} and status = 'pending'
           and remind_at <= ${now} and reminded_at is null
         returning id
      `),
      );
      if (completed.rowCount) reminded++;
    } catch (e) {
      console.error(`[flows] gate ${id} reminder failed:`, e);
      // The completion stamp has not been written, so the next scan can retry.
    } finally {
      if (locked) {
        try {
          await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
        } catch (error) {
          // A broken connection is discarded by pg, releasing its session lock.
          discardClient = error instanceof Error ? error : new Error(String(error));
        }
      }
      client.release(discardClient);
    }
  }

  // --- Escalations -----------------------------------------------------------
  // Enqueue a durable outbox row per due gate. The runner claims that row;
  // a throw leaves status=failed + error so the next tick retries.
  // bypass: scheduler-tick — due gate escalations are found across every production organization.
  const dueEscalations = await withBypassContext(() =>
    db.execute<{ id: string; orgId: string }>(
      sql`
    select gate.id, gate.org_id as "orgId" from flow_gates gate
      join orgs organization on organization.id = gate.org_id
     where gate.status = 'pending' and gate.escalate_at is not null and gate.escalate_at <= ${now}
       and organization.env_kind = 'production'
       -- Registry fallback shape (non-boolean stored values fall back to the
       -- default instead of throwing 22P02).
       and case (organization.settings->'features'->>'flows') when 'true' then true when 'false' then false else true end
     order by gate.escalate_at
     limit 100
  `,
      "objects",
    ),
  );

  for (const { id, orgId } of dueEscalations) {
    await withOrgContext(orgId, () => enqueueApprovalEscalation({ orgId, gateId: id }));
    escalated++;
  }

  return { reminded, escalated };
}

async function notifyGateAssignee(gate: GateRow, kind: "reminder" | "escalation"): Promise<void> {
  if (!gate.assigneeUserId) return;
  const assignee = await verifyUser(gate.orgId, gate.assigneeUserId);
  if (!assignee) return;
  const adapter = getFlowAdapter(gate.subjectKind);
  const subject = adapter ? await adapter.loadContext(gate.subjectId) : null;
  const subjectLabel =
    adapter && subject ? adapter.label(gate.subjectId, subject.values) : gate.subjectKind;

  const notification = db.insert(schema.notifications).values({
    ...(kind === "reminder" ? { id: gateReminderNotificationId(gate, assignee.id) } : {}),
    orgId: gate.orgId,
    userId: assignee.id,
    kind: "approval",
    title:
      kind === "reminder"
        ? `Reminder — approval pending: ${gate.title}`
        : `Escalated approval: ${gate.title}`,
    body: subjectLabel,
    href: "/inbox",
  });
  if (kind === "reminder") {
    // This PK collision is expected only when a reminder retries after its
    // inbox row committed but before the gate completion stamp.
    await notification.onConflictDoNothing({ target: schema.notifications.id });
  } else {
    await notification;
  }

  try {
    const emails = await import("@openbooks/emails");
    const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, gate.orgId));
    const brand = org?.name ?? "OpenBooks";
    const mail =
      kind === "reminder"
        ? emails.flowApprovalReminderEmail({
            orgName: brand,
            gateTitle: gate.title,
            subjectLabel,
            // One-click signed decision links (email-tokens.ts) — bound to
            // this gate row + this assignee, 72-hour expiry.
            ...emailActionUrls(gate.id, assignee.id),
          })
        : emails.flowApprovalEscalationEmail({
            orgName: brand,
            gateTitle: gate.title,
            subjectLabel,
          });
    // A gate row can be reminded and escalated at most once. Its durable row
    // identity therefore names the send obligation and deduplicates a retry
    // after Redis accepted the email but the scheduler lost its reply.
    const emailIntentKey = `gate-${kind}|${gate.orgId}|${gate.id}|${assignee.id}`;
    await enqueueFlowEmail({
      orgId: gate.orgId,
      runId: gate.runId,
      occurrenceKey: emailIntentKey,
      payload: {
        to: [assignee.email],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        meta: { category: "approvals" },
      },
    });
  } catch (e) {
    console.error(`[flows] gate ${gate.id} ${kind} email enqueue failed:`, e);
  }
}

/** Stable inbox effect identity for retries after a reminder worker crash. */
function gateReminderNotificationId(gate: GateRow, assigneeId: string): string {
  const bytes = createHash("sha256")
    .update(`openbooks.flow-gate-reminder.v1\0${gate.orgId}\0${gate.id}\0${assigneeId}`)
    .digest()
    .subarray(0, 16);
  // Format the digest as a standards-shaped UUID so the identity fits the
  // notifications primary key without introducing another persistence table.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Escalate one overdue pending gate: resolve the replacement assignees FIRST,
 * then atomically flip the row to 'escalated' and insert the replacements. If
 * nothing resolves, org admins are notified once (escalate_at clears so the
 * scan does not hammer) and the row stays pending.
 */
export async function escalateDueGate(gateId: string, now: Date = new Date()): Promise<boolean> {
  return escalateGate(gateId, now);
}

async function escalateGate(gateId: string, now: Date): Promise<boolean> {
  // Called from the contextless scheduler tick with only a gate id: this probe
  // discovers WHICH tenant owns it, so it crosses a trusted boundary. Every
  // subsequent read and write happens inside that tenant's `withOrg` below.
  // bypass: scheduler-tick — the tick holds only a gate id; this probe discovers which organization owns it.
  const pre = await withBypassContext(() => loadGate(gateId));
  if (!pre || pre.status !== "pending") return false;

  // Serialize against decisions and cancellations for every policy on this subject:
  // an escalation and a decision can never interleave, so replacement rows
  // inserted here are always visible to a concurrent quorum resolution (and a
  // decision that resolves the node first leaves nothing here to escalate).
  return withOrg(pre.orgId, async () => {
    await lockApprovalSubject(pre.orgId, pre.subjectKind, pre.subjectId);
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${pre.runId}))`);
    const gate = await loadGate(gateId, pre.orgId);
    if (!gate || gate.status !== "pending") return false;
    if (!(await hasLiveApprovalRun(gate))) return false;

    const adapter = getFlowAdapter(gate.subjectKind);
    const subject = adapter ? await adapter.loadContext(gate.subjectId) : null;
    const nodeGate = await gateNodeData(gate.orgId, gate.flowId, gate.nodeId, gate.runId);

    const submitterUserId = subject?.submitterUserId ?? null;
    const values = subject?.values ?? {};
    const targetCtx = { orgId: gate.orgId, submitterUserId, values };

    // Escalation recipients are authored in the frozen gate policy. Missing
    // recipients keep the original gate pending and notify administrators.
    const sodApplies = !nodeGate || nodeGate.preventSelfApproval !== false;
    const author = (
      await db.execute<{ created_by: string | null }>(
        sql`select created_by from flow_runs where org_id=${gate.orgId} and id=${gate.runId}`,
        "objects",
      )
    )[0]?.created_by;
    const blocked = await resolveSodBlockedIds(gate.orgId, subject ?? null, author ? [author] : []);
    const existingAssignees = new Set(
      (
        await db
          .select({ assigneeUserId: schema.flowGates.assigneeUserId })
          .from(schema.flowGates)
          .where(
            and(
              eq(schema.flowGates.orgId, gate.orgId),
              eq(schema.flowGates.runId, gate.runId),
              eq(schema.flowGates.nodeId, gate.nodeId),
            ),
          )
      ).flatMap(({ assigneeUserId }) => (assigneeUserId ? [assigneeUserId] : [])),
    );
    const eligible = (users: ResolvedUser[]) =>
      users.filter(
        (user) => !existingAssignees.has(user.id) && !(sodApplies && blocked.has(user.id)),
      );
    let replacements = nodeGate?.escalateTo
      ? eligible(await resolveAssigneeUsers([nodeGate.escalateTo], targetCtx))
      : [];
    const authorized: ResolvedUser[] = [];
    for (const user of replacements) {
      if (await hasGateDecisionAuthority(gate, user.id)) authorized.push(user);
    }
    replacements = authorized;
    if (replacements.length === 0) {
      // Unresolvable: tell the admins, stop re-scanning, keep the gate actionable.
      await db.execute(sql`
      update flow_gates set escalate_at = null, updated_at = now() where id = ${gateId} and org_id = ${gate.orgId} and status = 'pending'
    `);
      const admins = await roleUsers(gate.orgId, GATE_ADMIN_ROLE);
      if (admins.length > 0) {
        await db.insert(schema.notifications).values(
          admins.map((u) => ({
            orgId: gate.orgId,
            userId: u.id,
            kind: "approval",
            title: `Overdue approval could not be escalated: ${gate.title}`,
            body: "No configured escalation recipient has current approval authority for this record. Review the Flow assignment and native role permissions.",
            href: "/inbox",
          })),
        );
      }
      return false;
    }

    // Claim: pending → escalated (concurrent ticks race on this update).
    const claimed = await db.execute<never>(sql`
    update flow_gates set status = 'escalated', updated_at = now()
     where id = ${gateId} and org_id = ${gate.orgId} and status = 'pending'
  `);
    if (!claimed.rowCount) return false;
    // The original assignee is no longer asked; their request notice resolves.
    await resolveApprovalRequestNotices(gate.orgId, gate.subjectKind, gate.subjectId);

    await db
      .insert(schema.flowGates)
      .values(
        replacements.map((u) => ({
          orgId: gate.orgId,
          flowId: gate.flowId,
          runId: gate.runId,
          nodeId: gate.nodeId,
          subjectKind: gate.subjectKind,
          subjectId: gate.subjectId,
          title: gate.title,
          assigneeUserId: u.id,
          groupKey: gate.groupKey,
          quorum: gate.quorum,
          status: "pending" as const,
          signatureRequired: gate.signatureRequired,
          escalatedFromGateId: gate.id,
          // Replacement rows get no further escalation hop (no chains/loops);
          // a reminder still fires if the node configured one.
          remindAt: nodeGate?.reminderAfterHours
            ? new Date(now.getTime() + nodeGate.reminderAfterHours * 3_600_000)
            : null,
          escalateAt: null,
        })),
      )
      // A repeated replacement assignee retains its existing gate and decision state.
      .onConflictDoNothing();

    // Durable routing evidence, part of the same atomic unit: the scheduler
    // seats new approvers with no human actor, so the before/after must carry
    // a system identity — a null actor_id that never impersonates a user. An
    // audit failure rolls the escalation back with it.
    await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${gate.orgId}, 'flow_gates', ${gateId}, 'update', ${JSON.stringify({
      event: "escalated",
      actor: { kind: "system", reason: "overdue-approval-escalation" },
      before: { status: "pending", assigneeUserId: gate.assigneeUserId },
      after: { status: "escalated", replacementAssigneeUserIds: replacements.map((u) => u.id) },
      runId: gate.runId,
      flowId: gate.flowId,
      subjectKind: gate.subjectKind,
      subjectId: gate.subjectId,
    })}::jsonb, null)
  `);

    // Notify each replacement (fetch the fresh rows so notifyGateAssignee has
    // real gate rows — also skips any that already existed via onConflict).
    const fresh = await db
      .select()
      .from(schema.flowGates)
      .where(
        and(
          eq(schema.flowGates.orgId, gate.orgId),
          eq(schema.flowGates.runId, gate.runId),
          eq(schema.flowGates.nodeId, gate.nodeId),
          eq(schema.flowGates.status, "pending"),
          inArray(
            schema.flowGates.assigneeUserId,
            replacements.map((u) => u.id),
          ),
        ),
      );
    for (const row of fresh) {
      await notifyGateAssignee(row, "escalation");
    }
    return true;
  });
}

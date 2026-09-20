import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { planFromGate, type GateData } from "@openbooks/forms-core";
import { db, schema, withOrg, withBypassContext, withOrgContext, withTransactionSavepoint } from "../platform/db.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { getFlowAdapter } from "./registry.ts";
import { executeFlowPlan } from "./execute.ts";
import { parseFlowGraph } from "./run.ts";
import { resolveQuorumOutcome, type SiblingGate } from "./quorum.ts";
import {
  resolveAssigneeUsers,
  roleUsers,
  userRoleKeys,
  verifyUser,
  supervisorOf,
  type ResolvedUser,
} from "./targets.ts";
import { activeDelegationPrincipal, activeDelegationPrincipals } from "./delegations.ts";
import { emailActionUrls } from "./email-tokens.ts";

/**
 * Gate lifecycle — decide / worklist / delegate / timers. OpenBooks resumes
 * in process: the decide is an atomic conditional UPDATE (pending → decided,
 * so two concurrent approvals can never both resume the branch), quorum
 * evaluation (quorum.ts) picks the branch, and planFromGate → executeFlowPlan
 * re-runs on the SAME runId — flow_run_effects checkpoints keep earlier nodes
 * from double-firing.
 *
 * Reminders still stamp flow_gates.reminded_at. Escalations enqueue a durable
 * scheduler_outbox row (claim / fail with reason / backoff) so a crash cannot
 * drop the hop.
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
  return subsidiaryId !== null && subsidiaryId !== undefined && subsidiaryId !== ""
    && allowedSubsidiaryIds.has(subsidiaryId);
}

export class GateError extends Error {}

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
export class DecisionFailedError extends GateError {
  /** False when the cause is a defect (a TypeError and its kin): retrying replays it. */
  readonly retryable: boolean;
  constructor(args: { decision: "approved" | "rejected"; stage: string; cause: string; retryable?: boolean }) {
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
  }
}

/**
 * A thrown value that can only come from broken code, never from data: a
 * remedy that says "retry" for these invites an infinite loop on an
 * approval. Everything else (adapter refusals, storage errors) stays
 * retryable because the next attempt may genuinely succeed.
 */
export function isProgrammingError(e: unknown): boolean {
  return e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError;
}

/**
 * A release failure — the adapter threw while releasing the subject. Kept as
 * a named subclass so callers can distinguish the stage; the contract is the
 * unified one above (nothing recorded, retry the decision).
 */
export class ReleaseError extends DecisionFailedError {
  constructor(decision: "approved" | "rejected", cause: string, retryable = true) {
    super({ decision, stage: "release", cause, retryable });
    this.name = "ReleaseError";
  }
}

/** Roles that may act on any gate in the org (matches web admin semantics). */
const GATE_ADMIN_ROLE = "admin";

async function loadGate(gateId: string, orgId?: string): Promise<GateRow | null> {
  const [gate] = await db.select().from(schema.flowGates).where(
    orgId
      ? and(eq(schema.flowGates.id, gateId), eq(schema.flowGates.orgId, orgId))
      : eq(schema.flowGates.id, gateId),
  );
  return gate ?? null;
}

async function canActOnGate(gate: GateRow, userId: string): Promise<boolean> {
  // A deactivated user decides nothing — not even through a still-valid
  // one-click email link (the sessionless path has no other activity check).
  // verifyUser is org-scoped, so a foreign user id fails here too.
  if (!(await verifyUser(gate.orgId, userId))) return false;
  if (gate.assigneeUserId === userId) return true;
  const roles = await userRoleKeys(gate.orgId, userId);
  if (roles.has(GATE_ADMIN_ROLE)) return true;
  return !!gate.assigneeRole && roles.has(gate.assigneeRole);
}

/**
 * Resolve the legal entity behind a gate subject. Flow gates are polymorphic:
 * documents (including pay runs and field tickets) carry their own subsidiary,
 * while bank-account and timesheet approvals inherit it from their party.
 * Unknown/non-entity subjects intentionally return null so a restricted
 * caller cannot decide a gate whose legal-entity ownership is not provable.
 */
async function gateSubjectSubsidiaryId(gate: Pick<GateRow, "subjectKind" | "subjectId" | "orgId">): Promise<string | null> {
  const r = await db.execute<{ subsidiaryId: string | null }>(sql`
    select case
             when g.subject_kind = 'financial_change' then (
               select fc.subsidiary_id from financial_changes fc where fc.id=g.subject_id and fc.org_id=g.org_id
             )
             when g.subject_kind = 'party_bank_account' then (
               select p.subsidiary_id
                 from party_bank_accounts ba
                 join parties p on p.id = ba.party_id and p.org_id = ba.org_id
                where ba.id = g.subject_id and ba.org_id = g.org_id
             )
             when g.subject_kind = 'timesheet_week' then (
               select p.subsidiary_id
                 from timesheet_weeks tw
                 join parties p on p.id = tw.employee_party_id and p.org_id = tw.org_id
                where tw.id = g.subject_id and tw.org_id = g.org_id
             )
             else d.subsidiary_id
           end as "subsidiaryId"
      from flow_gates g
      left join documents d
        on d.id = g.subject_id and d.org_id = g.org_id and d.kind = g.subject_kind
     where g.subject_kind = ${gate.subjectKind}
       and g.subject_id = ${gate.subjectId}
       and g.org_id = ${gate.orgId}
     limit 1
  `);
  return r.rows[0]?.subsidiaryId ?? null;
}

async function assertGateSubsidiaryScope(
  gate: Pick<GateRow, "subjectKind" | "subjectId" | "orgId">,
  allowedSubsidiaryIds: GateSubsidiaryScope,
): Promise<void> {
  if (allowedSubsidiaryIds == null) return;
  if (gate.subjectKind === "financial_change") {
    const required = (
      await db.execute<{ ids: string[] }>(
        sql`select coalesce(payload->'requiredSubsidiaryIds',jsonb_build_array(subsidiary_id)) as ids from financial_changes where org_id=${gate.orgId} and id=${gate.subjectId}`,
      )
    ).rows[0]?.ids;
    if (!required || required.some((id) => !allowedSubsidiaryIds.has(id)))
      throw new GateError("approval not found");
  }
  const subsidiaryId = await gateSubjectSubsidiaryId(gate);
  if (!gateSubsidiaryScopeAllows(allowedSubsidiaryIds, subsidiaryId)) {
    throw new GateError("approval not found");
  }
}

/** Viewer-aware decision capability for contextual record drawers. */
export async function gateDecisionCapability(
  gateId: string,
  userId: string,
): Promise<{ canAct: boolean; signatureRequired: boolean }> {
  const gate = await loadGate(gateId);
  if (!gate || gate.status !== "pending") {
    return { canAct: false, signatureRequired: false };
  }
  let authorized = await canActOnGate(gate, userId);
  if (!authorized && gate.assigneeUserId) {
    authorized =
      (await activeDelegationPrincipal(gate.orgId, gate.assigneeUserId, userId)) !== null;
  }
  if (!authorized) {
    return { canAct: false, signatureRequired: gate.signatureRequired };
  }
  const adapter = getFlowAdapter(gate.subjectKind);
  const submitterUserId =
    (await adapter?.loadContext(gate.subjectId))?.submitterUserId ?? null;
  if (submitterUserId === userId) {
    const node = await gateNodeData(gate.orgId, gate.flowId, gate.nodeId);
    if (
      adapter?.selfApprovalPolicy === "forbidden" ||
      !node ||
      node.preventSelfApproval !== false
    ) {
      return { canAct: false, signatureRequired: gate.signatureRequired };
    }
  }
  return { canAct: true, signatureRequired: gate.signatureRequired };
}

/** The gate node's authored GateData, for escalation targets. */
async function gateNodeData(orgId: string, flowId: string, nodeId: string): Promise<GateData | null> {
  const [flow] = await db.select().from(schema.flows).where(and(eq(schema.flows.id, flowId), eq(schema.flows.orgId, orgId)));
  if (!flow) return null;
  const graph = parseFlowGraph(flow.id, flow.graph);
  if (!graph) return null;
  const node = graph.nodes.find((n) => n.id === nodeId);
  return node && node.data.kind === "gate" ? node.data.gate : null;
}

/** Recompute a run's status once gates move: waiting | completed | failed. */
async function finalizeRunStatus(runId: string, orgId: string, hadFailure: boolean, error?: string | null): Promise<void> {
  const pending = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from flow_gates where run_id = ${runId} and org_id = ${orgId} and status in ('pending', 'escalated')
  `));
  const stillWaiting = (pending.rows[0]?.n ?? 0) > 0;
  const status = hadFailure ? "failed" : stillWaiting ? "waiting" : "completed";
  await db
    .update(schema.flowRuns)
    .set({
      status,
      error: hadFailure ? error ?? "gate branch failed" : null,
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
  return decideGateCore(args);
}

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
  if (!(await canActOnGate(pre, userId))) {
    onBehalfOf = pre.assigneeUserId
      ? await activeDelegationPrincipal(pre.orgId, pre.assigneeUserId, userId)
      : null;
    if (!onBehalfOf) throw new GateError("you are not an approver for this gate");
  }

  // Separation of duties, enforced at DECISION time (not just gate creation):
  // the record's submitter may never decide their own approval — closing the
  // admin / later-role-grant / delegated-actor bypasses. Secure by default;
  // only an explicit preventSelfApproval:false on the gate node opts out.
  const preAdapter = getFlowAdapter(pre.subjectKind);
  const submitterUserId =
    (await preAdapter?.loadContext(pre.subjectId))?.submitterUserId ?? null;
  if (submitterUserId && submitterUserId === userId) {
    const node = await gateNodeData(pre.orgId, pre.flowId, pre.nodeId);
    if (
      preAdapter?.selfApprovalPolicy === "forbidden" ||
      !node ||
      node.preventSelfApproval !== false
    ) {
      throw new GateError("you cannot approve your own submission");
    }
  }

  // -- Serialized decision: one xact lock per run holds through the flip →
  // quorum → cancel → resume → release sequence, so concurrent deciders can
  // never both resume (double-post) and the whole decision is atomic (a crash
  // rolls back to a still-pending gate, safely re-decidable). ----------------
  return withOrg(pre.orgId, async () => {
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
        .where(and(eq(schema.flowGates.id, gateId), eq(schema.flowGates.orgId, pre.orgId), eq(schema.flowGates.status, "pending")))
        .returning({ id: schema.flowGates.id });
      if (decided.length === 0) throw new GateError("this approval was already resolved");

      // Quorum over the sibling rows of this gate node instance.
      const siblings = (await db
        .select({ id: schema.flowGates.id, status: schema.flowGates.status })
        .from(schema.flowGates)
        .where(
          and(eq(schema.flowGates.runId, gate.runId), eq(schema.flowGates.orgId, gate.orgId), eq(schema.flowGates.groupKey, gate.groupKey)),
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
      `)

      if (!outcome.resume) {
        // 'all' quorum still collecting approvals — the run keeps waiting.
        return { ok: true, resumed: null, runStatus: "waiting" };
      }

      // --- Resume the decided branch on the SAME run -------------------------
      const [flow] = await db.select().from(schema.flows).where(and(eq(schema.flows.id, gate.flowId), eq(schema.flows.orgId, gate.orgId)));
      const adapter = getFlowAdapter(gate.subjectKind);
      if (!flow || !adapter) {
        throw new DecisionFailedError({
          decision,
          stage: "resume",
          cause: "flow definition or subject adapter is unavailable",
        });
      }
      const graph = parseFlowGraph(flow.id, flow.graph);
      if (!graph) {
        throw new DecisionFailedError({
          decision,
          stage: "resume",
          cause: "flow graph failed validation",
        });
      }

      const ctx: FlowExecCtx = { orgId: gate.orgId, userId };
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
      // This makes an authored post_document action consume an APPROVED record;
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
      const release = adapter.releaseApproval;
      let releasedBeforeActions = false;
      if (
        subject &&
        outcome.resume === "approve" &&
        release &&
        (await subjectOpenGateCount(gate.orgId, gate.subjectKind, gate.subjectId)) === 0
      ) {
        try {
          await release(gate.subjectId, "approved", ctx, {
            comment: args.comment?.trim() || null,
          });
          releasedBeforeActions = true;
        } catch (e) {
          throw new ReleaseError(decision, e instanceof Error ? e.message : String(e), !isProgrammingError(e));
        }
      }

      let hadFailure = false;
      let error: string | null = null;
      if (!subject) {
        hadFailure = true;
        error = "subject record no longer exists";
      } else {
        const evalCtx = { values: { ...subject.values }, rows: subject.rows ?? {} };
        const plan = planFromGate(graph, gate.nodeId, outcome.resume, evalCtx);
        if (plan.actionNodes.length > 0 || plan.gates.length > 0) {
          const res = await executeFlowPlan(ctx, adapter, {
            flow: { id: flow.id, name: flow.name, subjectKind: gate.subjectKind, graph: flow.graph },
            runId: gate.runId,
            subjectId: gate.subjectId,
            plan,
            evalCtx,
            submitterUserId: subject.submitterUserId,
          });
          hadFailure = res.failed.length > 0;
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
            await cancelSubjectApprovals(gate.orgId, gate.subjectKind, gate.subjectId);
            await release(gate.subjectId, "rejected", ctx, {
              comment: args.comment?.trim() || null,
            });
          } else if (
            !releasedBeforeActions &&
            (await subjectOpenGateCount(gate.orgId, gate.subjectKind, gate.subjectId)) === 0
          ) {
            await release(gate.subjectId, "approved", ctx, {
              comment: args.comment?.trim() || null,
            });
          }
        } catch (e) {
          throw new ReleaseError(decision, e instanceof Error ? e.message : String(e), !isProgrammingError(e));
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
        });
      }
      await finalizeRunStatus(gate.runId, gate.orgId, hadFailure, error);
      const runStatus =
        ((await db.select({ status: schema.flowRuns.status }).from(schema.flowRuns).where(and(eq(schema.flowRuns.id, gate.runId), eq(schema.flowRuns.orgId, gate.orgId))))[0]
          ?.status as "waiting" | "completed") ?? "completed";
      return { ok: true, resumed: outcome.resume, runStatus };
    });
  });
}

/** Open (pending/escalated) gate rows for a subject across ALL its runs. */
async function subjectOpenGateCount(
  orgId: string,
  subjectKind: string,
  subjectId: string,
): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from flow_gates
     where org_id = ${orgId} and subject_kind = ${subjectKind} and subject_id = ${subjectId}
       and status in ('pending', 'escalated')
  `));
  return r.rows[0]?.n ?? 0;
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
): Promise<void> {
  const cancelled = await db
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
  const runIds = [...new Set(cancelled.map((r) => r.runId))];
  for (const runId of runIds) {
    await db
      .update(schema.flowRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, orgId), inArray(schema.flowRuns.status, ["running", "waiting"])));
  }
}

/**
 * "Your vendor bill BILL-0042 was approved by Jane" — in-app notification +
 * email to the run's submitter once a gate node's quorum resolves (not on
 * partial 'all' approvals). The rejection reason rides along when given.
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
  const byName = decider?.name ?? "an approver";
  const title = `Your ${subjectLabel} was ${verb} by ${byName}`;
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
    const { enqueueFlowEmail } = await import("../scheduling/outbox.ts");
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
    href: row.closePeriodName ? `/close?run=${String(row.subjectId)}&stage=lock` : null,
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
           case when cp.name is not null then cp.name || ' close' else null end as "subjectLabel"
      from flow_gates g
      left join documents d on d.id = g.subject_id and d.org_id = g.org_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join close_runs cr on cr.id = g.subject_id and cr.org_id = g.org_id and g.subject_kind = 'close_run'
      left join accounting_periods cp on cp.id = cr.period_id and cp.org_id = cr.org_id`;

/**
 * Pending gates the user may act on: assigned to them directly, to a role
 * they hold, or — flagged with `onBehalfOf` — assigned to a principal who has
 * an ACTIVE delegation window pointing at them (out-of-office coverage).
 * `roles` defaults to the user's resolved role keys.
 */
/**
 * Fill in the legal entity behind worklist rows whose subject is not a
 * document (timesheet weeks inherit it from the employee party, bank-account
 * approvals from theirs). Batched per subject kind; subjects with no
 * resolvable entity keep null so restricted callers fail closed on them.
 */
async function resolveWorklistSubsidiaries(orgId: string, gates: WorklistGate[]): Promise<void> {
  const missing = gates.filter((g) => g.subsidiaryId == null);
  if (missing.length === 0) return;
  const idsFor = (kind: string): string[] => [
    ...new Set(missing.filter((g) => g.subjectKind === kind).map((g) => g.subjectId)),
  ];
  const apply = (rows: Array<{ id: string; subsidiaryId: string | null }>) => {
    const byId = new Map(rows.map((r) => [r.id, r.subsidiaryId]));
    for (const g of missing) {
      if (byId.has(g.subjectId)) g.subsidiaryId = byId.get(g.subjectId) ?? null;
    }
  };
  const changes = idsFor("financial_change");
  if (changes.length > 0) {
    const result = await db.execute<{id:string;subsidiaryId:string}>(sql`
      select id,subsidiary_id as "subsidiaryId" from financial_changes where org_id=${orgId}
        and id in (select jsonb_array_elements_text(${JSON.stringify(changes)}::jsonb)::uuid)
    `);
    apply(result.rows);
  }
  const timesheets = idsFor("timesheet_week");
  if (timesheets.length > 0) {
    const r = await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
      select tw.id, p.subsidiary_id as "subsidiaryId"
        from timesheet_weeks tw
        join parties p on p.id = tw.employee_party_id and p.org_id = tw.org_id
       where tw.org_id = ${orgId}
         and tw.id in (select jsonb_array_elements_text(${JSON.stringify(timesheets)}::jsonb)::uuid)
    `);
    apply(r.rows);
  }
  const bankAccounts = idsFor("party_bank_account");
  if (bankAccounts.length > 0) {
    const r = await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
      select ba.id, p.subsidiary_id as "subsidiaryId"
        from party_bank_accounts ba
        join parties p on p.id = ba.party_id and p.org_id = ba.org_id
       where ba.org_id = ${orgId}
         and ba.id in (select jsonb_array_elements_text(${JSON.stringify(bankAccounts)}::jsonb)::uuid)
    `);
    apply(r.rows);
  }
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
  kind?: string;
}

/**
 * SQL pre-filter reproducing gateSubsidiaryScopeAllows for the rows the
 * documents join already carries an entity for. Non-document subjects
 * (d.id is null) pass through to resolveWorklistSubsidiaries + the JS filter
 * below, exactly as before — the predicate drops in SQL only what the JS
 * filter would drop, so full and paged reads return the same rows.
 */
function worklistGateScopeSql(allowedSubsidiaryIds: GateSubsidiaryScope): SQL {
  if (allowedSubsidiaryIds == null) return sql``;
  const ids = JSON.stringify([...allowedSubsidiaryIds]);
  return sql`and (
    (d.id is null and g.subject_kind <> 'financial_change')
    or d.subsidiary_id in (select jsonb_array_elements_text(${ids}::jsonb)::uuid)
    or (g.subject_kind='financial_change' and exists (
      select 1 from financial_changes fc where fc.org_id=g.org_id and fc.id=g.subject_id
      and fc.subsidiary_id in (select jsonb_array_elements_text(${ids}::jsonb)::uuid)
      and not exists(select 1 from jsonb_array_elements_text(coalesce(fc.payload->'requiredSubsidiaryIds','[]'::jsonb)) required(id) where required.id not in(select jsonb_array_elements_text(${ids}::jsonb)))
    ))
  )`;
}

function worklistGateKindSql(kind: string | undefined): SQL {
  if (kind == null) return sql``;
  return sql`and coalesce(d.kind, g.subject_kind) = ${kind}`;
}

function worklistDirectWhere(
  orgId: string,
  userId: string,
  roleList: string[],
  allowedSubsidiaryIds: GateSubsidiaryScope,
  kind: string | undefined,
): SQL {
  return sql`g.org_id = ${orgId} and g.status = 'pending'
    and (g.assignee_user_id = ${userId}
         or (g.assignee_role is not null and g.assignee_role in
              (select jsonb_array_elements_text(${JSON.stringify(roleList)}::jsonb))))
    ${worklistGateScopeSql(allowedSubsidiaryIds)}
    ${worklistGateKindSql(kind)}`;
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
  const roleList = roles ? [...roles] : [...(await userRoleKeys(orgId, userId))];
  const kind = page?.kind;
  // The id tiebreaker pins page boundaries: without a unique order key
  // Postgres may return tied rows in any order and rows duplicate or drop
  // across pages (same rule as the document list order clause).
  const r = (await db.execute<Record<string, unknown>>(sql`
    ${WORKLIST_SELECT}
     where ${worklistDirectWhere(orgId, userId, roleList, allowedSubsidiaryIds, kind)}
     order by g.created_at, g.id
     ${page ? sql`limit ${page.prefix}` : sql``}
  `));
  const out = r.rows.map((row) => mapWorklistRow(row, null));

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
    const d = (await db.execute<Record<string, unknown>>(sql`
      ${WORKLIST_SELECT}
       where g.org_id = ${orgId} and g.status = 'pending'
         and g.assignee_user_id in
              (select jsonb_array_elements_text(${JSON.stringify(principals.map((p) => p.id))}::jsonb)::uuid)
         ${worklistGateScopeSql(allowedSubsidiaryIds)}
         ${worklistGateKindSql(kind)}
       order by g.created_at, g.id
    `));
    for (const row of d.rows) {
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
  await resolveWorklistSubsidiaries(orgId, out);
  if (allowedSubsidiaryIds != null) {
    return out.filter((g) => gateSubsidiaryScopeAllows(allowedSubsidiaryIds, g.subsidiaryId));
  }
  return out;
}

/**
 * Per-kind totals for the gate leg under the exact predicates worklistGates
 * applies (direct + delegated-minus-direct, scope, kind). The approvals page
 * derives its total and kind chips from these aggregates instead of counting
 * fetched rows, so the counts stay exact while the rows stay windowed.
 */
export async function worklistGateKindCounts(
  orgId: string,
  userId: string,
  roles?: Iterable<string>,
  allowedSubsidiaryIds?: GateSubsidiaryScope,
  kind?: string,
): Promise<Map<string, number>> {
  const roleList = roles ? [...roles] : [...(await userRoleKeys(orgId, userId))];
  const counts = new Map<string, number>();
  const accumulate = (rows: Array<{ kind: string; n: string }>) => {
    for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + Number(row.n));
  };
  const baseJoins = sql`
      from flow_gates g
      left join documents d on d.id = g.subject_id and d.org_id = g.org_id`;
  accumulate((await db.execute<{ kind: string; n: string }>(sql`
    select coalesce(d.kind, g.subject_kind) as kind, count(*) as n
      ${baseJoins}
     where ${worklistDirectWhere(orgId, userId, roleList, allowedSubsidiaryIds, kind)}
     group by coalesce(d.kind, g.subject_kind)
  `)).rows);
  const principals = await activeDelegationPrincipals(orgId, userId);
  if (principals.length > 0) {
    // Same dedup as the row merge, expressed as a predicate: a delegated row
    // satisfying the direct condition would already be counted above.
    accumulate((await db.execute<{ kind: string; n: string }>(sql`
      select coalesce(d.kind, g.subject_kind) as kind, count(*) as n
        ${baseJoins}
       where g.org_id = ${orgId} and g.status = 'pending'
         and g.assignee_user_id in
              (select jsonb_array_elements_text(${JSON.stringify(principals.map((p) => p.id))}::jsonb)::uuid)
         and not (g.assignee_user_id = ${userId}
              or (g.assignee_role is not null and g.assignee_role in
                   (select jsonb_array_elements_text(${JSON.stringify(roleList)}::jsonb))))
         ${worklistGateScopeSql(allowedSubsidiaryIds)}
         ${worklistGateKindSql(kind)}
       group by coalesce(d.kind, g.subject_kind)
    `)).rows);
  }
  return counts;
}

// --- Delegation ----------------------------------------------------------------

/**
 * Reassign a pending gate to another in-org user. Authorization: the current
 * assignee or an org admin. The hand-off is recorded in a STRUCTURED column
 * (delegated_from_user_id) — not a free-text comment marker — so the audit
 * survives the decision and can't be forged by typing into a comment.
 */
export async function delegateGate(gateId: string, fromUserId: string, toUserId: string): Promise<void> {
  const gate = await loadGate(gateId);
  if (!gate) throw new GateError("approval not found");
  if (gate.status !== "pending") throw new GateError("only a pending approval can be delegated");
  const roles = await userRoleKeys(gate.orgId, fromUserId);
  if (!(gate.assigneeUserId === fromUserId || roles.has(GATE_ADMIN_ROLE))) {
    throw new GateError("only the assignee or an admin can delegate this approval");
  }
  const to = await verifyUser(gate.orgId, toUserId);
  if (!to) throw new GateError("delegate target is not an active user in this org");
  // Preserve the ORIGINAL assignee (the first hand-off wins — a chain of
  // delegations still points back to who the gate was authored to).
  const delegatedFrom = gate.delegatedFromUserId ?? gate.assigneeUserId ?? fromUserId;

  // One atomic unit: the reassignment, the delegate's notice, and the audit
  // evidence commit together, so a hand-off that changes who may release the
  // document can never persist without its actor-attributed trail.
  await withOrg(gate.orgId, async () => {
    try {
      await db
        .update(schema.flowGates)
        .set({
          assigneeUserId: toUserId,
          delegatedFromUserId: delegatedFrom,
          updatedBy: fromUserId,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.flowGates.id, gateId), eq(schema.flowGates.orgId, gate.orgId), eq(schema.flowGates.status, "pending")));
    } catch (e) {
      // unique (run_id, node_id, assignee_user_id): the target already holds a
      // sibling row of this gate.
      throw new GateError(`could not delegate: ${(e as Error).message}`);
    }

    await db.insert(schema.notifications).values({
      orgId: gate.orgId,
      userId: toUserId,
      kind: "approval",
      title: `Approval delegated to you: ${gate.title}`,
      href: "/approvals",
    });

    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${gate.orgId}, 'flow_gates', ${gateId}, 'update', ${JSON.stringify({
        event: "delegated",
        actor: { kind: "user", userId: fromUserId },
        before: { assigneeUserId: gate.assigneeUserId },
        after: { assigneeUserId: toUserId, delegatedFromUserId: delegatedFrom },
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
 * Reminders: remind_at <= now, not yet reminded → re-notify + email, stamp
 * reminded_at (fires once; the stamp is the claim, released on notify failure
 * so the next tick retries).
 *
 * Escalations: escalate_at <= now, still pending → enqueue a scheduler_outbox
 * row. The outbox runner resolves escalateTo (fallback: supervisor, then org
 * admins), inserts replacement pending rows, and flips the overdue row to
 * 'escalated'. A thrown hop stays failed with a reason for retry.
 */
export async function processGateTimers(now: Date = new Date()): Promise<{
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
  const dueReminders = await withBypassContext(() =>
    db.execute<{ id: string; orgId: string }>(sql`
    select gate.id, gate.org_id as "orgId" from flow_gates gate
      join orgs organization on organization.id = gate.org_id
     where gate.status = 'pending' and gate.remind_at is not null and gate.remind_at <= ${now}
       and gate.reminded_at is null and organization.env_kind = 'production'
       and coalesce((organization.settings->'features'->>'flows')::boolean, true)
     order by gate.remind_at
     limit 200
  `));

  for (const { id, orgId } of dueReminders.rows) {
    // Claim via the reminded_at stamp so concurrent ticks fire once.
    const claimed = await withBypassContext(() =>
      db.execute(sql`
      update flow_gates set reminded_at = ${now}
       where id = ${id} and org_id = ${orgId} and status = 'pending' and reminded_at is null
    `));
    if (!claimed.rowCount) continue;
    const [gate] = await withBypassContext(() =>
      db.select().from(schema.flowGates).where(and(eq(schema.flowGates.id, id), eq(schema.flowGates.orgId, orgId))),
    );
    if (!gate) {
      // Claim set, row gone (or unreadable) — release so a later tick can
      // retry instead of silently retiring the reminder forever.
      await withBypassContext(() =>
        db.execute(sql`
        update flow_gates set reminded_at = null
         where id = ${id} and org_id = ${orgId} and status = 'pending' and reminded_at = ${now}
      `));
      continue;
    }
    try {
      await withOrgContext(gate.orgId, () => notifyGateAssignee(gate, "reminder"));
      reminded++;
    } catch (e) {
      console.error(`[flows] gate ${id} reminder failed:`, e);
      // Release the claim so the next tick retries — a failed notify must not
      // silence this gate's reminders forever. Conditional on the claimed
      // stamp: only the tick that set it may clear it, so a concurrent tick
      // (which saw the stamp and skipped) can never race a double-notify.
      await withBypassContext(() =>
        db.execute(sql`
        update flow_gates set reminded_at = null
         where id = ${id} and org_id = ${orgId} and status = 'pending' and reminded_at = ${now}
      `));
    }
  }

  // --- Escalations -----------------------------------------------------------
  // Enqueue a durable outbox row per due gate. The runner claims that row;
  // a throw leaves status=failed + error so the next tick retries.
  const { enqueueApprovalEscalation } = await import("../scheduling/outbox.ts");
  const dueEscalations = await withBypassContext(() =>
    db.execute<{ id: string; orgId: string }>(sql`
    select gate.id, gate.org_id as "orgId" from flow_gates gate
      join orgs organization on organization.id = gate.org_id
     where gate.status = 'pending' and gate.escalate_at is not null and gate.escalate_at <= ${now}
       and organization.env_kind = 'production'
       and coalesce((organization.settings->'features'->>'flows')::boolean, true)
     order by gate.escalate_at
     limit 100
  `));

  for (const { id, orgId } of dueEscalations.rows) {
    await withBypassContext(() => enqueueApprovalEscalation({ orgId, gateId: id }));
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

  await db.insert(schema.notifications).values({
    orgId: gate.orgId,
    userId: assignee.id,
    kind: "approval",
    title:
      kind === "reminder"
        ? `Reminder — approval pending: ${gate.title}`
        : `Escalated approval: ${gate.title}`,
    body: subjectLabel,
    href: "/approvals",
  });

  try {
    const [{ enqueueEmail }, emails] = await Promise.all([
      import("@openbooks/jobs"),
      import("@openbooks/emails"),
    ]);
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
        : emails.flowApprovalEscalationEmail({ orgName: brand, gateTitle: gate.title, subjectLabel });
    await enqueueEmail({
      orgId: gate.orgId,
      to: assignee.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      meta: { category: "approvals" },
    });
  } catch (e) {
    console.error(`[flows] gate ${gate.id} ${kind} email enqueue failed:`, e);
  }
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
  const pre = await withBypassContext(() => loadGate(gateId));
  if (!pre || pre.status !== "pending") return false;

  // Serialize with decisions on the same run via the shared per-run xact lock:
  // an escalation and a decision can never interleave, so replacement rows
  // inserted here are always visible to a concurrent quorum resolution (and a
  // decision that resolves the node first leaves nothing here to escalate).
  return withOrg(pre.orgId, async () => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${pre.runId}))`);
    const gate = await loadGate(gateId, pre.orgId);
    if (!gate || gate.status !== "pending") return false;

    const adapter = getFlowAdapter(gate.subjectKind);
    const subject = adapter ? await adapter.loadContext(gate.subjectId) : null;
  const nodeGate = await gateNodeData(gate.orgId, gate.flowId, gate.nodeId);

  const submitterUserId = subject?.submitterUserId ?? null;
  const values = subject?.values ?? {};
  const targetCtx = { orgId: gate.orgId, submitterUserId, values };

  // escalateTo → submitter's supervisor → org admins. Each stage skips the
  // submitter whenever separation of duties would block them (the same
  // predicate decideGate enforces): a replacement the submitter could never
  // decide would strand the gate — replacements carry escalateAt=null, so
  // nothing would ever re-fire it and the run would wait forever.
  const sodApplies =
    adapter?.selfApprovalPolicy === "forbidden" ||
    !nodeGate ||
    nodeGate.preventSelfApproval !== false;
  const eligible = (users: ResolvedUser[]) => users.filter((user) =>
    user.id !== gate.assigneeUserId &&
    !(sodApplies && submitterUserId && user.id === submitterUserId));
  let replacements = nodeGate?.escalateTo
    ? eligible(await resolveAssigneeUsers([nodeGate.escalateTo], targetCtx))
    : [];
  if (replacements.length === 0) {
    const sup = await supervisorOf(gate.orgId, submitterUserId);
    replacements = sup ? eligible([sup]) : [];
  }
  if (replacements.length === 0) {
    replacements = eligible(await roleUsers(gate.orgId, GATE_ADMIN_ROLE));
  }

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
          body: "No escalation target resolved — please review.",
          href: "/approvals",
        })),
      );
    }
    return false;
  }

  // Claim: pending → escalated (concurrent ticks race on this update).
  const claimed = (await db.execute(sql`
    update flow_gates set status = 'escalated', updated_at = now()
     where id = ${gateId} and org_id = ${gate.orgId} and status = 'pending'
  `));
  if (!claimed.rowCount) return false;

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
        // Replacement rows get no further escalation hop (no chains/loops);
        // a reminder still fires if the node configured one.
        remindAt: nodeGate?.reminderAfterHours
          ? new Date(now.getTime() + nodeGate.reminderAfterHours * 3_600_000)
          : null,
        escalateAt: null,
      })),
    )
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
        inArray(schema.flowGates.assigneeUserId, replacements.map((u) => u.id)),
      ),
    );
    for (const row of fresh) {
      await notifyGateAssignee(row, "escalation");
    }
    return true;
  });
}

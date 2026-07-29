import { and, eq, inArray, sql } from "drizzle-orm";
import { planFromGate, type GateData } from "@openbooks/forms-core";
import { db, schema, withOrg } from "../db.ts";
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
 * Gate lifecycle — decide / worklist / delegate / timers. Ports the semantics
 * of beaconhs-platform's gate-actions.ts + resume-flow-gate.ts, fused into
 * one module because openbooks resumes IN-PROCESS (no worker outbox): the
 * decide is an atomic conditional UPDATE (pending → decided, so two
 * concurrent approvals can never both resume the branch), quorum evaluation
 * (quorum.ts) picks the branch, and planFromGate → executeFlowPlan re-runs on
 * the SAME runId — flow_run_effects checkpoints keep earlier nodes from
 * double-firing.
 *
 * Reminders/escalations (remind_at / escalate_at on flow_gates) run off the
 * 60s scheduler tick via processGateTimers().
 */

type GateRow = typeof schema.flowGates.$inferSelect;

export class GateError extends Error {}

/** Roles that may act on any gate in the org (matches web admin semantics). */
const GATE_ADMIN_ROLE = "admin";

async function loadGate(gateId: string): Promise<GateRow | null> {
  const [gate] = await db.select().from(schema.flowGates).where(eq(schema.flowGates.id, gateId));
  return gate ?? null;
}

async function canActOnGate(gate: GateRow, userId: string): Promise<boolean> {
  if (gate.assigneeUserId === userId) return true;
  const roles = await userRoleKeys(gate.orgId, userId);
  if (roles.has(GATE_ADMIN_ROLE)) return true;
  return !!gate.assigneeRole && roles.has(gate.assigneeRole);
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
    const node = await gateNodeData(gate.flowId, gate.nodeId);
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
async function gateNodeData(flowId: string, nodeId: string): Promise<GateData | null> {
  const [flow] = await db.select().from(schema.flows).where(eq(schema.flows.id, flowId));
  if (!flow) return null;
  const graph = parseFlowGraph(flow.id, flow.graph);
  if (!graph) return null;
  const node = graph.nodes.find((n) => n.id === nodeId);
  return node && node.data.kind === "gate" ? node.data.gate : null;
}

/** Recompute a run's status once gates move: waiting | completed | failed. */
async function finalizeRunStatus(runId: string, hadFailure: boolean, error?: string | null): Promise<void> {
  const pending = (await db.execute(sql`
    select count(*)::int as n from flow_gates where run_id = ${runId} and status in ('pending', 'escalated')
  `)) as unknown as { rows: { n: number }[] };
  const stillWaiting = (pending.rows[0]?.n ?? 0) > 0;
  const status = hadFailure ? "failed" : stillWaiting ? "waiting" : "completed";
  await db
    .update(schema.flowRuns)
    .set({
      status,
      error: hadFailure ? error ?? "gate branch failed" : null,
      finishedAt: status === "waiting" ? null : new Date(),
    })
    .where(eq(schema.flowRuns.id, runId));
}

export interface DecideGateResult {
  ok: true;
  /** Which branch resumed; null = quorum 'all' still waiting on siblings. */
  resumed: "approve" | "reject" | null;
  runStatus: "waiting" | "completed" | "failed";
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
 * and prefixes the row's comment with `[on behalf of <principal>]` — chosen
 * over a new column so 0027 stays a single-table migration and the existing
 * delegate-gate hand-off audit (also comment-based) stays consistent.
 */
export async function decideGate(args: {
  gateId: string;
  decision: "approved" | "rejected";
  userId: string;
  comment?: string | null;
  /** Typed attestation — required to approve a signature-required gate. */
  signature?: string | null;
}): Promise<DecideGateResult> {
  const { gateId, decision, userId } = args;
  const signature = args.signature?.trim() || null;

  // -- Pre-flight (existence, authorization, separation of duties) -----------
  const pre = await loadGate(gateId);
  if (!pre) throw new GateError("approval not found");
  if (pre.status !== "pending") throw new GateError("this approval was already resolved");

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
    const node = await gateNodeData(pre.flowId, pre.nodeId);
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

    const gate = await loadGate(gateId);
    if (!gate || gate.status !== "pending") {
      throw new GateError("this approval was already resolved");
    }

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
      .where(and(eq(schema.flowGates.id, gateId), eq(schema.flowGates.status, "pending")))
      .returning({ id: schema.flowGates.id });
    if (decided.length === 0) throw new GateError("this approval was already resolved");

    // Quorum over the sibling rows of this gate node instance.
    const siblings = (await db
      .select({ id: schema.flowGates.id, status: schema.flowGates.status })
      .from(schema.flowGates)
      .where(
        and(eq(schema.flowGates.runId, gate.runId), eq(schema.flowGates.groupKey, gate.groupKey)),
      )) as SiblingGate[];
    const outcome = resolveQuorumOutcome(gate.quorum, decision, siblings);

    if (outcome.cancelIds.length > 0) {
      await db
        .update(schema.flowGates)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            inArray(schema.flowGates.id, outcome.cancelIds),
            inArray(schema.flowGates.status, ["pending", "escalated"]),
          ),
        );
    }

    if (!outcome.resume) {
      // 'all' quorum still collecting approvals — the run keeps waiting.
      return { ok: true, resumed: null, runStatus: "waiting" };
    }

    // --- Resume the decided branch on the SAME run -------------------------
    const [flow] = await db.select().from(schema.flows).where(eq(schema.flows.id, gate.flowId));
    const adapter = getFlowAdapter(gate.subjectKind);
    if (!flow || !adapter) {
      await finalizeRunStatus(gate.runId, true, "flow definition or subject adapter is unavailable");
      return { ok: true, resumed: outcome.resume, runStatus: "failed" };
    }
    const graph = parseFlowGraph(flow.id, flow.graph);
    if (!graph) {
      await finalizeRunStatus(gate.runId, true, "flow graph failed validation");
      return { ok: true, resumed: outcome.resume, runStatus: "failed" };
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
    let releasedBeforeActions = false;
    if (
      subject &&
      outcome.resume === "approve" &&
      adapter.releaseApproval &&
      (await subjectOpenGateCount(gate.orgId, gate.subjectKind, gate.subjectId)) === 0
    ) {
      try {
        await adapter.releaseApproval(gate.subjectId, "approved", ctx, {
          comment: args.comment?.trim() || null,
        });
        releasedBeforeActions = true;
      } catch (e) {
        await finalizeRunStatus(
          gate.runId,
          true,
          e instanceof Error ? e.message : String(e),
        );
        return { ok: true, resumed: outcome.resume, runStatus: "failed" };
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
    if (!hadFailure && adapter.releaseApproval) {
      try {
        if (outcome.resume === "reject") {
          await cancelSubjectApprovals(gate.orgId, gate.subjectKind, gate.subjectId);
          await adapter.releaseApproval(gate.subjectId, "rejected", ctx, {
            comment: args.comment?.trim() || null,
          });
        } else if (
          !releasedBeforeActions &&
          (await subjectOpenGateCount(gate.orgId, gate.subjectKind, gate.subjectId)) === 0
        ) {
          await adapter.releaseApproval(gate.subjectId, "approved", ctx, {
            comment: args.comment?.trim() || null,
          });
        }
      } catch (e) {
        hadFailure = true;
        error = e instanceof Error ? e.message : String(e);
      }
    }

    await finalizeRunStatus(gate.runId, hadFailure, error);
    const runStatus = hadFailure
      ? "failed"
      : ((await db.select({ status: schema.flowRuns.status }).from(schema.flowRuns).where(eq(schema.flowRuns.id, gate.runId)))[0]
          ?.status as "waiting" | "completed" | "failed") ?? "completed";
    return { ok: true, resumed: outcome.resume, runStatus };
  });
}

/** Open (pending/escalated) gate rows for a subject across ALL its runs. */
async function subjectOpenGateCount(
  orgId: string,
  subjectKind: string,
  subjectId: string,
): Promise<number> {
  const r = (await db.execute(sql`
    select count(*)::int as n from flow_gates
     where org_id = ${orgId} and subject_kind = ${subjectKind} and subject_id = ${subjectId}
       and status in ('pending', 'escalated')
  `)) as unknown as { rows: { n: number }[] };
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
      .where(and(eq(schema.flowRuns.id, runId), inArray(schema.flowRuns.status, ["running", "waiting"])));
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
    const [{ enqueueEmail }, { flowNotificationEmail }] = await Promise.all([
      import("@openbooks/jobs"),
      import("@openbooks/emails"),
    ]);
    const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, gate.orgId));
    const mail = flowNotificationEmail({
      orgName: org?.name ?? "OpenBooks",
      subject: title,
      body: reasonLine ? `${title}\n\n${reasonLine}` : title,
    });
    await enqueueEmail({
      orgId: gate.orgId,
      to: submitter.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      meta: { category: "approvals" },
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
  /** Joined document header (null for future non-document subjects). */
  document: {
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
    href: row.closePeriodName ? `/close?run=${String(row.subjectId)}&stage=lock` : null,
    document: row.documentNumber
      ? {
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
           d.total, d.currency, d.document_date as "documentDate", d.memo,
           p.display_name as "partyName", cp.name as "closePeriodName",
           case when cp.name is not null then cp.name || ' close' else null end as "subjectLabel"
      from flow_gates g
      left join documents d on d.id = g.subject_id
      left join parties p on p.id = d.party_id
      left join close_runs cr on cr.id = g.subject_id and g.subject_kind = 'close_run'
      left join accounting_periods cp on cp.id = cr.period_id`;

/**
 * Pending gates the user may act on: assigned to them directly, to a role
 * they hold, or — flagged with `onBehalfOf` — assigned to a principal who has
 * an ACTIVE delegation window pointing at them (out-of-office coverage).
 * `roles` defaults to the user's resolved role keys.
 */
export async function worklistGates(
  orgId: string,
  userId: string,
  roles?: Iterable<string>,
): Promise<WorklistGate[]> {
  const roleList = roles ? [...roles] : [...(await userRoleKeys(orgId, userId))];
  const r = (await db.execute(sql`
    ${WORKLIST_SELECT}
     where g.org_id = ${orgId} and g.status = 'pending'
       and (g.assignee_user_id = ${userId}
            or (g.assignee_role is not null and g.assignee_role in
                 (select jsonb_array_elements_text(${JSON.stringify(roleList)}::jsonb))))
     order by g.created_at
  `)) as unknown as { rows: Record<string, unknown>[] };
  const out = r.rows.map((row) => mapWorklistRow(row, null));

  // Delegated gates: pending rows whose DIRECT assignee currently delegates
  // to the caller. Only user-assigned rows qualify (the principal's
  // assignment is the grant — role gates the principal merely could claim do
  // not travel), and rows already in the caller's own list win over the
  // delegated view of the same row.
  const principals = await activeDelegationPrincipals(orgId, userId);
  if (principals.length > 0) {
    const seen = new Set(out.map((g) => g.id));
    const byId = new Map(principals.map((p) => [p.id, p]));
    const d = (await db.execute(sql`
      ${WORKLIST_SELECT}
       where g.org_id = ${orgId} and g.status = 'pending'
         and g.assignee_user_id in
              (select jsonb_array_elements_text(${JSON.stringify(principals.map((p) => p.id))}::jsonb)::uuid)
       order by g.created_at
    `)) as unknown as { rows: Record<string, unknown>[] };
    for (const row of d.rows) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const principal = byId.get(String(row.assigneeUserId));
      if (!principal) continue;
      out.push(mapWorklistRow(row, { userId: principal.id, name: principal.name }));
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

  try {
    await db
      .update(schema.flowGates)
      .set({
        assigneeUserId: toUserId,
        // Preserve the ORIGINAL assignee (the first hand-off wins — a chain of
        // delegations still points back to who the gate was authored to).
        delegatedFromUserId: gate.delegatedFromUserId ?? gate.assigneeUserId ?? fromUserId,
        updatedBy: fromUserId,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.flowGates.id, gateId), eq(schema.flowGates.status, "pending")));
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
}

// --- Timers: reminders + escalation ---------------------------------------------

/**
 * Scan overdue gate timers — called from the 60s scheduler tick
 * (engine/src/scheduler.ts), which runs org-less/bypass like the
 * user_scripts scan.
 *
 * Reminders: remind_at <= now, not yet reminded → re-notify + email, stamp
 * reminded_at (fires once; the stamp is the claim).
 *
 * Escalations: escalate_at <= now, still pending → resolve the gate node's
 * escalateTo target (fallback: the submitter's supervisor; last resort:
 * org admins), insert replacement pending rows in the same group, flip the
 * overdue row to 'escalated'.
 */
export async function processGateTimers(now: Date = new Date()): Promise<{
  reminded: number;
  escalated: number;
}> {
  let reminded = 0;
  let escalated = 0;

  // --- Reminders -----------------------------------------------------------
  const dueReminders = (await db.execute(sql`
    select id from flow_gates
     where status = 'pending' and remind_at is not null and remind_at <= ${now}
       and reminded_at is null
     order by remind_at
     limit 200
  `)) as unknown as { rows: { id: string }[] };

  for (const { id } of dueReminders.rows) {
    // Claim via the reminded_at stamp so concurrent ticks fire once.
    const claimed = (await db.execute(sql`
      update flow_gates set reminded_at = ${now}
       where id = ${id} and status = 'pending' and reminded_at is null
    `)) as unknown as { rowCount?: number };
    if (!claimed.rowCount) continue;
    const gate = await loadGate(id);
    if (!gate) continue;
    try {
      await notifyGateAssignee(gate, "reminder");
      reminded++;
    } catch (e) {
      console.error(`[flows] gate ${id} reminder failed:`, e);
    }
  }

  // --- Escalations -----------------------------------------------------------
  const dueEscalations = (await db.execute(sql`
    select id from flow_gates
     where status = 'pending' and escalate_at is not null and escalate_at <= ${now}
     order by escalate_at
     limit 100
  `)) as unknown as { rows: { id: string }[] };

  for (const { id } of dueEscalations.rows) {
    try {
      if (await escalateGate(id, now)) escalated++;
    } catch (e) {
      console.error(`[flows] gate ${id} escalation failed:`, e);
    }
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
            // this gate row + this assignee, 7-day expiry.
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
async function escalateGate(gateId: string, now: Date): Promise<boolean> {
  const pre = await loadGate(gateId);
  if (!pre || pre.status !== "pending") return false;

  // Serialize with decisions on the same run via the shared per-run xact lock:
  // an escalation and a decision can never interleave, so replacement rows
  // inserted here are always visible to a concurrent quorum resolution (and a
  // decision that resolves the node first leaves nothing here to escalate).
  return withOrg(pre.orgId, async () => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${pre.runId}))`);
    const gate = await loadGate(gateId);
    if (!gate || gate.status !== "pending") return false;

    const adapter = getFlowAdapter(gate.subjectKind);
    const subject = adapter ? await adapter.loadContext(gate.subjectId) : null;
  const nodeGate = await gateNodeData(gate.flowId, gate.nodeId);

  const submitterUserId = subject?.submitterUserId ?? null;
  const values = subject?.values ?? {};
  const targetCtx = { orgId: gate.orgId, submitterUserId, values };

  // escalateTo → submitter's supervisor → org admins.
  let replacements = nodeGate?.escalateTo
    ? await resolveAssigneeUsers([nodeGate.escalateTo], targetCtx)
    : [];
  if (replacements.length === 0) {
    const sup = await supervisorOf(gate.orgId, submitterUserId);
    if (sup) replacements = [sup];
  }
  if (replacements.length === 0) {
    replacements = await roleUsers(gate.orgId, GATE_ADMIN_ROLE);
  }
  // Never escalate a gate to the person already sitting on it.
  replacements = replacements.filter((u) => u.id !== gate.assigneeUserId);

  if (replacements.length === 0) {
    // Unresolvable: tell the admins, stop re-scanning, keep the gate actionable.
    await db.execute(sql`
      update flow_gates set escalate_at = null, updated_at = now() where id = ${gateId} and status = 'pending'
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
     where id = ${gateId} and status = 'pending'
  `)) as unknown as { rowCount?: number };
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

  // Notify each replacement (fetch the fresh rows so notifyGateAssignee has
  // real gate rows — also skips any that already existed via onConflict).
  const fresh = await db
    .select()
    .from(schema.flowGates)
    .where(
      and(
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

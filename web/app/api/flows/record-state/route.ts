import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { documentKindPermissions } from "@openbooks/engine/records/document-kind-permissions";
import { gateDecisionCapability, getFlowAdapter } from "@openbooks/engine/flows/module";
import { lockFlowSubjectScope, requireFlowsRecordReader } from "../_lib";
import { can } from "../../../../lib/authz";
import { canReadSubjectRecord } from "../../../../lib/flow-subject-authz";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * Record-level approval state for the document flyout: who the record is
 * pending with, whether THIS viewer can decide, and a chronological approval
 * history — all from the Flows engine (flow_runs + flow_gates).
 *
 *   GET ?subjectKind=&subjectId= →
 *     {
 *       approvalState: {
 *         status,                                  // document status
 *         pendingWith: [{ name, gateId, since }],
 *         myActions: { gateId } | null
 *       },
 *       history: [{ id, type, actor, comment, at, title?, delegated? }]
 *     }
 *
 * myActions mirrors the decide endpoint's authorization exactly (engine
 * gates.ts canActOnGate): the row's assignee, a holder of its assigneeRole,
 * or a configured delegate.
 */

export type ApprovalEventType =
  "submitted" | "requested" | "approved" | "rejected" | "escalated" | "delegated";

export interface PendingWithEntry {
  name: string;
  gateId?: string;
  /** ISO timestamp the assignment has been waiting since. */
  since: string;
}

export interface ApprovalHistoryEntry {
  id: string;
  type: ApprovalEventType;
  /** Display name of who acted (or who the request went to, for 'requested'). */
  actor: string | null;
  comment: string | null;
  /** ISO timestamp. */
  at: string;
  /** Gate title, when there is one. */
  title?: string;
  /** Gate decided by a delegate. */
  delegated?: boolean;
}

export interface RecordApprovalState {
  approvalState: {
    status: string;
    pendingWith: PendingWithEntry[];
    myActions: {
      gateId: string;
      signatureRequired: boolean;
    } | null;
    /**
     * A pending gate reaches this viewer but separation of duties blocks
     * them as submitter/maker: drawers render "Awaiting another approver"
     * instead of decision actions, resolved in advance from the native
     * gate check — never offered then refused.
     */
    awaitingAnotherApprover?: boolean;
  };
  history: ApprovalHistoryEntry[];
  /**
   * The latest run when it failed: a run that died (e.g. its
   * gate resolved to zero assignees) strands the record with no live gate
   * and no path forward. Surfaces the run id + engine error so the row can
   * offer a retry; null when the latest run did not fail.
   */
  failedRun: { id: string; error: string | null; at: string } | null;
  /**
   * No flow run ever fired for this subject and no gate is live:
   * a record born pending before its flow existed.
   * The engine never saw it, so it can never appear in the approvals
   * centre — the drawer must offer to submit it into the current flow
   * instead of claiming no approvals are required.
   */
  neverSubmitted: boolean;
  /** Whether the caller may retry a failed run (flows.manage). */
  canRetry: boolean;
  /**
   * Whether the viewer submitted the open submission. Withdraw availability
   * combines this fact with the viewer's grants in the shared document
   * action rule (web/lib/document-action-availability.ts); the documents
   * action route re-checks the same rule on POST.
   */
  submittedByViewer: boolean;
  canWithdrawCommand?: boolean;
}

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : "";

/** The approval state of a visible record that no flow applies to. */
function emptyApprovalState(status: string): RecordApprovalState {
  return {
    approvalState: { status, pendingWith: [], myActions: null },
    history: [],
    failedRun: null,
    neverSubmitted: false,
    canRetry: false,
    submittedByViewer: false,
  };
}

async function legacyGET(req: Request) {
  const session = await requireFlowsRecordReader();
  if (session instanceof NextResponse) return session;
  const { authz } = session;

  const url = new URL(req.url);
  const subjectKind = url.searchParams.get("subjectKind") ?? "";
  const subjectId = url.searchParams.get("subjectId") ?? "";
  if (!subjectKind || !isUuid(subjectId)) {
    return NextResponse.json({ error: "subjectKind and subjectId required" }, { status: 400 });
  }

  const orgId = authz.user.orgId;
  const adapter = getFlowAdapter(subjectKind);
  // A kind no flow can govern has no approval state for any record of it.
  // The answer reads nothing about the named record, so it discloses
  // nothing; the record's own page keeps enforcing its read grant.
  if (!adapter) return NextResponse.json(emptyApprovalState(""));
  // Domain read before anything about the record is disclosed: a caller
  // without the subject kind's read grant (ap.read for a vendor bill, …)
  // meets the same answer as for a nonexistent record, so approval
  // participants, decisions, comments and failure reasons stay inside the
  // domain that owns them.
  if (!(await canReadSubjectRecord(authz, subjectKind, subjectId))) {
    return NextResponse.json({ error: "record not found" }, { status: 404 });
  }
  return withOrgTransaction(orgId, async () => {
    // Keep the canonical scope owner locked across every query that contributes
    // to the response. A preflight followed by separate status/history reads
    // could disclose B's state after an A-to-B rehome commits between them.
    try {
      await lockFlowSubjectScope(subjectKind, subjectId, orgId, authz.allowedSubsidiaryIds);
    } catch (error) {
      if (error instanceof ScopeNotFoundError) {
        return NextResponse.json({ error: "record not found" }, { status: 404 });
      }
      throw error;
    }
    const status = await adapter.getStatus(subjectId);
    if (status === null) return NextResponse.json({ error: "record not found" }, { status: 404 });
    const documentSubmission =
      status === "pending_approval" && documentKindPermissions(subjectKind)
        ? await db.execute<{ submittedBy: string | null }>(
            sql`
          select submitted_by as "submittedBy" from documents
           where org_id = ${orgId} and id = ${subjectId} and kind = ${subjectKind}
        `,
            "objects",
          )
        : null;
    const submittedByViewer = documentSubmission?.[0]?.submittedBy === authz.user.id;
    const commandSubmission = adapter.nativeCommandApproval
      ? (
          await db.execute<{ actor_id: string; policy: { kind: string } }>(
            sql`
      select actor_id,policy from flow_submissions where org_id=${orgId} and subject_kind=${subjectKind} and subject_id=${subjectId}
        and context ? 'command' order by created_at desc,id desc limit 1`,
            "objects",
          )
        )[0]
      : null;

    const [gates, runs, roleRows] = await Promise.all([
      db.execute<Record<string, unknown>>(
        sql`
      select g.id, g.status, g.title, g.comment, g.run_id as "runId",
             g.assignee_user_id as "assigneeUserId", g.assignee_role as "assigneeRole",
             g.decided_by as "decidedBy", g.decided_at as "decidedAt",
             g.created_at as "createdAt", g.updated_at as "updatedAt",
             g.delegated_from_user_id as "delegatedFromUserId",
             g.on_behalf_of_user_id as "onBehalfOfUserId",
             au.name as "assigneeName", du.name as "deciderName",
             fu.name as "delegatedFromName", ou.name as "onBehalfOfName"
        from flow_gates g
        left join users au on au.id = g.assignee_user_id
        left join users du on du.id = g.decided_by
        left join users fu on fu.id = g.delegated_from_user_id
        left join users ou on ou.id = g.on_behalf_of_user_id
       where g.org_id = ${orgId} and g.subject_kind = ${subjectKind} and g.subject_id = ${subjectId}
       order by g.created_at
    `,
        "objects",
      ),
      db.execute<Record<string, unknown>>(
        sql`
      select r.id, r.status, r.error, r.finished_at as "finishedAt",
             r.started_at as "startedAt",
             u.name as "submitterName"
        from flow_runs r
        left join users u on u.id = r.created_by
       where r.org_id = ${orgId} and r.subject_kind = ${subjectKind}
         and r.subject_id = ${subjectId}
       order by r.started_at
    `,
        "objects",
      ),
      db.execute<{ key: string; name: string }>(
        sql`
      select key, name from app_roles where org_id = ${orgId}
    `,
        "objects",
      ),
    ]);

    const roleLabel = (key: string | null): string | null => {
      if (!key) return null;
      return roleRows.find((r) => r.key === key)?.name ?? key;
    };
    // --- pendingWith + myActions ---------------------------------------------
    const pendingWith: PendingWithEntry[] = [];
    let myActions: RecordApprovalState["approvalState"]["myActions"] = null;
    let awaitingAnotherApprover = false;

    for (const g of gates) {
      if (g.status !== "pending") continue;
      const name =
        (g.assigneeName as string | null) ?? roleLabel(g.assigneeRole as string | null) ?? "—";
      pendingWith.push({ name, gateId: String(g.id), since: iso(g.createdAt) });
      const capability = await gateDecisionCapability(String(g.id), authz.user.id);
      if (capability.canAct && !myActions)
        myActions = { gateId: String(g.id), signatureRequired: capability.signatureRequired };
      // A gate that reaches this viewer but blocks them as submitter/maker
      // renders "Awaiting another approver" — the SoD outcome resolved in
      // advance, never an Approve that refuses on click.
      if (capability.sodBlocked) awaitingAnotherApprover = true;
    }

    // --- history --------------------------------------------------------------
    const history: ApprovalHistoryEntry[] = [];

    for (const r of runs) {
      history.push({
        id: `run:${r.id}`,
        type: "submitted",
        actor: (r.submitterName as string | null) ?? null,
        comment: null,
        at: iso(r.startedAt),
      });
    }

    for (const g of gates) {
      const assignee =
        (g.assigneeName as string | null) ?? roleLabel(g.assigneeRole as string | null);
      if (g.status !== "cancelled") {
        // Sibling rows cancelled by a satisfied 'any' quorum are routing noise;
        // their creation still shows who the approval was requested from.
        history.push({
          id: `gate:${g.id}:requested`,
          type: "requested",
          actor: assignee,
          comment: null,
          at: iso(g.createdAt),
          title: String(g.title ?? ""),
        });
      }
      // Delegation hand-off — structured provenance (delegated_from_user_id),
      // recorded when the gate was reassigned; the current assignee holds it now.
      if (g.delegatedFromUserId) {
        history.push({
          id: `gate:${g.id}:delegated`,
          type: "delegated",
          actor: (g.assigneeName as string | null) ?? assignee,
          comment: null,
          at: iso(g.updatedAt),
          title: String(g.title ?? ""),
        });
      }
      if (g.status === "approved" || g.status === "rejected") {
        history.push({
          id: `gate:${g.id}:decided`,
          type: g.status,
          actor: (g.deciderName as string | null) ?? assignee,
          comment: g.comment as string | null,
          at: iso(g.decidedAt ?? g.updatedAt),
          title: String(g.title ?? ""),
          // A delegate decided on behalf of the original assignee.
          delegated: !!g.onBehalfOfUserId,
        });
      } else if (g.status === "escalated") {
        history.push({
          id: `gate:${g.id}:escalated`,
          type: "escalated",
          actor: assignee,
          comment: null,
          at: iso(g.updatedAt),
          title: String(g.title ?? ""),
        });
      }
    }

    history.sort((a, b) => a.at.localeCompare(b.at));

    const latestRun = runs.length > 0 ? runs[runs.length - 1]! : null;
    // Withdrawal authority belongs to the document's submission actor,
    // independently of workflow retries, reminders or the presence of a
    // live gate. This is the same field the native withdrawal command locks.
    const body: RecordApprovalState = {
      approvalState: {
        status,
        pendingWith,
        myActions,
        ...(awaitingAnotherApprover ? { awaitingAnotherApprover: true as const } : {}),
      },
      history,
      failedRun:
        latestRun && latestRun.status === "failed"
          ? {
              id: String(latestRun.id),
              error: (latestRun.error as string | null) ?? null,
              at: iso(latestRun.finishedAt),
            }
          : null,
      neverSubmitted: runs.length === 0 && pendingWith.length === 0,
      canRetry: session.flowsEnabled && can(authz, "flows.manage"),
      submittedByViewer,
      canWithdrawCommand:
        !!commandSubmission &&
        commandSubmission.policy.kind === "gated" &&
        (commandSubmission.actor_id === authz.user.id || can(authz, "flows.manage")) &&
        gates.some((row) => row.status === "pending" || row.status === "escalated"),
    };
    return NextResponse.json(body);
  });
}

export const GET = defineRoute({
  public: "session",
  handler: async ({ request }) => legacyGET(request as never),
});

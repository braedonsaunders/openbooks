import { createHash } from "node:crypto";
import { canonicalJson } from "../platform/canonical-json.ts";
import { resumeFlowSubmission } from "./approval-release-hook.ts";
import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { lockSubjectScope } from "./subject-scope.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { isUuid } from "../platform/uuid.ts";
import { and, eq, sql } from "drizzle-orm";
import {
  automationGraphSchema,
  flowSubjectAdmission,
  planAutomation,
  type AutomationGraph,
  type AutomationPlan,
  type TriggerEvent,
} from "@openbooks/forms-core";
import { db, schema, withOrgTransaction, withTransactionSavepoint } from "../platform/db.ts";
import type { FlowExecCtx } from "./types.ts";
import { getFlowAdapter } from "./registry.ts";
import { executeFlowPlan } from "./execute.ts";
import { lockFlowSubjectAdmission } from "./subject-admission.ts";

/**
 * Trigger dispatch — fire a subject's enabled flows at a lifecycle event from
 * OpenBooks' in-process hook sites (the same places runTriggerScripts runs:
 * flows/submit.ts submit, posting.ts before/after post, payments.ts void).
 *
 * Contract with the hook sites: runRecordFlows NEVER throws into the calling
 * business transaction. Flows do not veto (scripts already do); every failure
 * is recorded on the flow_runs row + console.error, and the caller gets
 * aggregate stats back (on_submit uses gatesCreated to decide the document's
 * pending_approval status).
 *
 * Transactional hook sites (void reservation, posting commands) get matching
 * email semantics for free: every flow email is written into the durable
 * scheduler_outbox through the caller's own transaction, so a rollback
 * discards the pending send together with the flow's other effects and only
 * a committed unit ever delivers mail (see flows/execute.ts).
 */

export interface RecordFlowRun {
  runId: string;
  flowId: string;
  /** Display name of the flow — refusals name the flow, never a bare uuid. */
  flowName: string;
  status: "completed" | "waiting" | "failed" | "cancelled";
  gatesCreated: number;
  /** The run's failure cause, when status is failed. */
  error: string | null;
}

export interface RecordFlowsResult {
  /** Enabled flows whose plan matched the event (one flow_runs row each; a
   *  resumed dispatch that adopted an already-finished run reports that
   *  run's existing verdict). */
  runs: RecordFlowRun[];
  gatesCreated: number;
  /**
   * A matched flow errored (a run is `failed`) OR dispatch itself threw. The
   * on_submit caller MUST fail closed on this — a document that should have
   * been gated must never be treated as "no approval required" because its
   * approval flow errored (e.g. resolved to zero approvers).
   */
  failed: boolean;
  /**
   * The dispatch-level failure cause: set when `failed` is true but no run
   * carries the verdict (the dispatch threw before any flow ran). Consumers
   * surface this in their refusal; dispatch-result.ts composes the per-run
   * reasons (including enabled-but-invalid graphs, which record their own
   * failed run row).
   */
  error: string | null;
}

const EMPTY_RESULT: RecordFlowsResult = Object.freeze({
  runs: [],
  gatesCreated: 0,
  failed: false,
  error: null,
});

type FlowRunStatus = (typeof schema.flowRuns.$inferSelect)["status"];

/** The existing flow_runs row carrying `key`, for resumed-attempt adoption. */
async function adoptableOccurrenceRun(
  key: string,
): Promise<{ id: string; status: FlowRunStatus; error: string | null } | undefined> {
  const [row] = await db
    .select({
      id: schema.flowRuns.id,
      status: schema.flowRuns.status,
      error: schema.flowRuns.error,
    })
    .from(schema.flowRuns)
    .where(eq(schema.flowRuns.occurrenceKey, key));
  return row;
}

/**
 * Insert-or-adopt the flow_runs row for one occurrence-keyed dispatch.
 * A first firing inserts; a resumed attempt adopts the SAME row so effect
 * checkpoints and outbox keys converge on once. Adoption is status-aware:
 * only a row still `running` (a crashed attempt) reopens and re-executes —
 * a finished or gate-paused row is adopted in place (its `status` comes back
 * as `adoptedStatus`) because the recomputed plan may carry fresh nodes the
 * original run never checkpointed.
 */
async function startOrAdoptOccurrenceRun(
  orgId: string,
  occurrenceKey: string,
  row: {
    flowId: string;
    subjectKind: string;
    subjectId: string;
    trigger: string;
    context: Record<string, unknown>;
    createdBy: string | null;
  },
): Promise<{ runId: string; adoptedStatus: Exclude<FlowRunStatus, "running"> | null }> {
  let existing = await adoptableOccurrenceRun(occurrenceKey);
  if (!existing) {
    const [inserted] = await db
      .insert(schema.flowRuns)
      .values({ orgId, ...row, status: "running", occurrenceKey })
      // A concurrent dispatch reuses the occurrence run selected and adopted below.
      .onConflictDoNothing()
      .returning({ id: schema.flowRuns.id });
    if (inserted) return { runId: inserted.id, adoptedStatus: null };
    // Lost the unique-index race to a concurrent attempt of the same
    // dispatch: adopt its row.
    existing = await adoptableOccurrenceRun(occurrenceKey);
    if (!existing) throw new Error(`flow occurrence ${occurrenceKey} lost its adoption target run`);
  }
  // Resuming the crashed attempt's run: reopen it visibly while its
  // remaining effects execute under the completed-checkpoint contract.
  if (existing.status === "running") {
    await db
      .update(schema.flowRuns)
      .set({ status: "running", error: null, finishedAt: null })
      .where(and(eq(schema.flowRuns.id, existing.id), eq(schema.flowRuns.orgId, orgId)));
    return { runId: existing.id, adoptedStatus: null };
  }
  // terminal occurrence rows adopt in place; only running rows reopen and re-execute.
  // A finished (completed/failed/cancelled) or gate-paused run is immutable
  // evidence: adopt it in place — the plan was recomputed from CURRENT
  // subject state, so re-executing could append fresh effects the original
  // run never fired, and a waiting replay would be restamped completed.
  // Report the run's own verdict instead.
  return { runId: existing.id, adoptedStatus: existing.status };
}

/**
 * Drizzle wraps driver errors; surface the whole causal chain's messages so
 * a refusal names the cause instead of dumping the failed query. (Same
 * technique as the scheduled runner's rootErrorMessage.)
 */
function rootCauseMessage(e: unknown): string {
  const parts: string[] = [];
  let current: unknown = e;
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  if (current !== undefined && current != null) parts.push(String(current));
  return parts.join(" | ") || "unknown dispatch failure";
}

/** Parse a stored jsonb graph; null (with a log) when it fails validation. */
export function parseFlowGraph(flowId: string, graph: unknown): AutomationGraph | null {
  const parsed = automationGraphSchema.safeParse(graph);
  if (!parsed.success) {
    console.error(`[flows] flow ${flowId} has an invalid graph — skipped`);
    return null;
  }
  return parsed.data;
}

function planIsEmpty(plan: AutomationPlan): boolean {
  return plan.actionNodes.length === 0 && plan.gates.length === 0;
}

/** Merge plans (dedupe by nodeId) — used to co-fire on_field_value triggers. */
function mergePlans(a: AutomationPlan, b: AutomationPlan): AutomationPlan {
  const seenActions = new Set(a.actionNodes.map((n) => n.nodeId));
  const seenGates = new Set(a.gates.map((g) => g.nodeId));
  const actionNodes = [
    ...a.actionNodes,
    ...b.actionNodes.filter((n) => !seenActions.has(n.nodeId)),
  ];
  const gates = [...a.gates, ...b.gates.filter((g) => !seenGates.has(g.nodeId))];
  return { actions: actionNodes.map((n) => n.action), actionNodes, gates };
}

/** Lifecycle events that also co-fire a graph's on_field_value triggers. */
const RECORD_LIFECYCLE_KINDS = new Set<TriggerEvent["kind"]>([
  "on_create",
  "on_update",
  "on_submit",
  "before_post",
  "after_post",
  "before_void",
  "status_change",
]);

export async function runRecordFlows(
  event: TriggerEvent,
  subjectKind: string,
  subjectId: string,
  ctx: FlowExecCtx,
): Promise<RecordFlowsResult> {
  try {
    const adapter = getFlowAdapter(subjectKind);
    if (!adapter) return EMPTY_RESULT;

    const flows = await db
      .select()
      .from(schema.flows)
      .where(
        and(
          eq(schema.flows.orgId, ctx.orgId),
          eq(schema.flows.subjectKind, subjectKind),
          eq(schema.flows.enabled, true),
        ),
      );
    if (flows.length === 0) return EMPTY_RESULT;

    const subject = await adapter.loadContext(subjectId);
    if (!subject) return EMPTY_RESULT;

    const result: RecordFlowsResult = { runs: [], gatesCreated: 0, failed: false, error: null };
    // The subject's legal entity, resolved once through the adapter's
    // native scope source the first time a scoped graph needs it.
    let resolvedSubjectSubsidiary: { value: string | null } | null = null;
    for (const flow of flows) {
      const graph = parseFlowGraph(flow.id, flow.graph);
      if (!graph) {
        // Fail closed: an ENABLED flow whose graph cannot be parsed must
        // refuse the submit/event it governs, never be skipped as "no
        // approval required". Record the failure on its own failed run row
        // (retryable once the graph is fixed) and mark the dispatch failed.
        const reason =
          `flow "${flow.name}" is enabled but its graph is invalid and cannot run — ` +
          `fix or disable the flow, then resubmit`;
        console.error(
          `[flows] flow ${flow.id} ("${flow.name}") has an invalid graph — dispatch refused`,
        );
        const [failedRow] = await db
          .insert(schema.flowRuns)
          .values({
            orgId: ctx.orgId,
            flowId: flow.id,
            subjectKind,
            subjectId,
            trigger: event.kind,
            status: "failed",
            error: reason,
            finishedAt: new Date(),
            // jsonb snapshot: strip non-serializable values (Dates → ISO).
            context: JSON.parse(
              JSON.stringify({ ...subject.values, event_source: event.source ?? "api" }),
            ) as Record<string, unknown>,
            createdBy: ctx.userId ?? null,
          })
          .returning({ id: schema.flowRuns.id });
        result.runs.push({
          runId: failedRow!.id,
          flowId: flow.id,
          flowName: flow.name,
          status: "failed",
          gatesCreated: 0,
          error: reason,
        });
        result.failed = true;
        continue;
      }

      // Legal-entity admission, decided from the graph's typed subject
      // scope BEFORE this flow is planned, creates a run, routes a gate or
      // leaves any other effect for the subject. The first scoped graph
      // takes the native scope-owner lock, so the entity (and any owner
      // link) stays frozen from admission through this dispatch's effects
      // for the rest of the caller's transaction; a rehome that committed
      // before the lock is what the locked resolution sees. A resolved
      // entity outside the list means the flow does not apply at all; an
      // entity that cannot be resolved fails closed exactly like an
      // invalid graph, so a scoped approval can never be bypassed by an
      // ownerless record.
      if (graph.subjectScope) {
        if (!resolvedSubjectSubsidiary) {
          const resolved = await lockFlowSubjectAdmission(
            ctx.orgId,
            adapter,
            subjectKind,
            subjectId,
            graph,
          );
          resolvedSubjectSubsidiary = { value: resolved.subsidiaryId };
        }
        const admission = flowSubjectAdmission(graph.subjectScope, resolvedSubjectSubsidiary.value);
        if (admission === "out-of-scope") continue;
        if (admission === "unresolved") {
          const reason =
            `flow "${flow.name}" is limited to specific legal entities, but this record's legal entity could not be resolved — ` +
            `assign the record to a legal entity, then resubmit`;
          console.error(
            `[flows] flow ${flow.id} ("${flow.name}") cannot prove legal-entity admission for ${subjectKind}/${subjectId}`,
          );
          const [failedRow] = await db
            .insert(schema.flowRuns)
            .values({
              orgId: ctx.orgId,
              flowId: flow.id,
              subjectKind,
              subjectId,
              trigger: event.kind,
              status: "failed",
              error: reason,
              finishedAt: new Date(),
              context: JSON.parse(
                JSON.stringify({ ...subject.values, event_source: event.source ?? "api" }),
              ) as Record<string, unknown>,
              createdBy: ctx.userId ?? null,
            })
            .returning({ id: schema.flowRuns.id });
          result.runs.push({
            runId: failedRow!.id,
            flowId: flow.id,
            flowName: flow.name,
            status: "failed",
            gatesCreated: 0,
            error: reason,
          });
          result.failed = true;
          continue;
        }
      }

      // Fresh values per flow — a set_field in one flow's run must not bleed
      // into another flow's condition evaluation mid-dispatch.
      const evalCtx = {
        values: { ...subject.values },
        rows: subject.rows ?? {},
      };
      // Where the mutation came from — conditions can auto-approve
      // system-generated records.
      evalCtx.values.event_source = event.source ?? "api";
      // on_update carries edit-shape data ON THE EVENT (the caller knows what
      // changed; the adapter only sees the post-edit record). Surface it as
      // eval-context values so condition nodes / templates can require
      // re-approval when a record materially changes (see
      // DOCUMENT_FIELDS in subject-profiles.ts). `changedFields` /
      // `changedLineFields` are arrays — LogicRule `in` over them is
      // ANY-OVERLAP, so {op:'in', field:'changedFields',
      // value:['total','taxTotal']} reads "total or tax total changed".
      if (event.kind === "on_update") {
        evalCtx.values.previousTotal = event.previousTotal ?? null;
        evalCtx.values.totalChanged = event.totalChanged ?? false;
        evalCtx.values.changedFields = event.changedFields ?? [];
        evalCtx.values.changedLineFields = event.changedLineFields ?? [];
        for (const [k, v] of Object.entries(event.old ?? {})) {
          evalCtx.values[`old_${k}`] = v as never;
        }
      }
      if (ctx.submissionCommand)
        evalCtx.values.commandAction = ctx.submissionCommand.action ?? null;
      let plan = planAutomation(graph, event, evalCtx);
      if (RECORD_LIFECYCLE_KINDS.has(event.kind)) {
        // on_field_value fires ALONGSIDE lifecycle events when its rule
        // matches (the flow execution contract); merged so converging nodes dedupe.
        plan = mergePlans(plan, planAutomation(graph, { kind: "on_field_value" }, evalCtx));
      }
      const automaticSubmission =
        event.kind === "on_submit" &&
        plan.gates.length === 0 &&
        adapter.profile.supportsUngatedSubmission === true;
      if (planIsEmpty(plan) && !automaticSubmission) continue;
      const dispatchValues = {
        ...evalCtx.values,
        ...(ctx.submissionCommand
          ? {
              command: ctx.submissionCommand,
              commandAction: ctx.submissionCommand.action ?? null,
            }
          : {}),
        event_source: event.source ?? "api",
        submissionPolicy: {
          graph: flow.graph,
          flowId: flow.id,
          rows: subject.rows ?? {},
        },
      };

      // Deterministic dispatch identity: when the caller supplies an
      // occurrenceKey (close automations use their execution id), every flow
      // run for this dispatch derives a per-flow key so a resumed attempt
      // adopts the SAME run row — checkpoints and outbox keys then converge on
      // once instead of double-firing (the scheduled-flows contract).
      const occurrenceKey =
        typeof event.occurrenceKey === "string" && event.occurrenceKey.length > 0
          ? `${event.occurrenceKey}:${flow.id}`
          : null;
      let runId: string;
      // Non-null when the occurrence already owned a finished (or gate-paused)
      // flow_runs row: the run is adopted AS-IS and the recomputed plan never
      // executes against it.
      let adoptedStatus: Exclude<FlowRunStatus, "running"> | null = null;
      if (occurrenceKey) {
        const adoption = await startOrAdoptOccurrenceRun(ctx.orgId, occurrenceKey, {
          flowId: flow.id,
          subjectKind,
          subjectId,
          trigger: event.kind,
          // jsonb snapshot: strip non-serializable values (Dates → ISO).
          context: JSON.parse(JSON.stringify(dispatchValues)) as Record<string, unknown>,
          createdBy: ctx.userId ?? null,
        });
        runId = adoption.runId;
        adoptedStatus = adoption.adoptedStatus;
      } else {
        runId = (
          await db
            .insert(schema.flowRuns)
            .values({
              orgId: ctx.orgId,
              flowId: flow.id,
              subjectKind,
              subjectId,
              trigger: event.kind,
              status: "running",
              // jsonb snapshot: strip non-serializable values (Dates → ISO).
              context: JSON.parse(JSON.stringify(dispatchValues)) as Record<string, unknown>,
              createdBy: ctx.userId ?? null,
            })
            .returning({ id: schema.flowRuns.id })
        )[0]!.id;
      }

      let status: "completed" | "waiting" | "failed" | "cancelled";
      let gatesCreated = 0;
      let runError: string | null = null;
      if (adoptedStatus) {
        // Adopted finished/paused run: report its verdict, execute nothing.
        status = adoptedStatus;
        if (status === "failed") {
          const [adopted] = await db
            .select({ error: schema.flowRuns.error })
            .from(schema.flowRuns)
            .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, ctx.orgId)));
          runError = adopted?.error ?? "flow run previously failed";
        }
      } else {
        try {
          const res = await executeFlowPlan(ctx, adapter, {
            flow: { id: flow.id, name: flow.name, subjectKind: subjectKind, graph: flow.graph },
            runId,
            subjectId,
            plan,
            evalCtx,
            // The subject may not have submitted_by stamped until the owning
            // submit command returns. During on_submit, the command actor is
            // the authoritative submitter for separation-of-duties routing.
            submitterUserId:
              event.kind === "on_submit"
                ? (ctx.userId ?? subject.submitterUserId)
                : subject.submitterUserId,
          });
          gatesCreated = res.gatesCreated;
          status =
            res.failed.length > 0 ? "failed" : res.gatesCreated > 0 ? "waiting" : "completed";
          runError = res.failed.length > 0 ? res.failed.join("; ") : null;
          await db
            .update(schema.flowRuns)
            .set({
              status,
              error: res.failed.length > 0 ? res.failed.join("; ") : null,
              finishedAt: status === "waiting" ? null : new Date(),
            })
            .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, ctx.orgId)));
          if (res.failed.length > 0) {
            console.error(
              `[flows] run ${runId} (flow "${flow.name}") failed:`,
              res.failed.join("; "),
            );
          }
        } catch (e) {
          status = "failed";
          const reason = rootCauseMessage(e);
          runError = reason;
          console.error(`[flows] run ${runId} (flow "${flow.name}") crashed:`, e);
          await db
            .update(schema.flowRuns)
            .set({ status: "failed", error: reason, finishedAt: new Date() })
            .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, ctx.orgId)))
            .catch(() => {});
        }
      }

      result.runs.push({
        runId,
        flowId: flow.id,
        flowName: flow.name,
        status,
        gatesCreated,
        error: runError,
      });
      result.gatesCreated += gatesCreated;
      if (status === "failed") result.failed = true;
    }
    return result;
  } catch (e) {
    // NEVER propagate into the calling business operation — but report the
    // failure so an on_submit caller can fail closed rather than auto-approve.
    console.error(`[flows] dispatch failed (${event.kind} ${subjectKind}/${subjectId}):`, e);
    const reason = rootCauseMessage(e);
    return { runs: [], gatesCreated: 0, failed: true, error: `flow dispatch failed: ${reason}` };
  }
}

/**
 * A retry refusal: the run is not in a retryable state (missing, not failed,
 * superseded, unplannable). Callers map this to a 4xx — retrying the wrong
 * run is request state, not a server defect.
 */
export class FlowRetryError extends Error {
  readonly name = "FlowRetryError";
}

export interface RetryFlowRunResult {
  runId: string;
  status: "completed" | "waiting" | "failed" | "cancelled";
  gatesCreated: number;
}

/**
 * Rebuild the stored trigger as a plan event. Lifecycle kinds carry no event
 * extras (or, for on_update, lose them — see below), so the stored trigger
 * string is enough. Anything else (status_change needs its `to`, manual
 * needs its button, scheduled carries its occurrence) cannot be faithfully
 * rebuilt from the run row and must be re-fired from the record.
 */
function retryEvent(trigger: string): TriggerEvent {
  switch (trigger) {
    case "on_create":
      return { kind: "on_create" };
    case "on_submit":
      return { kind: "on_submit" };
    case "before_post":
      return { kind: "before_post" };
    case "after_post":
      return { kind: "after_post" };
    case "before_void":
      return { kind: "before_void" };
    // The original edit's changedFields/old_* are not stored on the run:
    // re-plan against CURRENT values with an empty change set, so
    // material-change conditions evaluate against now, not then.
    case "on_update":
      return { kind: "on_update", changedFields: [], changedLineFields: [] };
    default:
      throw new FlowRetryError(`a ${trigger} run cannot be retried; re-fire it from the record`);
  }
}

/**
 * Re-drive a FAILED run after its failure cause is fixed (a gate
 * that resolved to zero assignees strands its subject with no path forward).
 * The stored trigger is re-planned against its frozen Flow and subject facts;
 * acting authority and recipient availability are rechecked at execution.
 * and re-executed on the SAME run row, so effect checkpoints make the resume
 * idempotent (completed effects are skipped, the failed node re-runs).
 *
 * Safety rails: only a failed run, only the latest run for its flow+subject
 * (effect checkpoints are per-run, so re-driving a superseded run could
 * double-fire a newer run's completed effects), and only when the trigger
 * still plans to something — otherwise the retry refuses instead of
 * silently completing a run that did nothing.
 */
export async function retryFlowRun(runId: string, ctx: FlowExecCtx): Promise<RetryFlowRunResult> {
  if (!isUuid(runId) || !isUuid(ctx.orgId) || !isUuid(ctx.userId))
    throw new FlowRetryError("Retry requires the native run and its acting workflow manager.");
  return withOrgTransaction(ctx.orgId, () => retryFlowRunLocked(runId, ctx));
}

async function retryFlowRunLocked(runId: string, ctx: FlowExecCtx): Promise<RetryFlowRunResult> {
  // Read only the fence identity first. Decisions always take the subject
  // fence before row locks, including when submission resumes its writer.
  const [identity] = await db
    .select({ subjectKind: schema.flowRuns.subjectKind, subjectId: schema.flowRuns.subjectId })
    .from(schema.flowRuns)
    .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, ctx.orgId)));
  if (!identity) throw new FlowRetryError("flow run not found");
  await lockApprovalSubject(ctx.orgId, identity.subjectKind, identity.subjectId);
  const [run] = await db
    .select()
    .from(schema.flowRuns)
    .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, ctx.orgId)))
    .for("update");
  if (!run || run.subjectKind !== identity.subjectKind || run.subjectId !== identity.subjectId)
    throw new FlowRetryError("The flow run identity changed; reload the record before retrying.");
  if (run.status !== "failed") throw new FlowRetryError("only a failed run can be retried");

  // Timestamps round-trip at millisecond precision while storage keeps
  // microseconds, so a row-wise `>` self-matches: exclude self by id and
  // compare `>=` (a same-millisecond older sibling refuses safe — a retry
  // refusal never corrupts, a wrongful re-drive could double-fire).
  const newer = await db.execute<{ id: string }>(
    sql`
    select id from flow_runs
     where org_id = ${ctx.orgId} and flow_id = ${run.flowId} and subject_id = ${run.subjectId}
       and id <> ${run.id} and started_at >= ${run.startedAt}
     limit 1
  `,
    "objects",
  );
  if (newer[0]) {
    throw new FlowRetryError(
      "only the latest run for this record can be retried; retry that one instead",
    );
  }

  const adapter = getFlowAdapter(run.subjectKind);
  if (!adapter) throw new FlowRetryError(`no flow adapter for subject kind "${run.subjectKind}"`);
  const liveScope = await lockActorCommandAuthority(
    db,
    ctx.orgId,
    ctx.userId!,
    null,
    "flows.manage",
  );
  const callerScope = ctx.allowedSubsidiaryIds;
  const allowed =
    callerScope === undefined || callerScope === null
      ? liveScope
      : liveScope === null
        ? callerScope
        : new Set([...callerScope].filter((id) => liveScope.has(id)));
  await lockSubjectScope(ctx.orgId, run.subjectKind, adapter.scope, run.subjectId, allowed);
  if (!(await lockAndCheckOrgFeature(db, ctx.orgId, "flows")))
    throw new FlowRetryError("Flows is disabled; enable it in Company Settings before retrying.");
  ctx = { ...ctx, allowedSubsidiaryIds: allowed };
  const [flow] = await db
    .select()
    .from(schema.flows)
    .where(and(eq(schema.flows.id, run.flowId), eq(schema.flows.orgId, ctx.orgId)))
    .for("share");
  if (!flow) throw new FlowRetryError("the flow for this run no longer exists");
  const retainedPolicy = run.context?.submissionPolicy as
    { flowId?: unknown; graph?: unknown; rows?: unknown } | undefined;
  if (
    retainedPolicy?.flowId !== run.flowId ||
    !retainedPolicy.graph ||
    !retainedPolicy.rows ||
    typeof retainedPolicy.rows !== "object" ||
    Array.isArray(retainedPolicy.rows)
  )
    throw new FlowRetryError(
      "This run has no complete frozen submission. Recall its pending work and submit the current record again.",
    );
  const graph = parseFlowGraph(flow.id, retainedPolicy.graph);
  if (!graph)
    throw new FlowRetryError(
      "The run's frozen Flow is invalid. Recall its pending work and submit again.",
    );
  const subject = await adapter.loadContext(run.subjectId);
  if (!subject) throw new FlowRetryError("the run's subject no longer exists");

  // The frozen graph's legal-entity scope is checked against the subject's
  // current resolved entity: a subject moved outside that scope (or a
  // record whose entity can no longer be proven) must not be re-driven.
  // Refusing here leaves the failed run — and any pending approval linkage
  // on the subject — exactly as it was, never silently completed or
  // released.
  const retryAdmission = await lockFlowSubjectAdmission(
    ctx.orgId,
    adapter,
    run.subjectKind,
    run.subjectId,
    graph,
  );
  if (retryAdmission.admission === "out-of-scope") {
    throw new FlowRetryError(
      "the flow for this run is now limited to legal entities that do not include this record's legal entity; the failed run is unchanged — re-fire it from the record only under a flow that applies to it",
    );
  }
  if (retryAdmission.admission === "unresolved") {
    throw new FlowRetryError(
      "this record's legal entity could not be resolved, so the flow's legal-entity limit cannot be proven — assign the record to a legal entity, then retry",
    );
  }

  const event = retryEvent(run.trigger);
  const source = run.context?.event_source;
  if (typeof source !== "string" || source.length === 0)
    throw new FlowRetryError(
      "The run has no retained event source; re-fire it through the record action rather than inferring its original authority.",
    );
  const evalCtx = {
    values: { ...run.context, event_source: source },
    rows: retainedPolicy.rows as NonNullable<typeof subject.rows>,
  };
  let plan = planAutomation(graph, event, evalCtx);
  if (RECORD_LIFECYCLE_KINDS.has(event.kind)) {
    // on_field_value fires ALONGSIDE lifecycle events when its rule
    // matches (the flow execution contract); merged so converging nodes dedupe.
    plan = mergePlans(plan, planAutomation(graph, { kind: "on_field_value" }, evalCtx));
  }
  const automaticSubmission =
    event.kind === "on_submit" &&
    plan.gates.length === 0 &&
    adapter.profile.supportsUngatedSubmission === true;
  if (planIsEmpty(plan) && !automaticSubmission) {
    throw new FlowRetryError(
      "the run's trigger no longer matches its flow; re-fire it from the record",
    );
  }

  const started = await db
    .update(schema.flowRuns)
    .set({ status: "running", error: null, finishedAt: null })
    .where(
      and(
        eq(schema.flowRuns.id, runId),
        eq(schema.flowRuns.orgId, ctx.orgId),
        eq(schema.flowRuns.status, "failed"),
      ),
    )
    .returning({ id: schema.flowRuns.id });
  if (started.length !== 1)
    throw new FlowRetryError("The failed run changed before retry; reload the workflow.");

  let status: RetryFlowRunResult["status"];
  let gatesCreated = 0;
  try {
    const res = await executeFlowPlan(ctx, adapter, {
      flow: {
        id: flow.id,
        name: flow.name,
        subjectKind: run.subjectKind,
        graph,
      },
      runId,
      subjectId: run.subjectId,
      plan,
      evalCtx,
      submitterUserId: subject.submitterUserId,
    });
    gatesCreated = res.gatesCreated;
    const failures = [...res.failed];
    if (failures.length === 0 && gatesCreated > 0) {
      // A retry that now gates must park its subject awaiting approval — the
      // transition submitForApproval owns on the first attempt. Without it
      // the subject sits in draft behind a live gate and the engine-enforced
      // release (pending_approval-only by design) no-ops, so the approval can
      // never land. A parking failure fails the run closed like any effect.
      try {
        await adapter.markAwaitingApproval?.(run.subjectId, ctx);
      } catch (e) {
        failures.push(`awaiting approval (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    if (failures.length === 0 && gatesCreated === 0 && automaticSubmission) {
      try {
        await withTransactionSavepoint(db, async () => {
          const routingProof = {
            version: 1,
            runId,
            flowId: flow.id,
            subjectKind: run.subjectKind,
            subjectId: run.subjectId,
            eventSource: source,
            outcome: "apply",
            gatesCreated: 0,
            failures: [],
            graphDigest: createHash("sha256").update(canonicalJson(graph)).digest("hex"),
            actorId: ctx.userId ?? null,
          };
          // Preserve the original proposal identity. Fresh values drive routing,
          // but cannot replace the frozen evidence the owning writer checks.
          const dispatchValues = {
            ...run.context,
            event_source: source,
            submissionPolicy: {
              ...retainedPolicy,
              flowId: flow.id,
            },
            submissionRouting: routingProof,
          };
          const updated = await db
            .update(schema.flowRuns)
            .set({
              context: dispatchValues,
              status: "completed",
              error: null,
              finishedAt: new Date(),
            })
            .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, ctx.orgId)))
            .returning({ id: schema.flowRuns.id });
          if (updated.length !== 1)
            throw new FlowRetryError("flow run changed during automatic submission");
          await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,actor_id,changes)
          values(${ctx.orgId},'flow_runs',${runId},'update',${ctx.userId ?? null},
            ${JSON.stringify({ reason: "Retry the frozen Flow submission", before: { context: run.context }, after: { context: dispatchValues } })}::jsonb)`);
          // The owner validates live actor/scope and the exact successful run,
          // then completes its native submission policy without inventing a
          // human approval decision or dispatching another flow run.
          const resumed = await resumeFlowSubmission({
            subjectKind: run.subjectKind,
            subjectId: run.subjectId,
            runId,
            mode: "automatic",
            ctx,
          });
          if ((await adapter.getStatus(run.subjectId)) !== resumed.status)
            throw new FlowRetryError(
              "The submission outcome is not visible through its native record reader",
            );
        });
      } catch (error) {
        failures.push(
          `automatic submission (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    status = failures.length > 0 ? "failed" : res.gatesCreated > 0 ? "waiting" : "completed";
    const finished = await db
      .update(schema.flowRuns)
      .set({
        status,
        error: failures.length > 0 ? failures.join("; ") : null,
        finishedAt: status === "waiting" ? null : new Date(),
      })
      .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, ctx.orgId)))
      .returning({ id: schema.flowRuns.id });
    if (finished.length !== 1)
      throw new FlowRetryError(
        "The retry result was not retained; no completed submission may be reported.",
      );
    if (failures.length > 0) {
      console.error(
        `[flows] retried run ${runId} (flow "${flow.name}") failed again:`,
        failures.join("; "),
      );
    }
  } catch (e) {
    status = "failed";
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[flows] retried run ${runId} (flow "${flow.name}") crashed:`, e);
    try {
      const failed = await db
        .update(schema.flowRuns)
        .set({ status: "failed", error: reason, finishedAt: new Date() })
        .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, ctx.orgId)))
        .returning({ id: schema.flowRuns.id });
      if (failed.length !== 1) throw new Error("The retry failure did not match its run.");
    } catch (retentionError) {
      throw new AggregateError(
        [e, retentionError],
        "The retry failed and its outcome could not be retained; the transaction must roll back.",
      );
    }
  }
  return { runId, status, gatesCreated };
}

/**
 * Convenience for callers that flip a subject's status themselves (posting,
 * voiding): fire the status_change trigger without ever throwing.
 */
export async function emitStatusChange(
  subjectKind: string,
  subjectId: string,
  transition: { from?: string | null; to: string },
  ctx: FlowExecCtx,
): Promise<void> {
  await runRecordFlows(
    { kind: "status_change", from: transition.from ?? null, to: transition.to },
    subjectKind,
    subjectId,
    ctx,
  );
}

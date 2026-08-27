import { and, eq } from "drizzle-orm";
import {
  automationGraphSchema,
  planAutomation,
  type AutomationGraph,
  type AutomationPlan,
  type TriggerEvent,
} from "@openbooks/forms-core";
import { db, schema } from "../db.ts";
import type { FlowExecCtx } from "./types.ts";
import { getFlowAdapter } from "./registry.ts";
import { executeFlowPlan } from "./execute.ts";

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

export interface RecordFlowsResult {
  /** Enabled flows whose plan matched the event (one flow_runs row each; a
   *  resumed dispatch that adopted an already-finished run reports that
   *  run's existing verdict). */
  runs: Array<{
    runId: string;
    flowId: string;
    status: "completed" | "waiting" | "failed" | "cancelled";
    gatesCreated: number;
  }>;
  gatesCreated: number;
  /**
   * A matched flow errored (a run is `failed`) OR dispatch itself threw. The
   * on_submit caller MUST fail closed on this — a document that should have
   * been gated must never be treated as "no approval required" because its
   * approval flow errored (e.g. resolved to zero approvers).
   */
  failed: boolean;
}

const EMPTY_RESULT: RecordFlowsResult = Object.freeze({ runs: [], gatesCreated: 0, failed: false });

type FlowRunStatus = (typeof schema.flowRuns.$inferSelect)["status"];

/** The existing flow_runs row carrying `key`, for resumed-attempt adoption. */
async function adoptableOccurrenceRun(
  key: string,
): Promise<{ id: string; status: FlowRunStatus } | undefined> {
  const [row] = await db
    .select({ id: schema.flowRuns.id, status: schema.flowRuns.status })
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
  const actionNodes = [...a.actionNodes, ...b.actionNodes.filter((n) => !seenActions.has(n.nodeId))];
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

    const result: RecordFlowsResult = { runs: [], gatesCreated: 0, failed: false };
    for (const flow of flows) {
      const graph = parseFlowGraph(flow.id, flow.graph);
      if (!graph) continue;

      // Fresh values per flow — a set_field in one flow's run must not bleed
      // into another flow's condition evaluation mid-dispatch.
      const evalCtx = {
        values: { ...subject.values },
        rows: subject.rows ?? {},
      };
      // Where the mutation came from — conditions can auto-approve
      // system-generated records (source platform execution-context filters).
      evalCtx.values.event_source = event.source ?? "api";
      // on_update carries edit-shape data ON THE EVENT (the caller knows what
      // changed; the adapter only sees the post-edit record). Surface it as
      // eval-context values so condition nodes / templates can implement the
      // source platform "needs re-approval on material edit" pattern (see
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
      let plan = planAutomation(graph, event, evalCtx);
      if (RECORD_LIFECYCLE_KINDS.has(event.kind)) {
        // on_field_value fires ALONGSIDE lifecycle events when its rule
        // matches (the flow execution contract); merged so converging nodes dedupe.
        plan = mergePlans(plan, planAutomation(graph, { kind: "on_field_value" }, evalCtx));
      }
      if (planIsEmpty(plan)) continue;

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
          context: JSON.parse(JSON.stringify(subject.values)) as Record<string, unknown>,
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
              context: JSON.parse(JSON.stringify(subject.values)) as Record<string, unknown>,
              createdBy: ctx.userId ?? null,
            })
            .returning({ id: schema.flowRuns.id })
        )[0]!.id;
      }

      let status: "completed" | "waiting" | "failed" | "cancelled";
      let gatesCreated = 0;
      if (adoptedStatus) {
        // Adopted finished/paused run: report its verdict, execute nothing.
        status = adoptedStatus;
      } else {
        try {
          const res = await executeFlowPlan(ctx, adapter, {
            flow: { id: flow.id, name: flow.name, subjectKind: subjectKind, graph: flow.graph },
            runId,
            subjectId,
            plan,
            evalCtx,
            submitterUserId: subject.submitterUserId,
          });
          gatesCreated = res.gatesCreated;
          status = res.failed.length > 0 ? "failed" : res.gatesCreated > 0 ? "waiting" : "completed";
          await db
            .update(schema.flowRuns)
            .set({
              status,
              error: res.failed.length > 0 ? res.failed.join("; ") : null,
              finishedAt: status === "waiting" ? null : new Date(),
            })
            .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, ctx.orgId)));
          if (res.failed.length > 0) {
            console.error(`[flows] run ${runId} (flow "${flow.name}") failed:`, res.failed.join("; "));
          }
        } catch (e) {
          status = "failed";
          const reason = e instanceof Error ? e.message : String(e);
          console.error(`[flows] run ${runId} (flow "${flow.name}") crashed:`, e);
          await db
            .update(schema.flowRuns)
            .set({ status: "failed", error: reason, finishedAt: new Date() })
            .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, ctx.orgId)))
            .catch(() => {});
        }
      }

      result.runs.push({ runId, flowId: flow.id, status, gatesCreated });
      result.gatesCreated += gatesCreated;
      if (status === "failed") result.failed = true;
    }
    return result;
  } catch (e) {
    // NEVER propagate into the calling business operation — but report the
    // failure so an on_submit caller can fail closed rather than auto-approve.
    console.error(`[flows] dispatch failed (${event.kind} ${subjectKind}/${subjectId}):`, e);
    return { runs: [], gatesCreated: 0, failed: true };
  }
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

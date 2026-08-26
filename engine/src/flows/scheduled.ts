// Named export, NOT the default: under ESM/tsx the default resolves to the
// module namespace (no .parse), which silently breaks cron matching — see
// lastCronOccurrenceBetween's catch. CronExpressionParser.parse works under
// both CJS and ESM interop.
import { CronExpressionParser } from "cron-parser";
import { and, eq, sql } from "drizzle-orm";
import {
  evaluateLogicRule,
  planAutomation,
  scheduledSafeActions,
  type AutomationGraph,
  type AutomationPlan,
  type EvalContext,
} from "@openbooks/forms-core";
import { db, schema, withBypassContext, withOrg } from "../db.ts";
import { getFlowAdapter } from "./registry.ts";
import { executeFlowPlan } from "./execute.ts";
import { parseFlowGraph } from "./run.ts";

/**
 * Scheduled flow triggers on the 60-second scheduler tick
 * (engine/src/scheduler.ts).
 *
 * Anchoring: a flow fires when any of its `scheduled` trigger nodes has a
 * cron occurrence in (lastScheduledRunAt ?? createdAt, now] — a late tick or
 * downtime fast-forwards to ONE catch-up run instead of skipping. The claim
 * commits atomically with the cursor advance (CLAIM below), so concurrent
 * processes never double-fire AND a crash can never silently skip.
 *
 * Durability contract (one occurrence = one due cron tick of one scheduled
 * trigger node — `flow_scheduled_occurrences`, migration 0052):
 *
 *   CLAIM   — advancing flows.last_scheduled_run_at and inserting one ledger
 *             row per due node happen in ONE statement. A crash after commit
 *             leaves the occurrence open in the database, never lost; the old
 *             claim-then-dispatch window that could lose an occurrence is gone.
 *   FIRE    — each claimed node runs inside withOrg(flow.orgId); a successful
 *             firing closes its claim 'fired' in the SAME tenant transaction
 *             as the flow_runs rows it wrote, so delivery evidence and claim
 *             completion commit together. Retry identity is storage-enforced:
 *             each run carries a deterministic occurrence_key (unique when
 *             present) derived from flow/node/occurrence/subject, so a resumed
 *             attempt adopts the SAME flow_runs row — its effect checkpoints
 *             (`${flowId}:action:${nodeId}`) and scheduler_outbox email keys
 *             (`${runId}:email:${nodeId}`) dedupe — never a double-send.
 *   RECOVER — recoverLostScheduledFlows re-fires claims stuck 'firing'/open
 *             past the stale window exactly once more; after the retry budget
 *             is spent the loss is stamped terminal and visible instead of
 *             being retried forever.
 *
 * Scheduled plans run with the WORKER-SAFE action subset (send_email /
 * notify): the author-time lint (lintWorkerTriggerCompatibility) rejects the
 * rest, and this runner guards again at runtime — non-safe actions and gates
 * are skipped with a recorded warning rather than silently half-running.
 */

type FlowRow = typeof schema.flows.$inferSelect;

const DEFAULT_FANOUT_LIMIT = 200;
/** A firing claim older than this is considered orphaned by recovery. */
export const FLOW_OCCURRENCE_STALE_MS = 15 * 60_000;
/** Initial firing plus exactly one recovery retry; then the loss is terminal. */
const MAX_FLOW_OCCURRENCE_ATTEMPTS = 2;
const RECOVERY_BATCH = 50;

interface FlowOccurrenceClaim {
  id: string;
  orgId: string;
  flowId: string;
  nodeId: string;
  occurredAt: Date;
}

/**
 * The occurrence identity for one scheduled firing of one trigger node over
 * one subject: stable across processes and restarts, so a resumed attempt
 * resolves to the SAME flow_runs row via flow_runs.occurrence_key (migration
 * 0052), collapsing effect checkpoints and email deferrals onto one identity.
 */
function flowRunOccurrenceKey(flowId: string, nodeId: string, occurredAt: Date, subjectId: string): string {
  return `sched|${flowId}|${nodeId}|${occurredAt.toISOString()}|${subjectId}`;
}

/** Raw `db.execute` timestamps arrive as Date or driver text depending on path. */
function asDbDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Latest occurrence of `cron` in (after, until]; null when none/invalid. */
export function lastCronOccurrenceBetween(
  cron: string,
  after: Date,
  until: Date,
  tz?: string,
): Date | null {
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: after, tz: tz ?? "UTC" });
    let last: Date | null = null;
    // Bounded walk: enough for a catch-up scan without spinning on
    // pathological every-second crons.
    for (let i = 0; i < 1000; i++) {
      const next = it.next().toDate();
      if (next.getTime() > until.getTime()) break;
      last = next;
    }
    return last;
  } catch {
    return null;
  }
}

/** Which scheduled trigger nodes of a graph are due, and the latest occurrence. */
function dueScheduledNodes(
  graph: AutomationGraph,
  anchor: Date,
  now: Date,
): { nodeIds: string[]; latest: Date } | null {
  const nodeIds: string[] = [];
  let latest: Date | null = null;
  for (const node of graph.nodes) {
    if (node.data.kind !== "trigger" || node.data.trigger.trigger !== "scheduled") continue;
    const occ = lastCronOccurrenceBetween(node.data.trigger.cron, anchor, now, node.data.trigger.tz);
    if (!occ) continue;
    nodeIds.push(node.id);
    if (!latest || occ.getTime() > latest.getTime()) latest = occ;
  }
  return nodeIds.length > 0 && latest ? { nodeIds, latest } : null;
}

/**
 * Claim every due node of one flow: advance the cron cursor AND insert the
 * durable per-node occurrence rows in ONE statement, mirroring the scheduled-
 * script runner's CLAIM contract. The WHERE guard means only one scanner wins
 * the cursor advance; concurrent claims collide on the unique
 * (flow_id, node_id, occurred_at) index and see no returned rows. Returns the
 * freshly inserted (therefore un-fired) claims only.
 */
async function claimDueFlowOccurrences(
  flow: Pick<FlowRow, "id" | "orgId">,
  due: { nodeIds: string[]; latest: Date },
): Promise<FlowOccurrenceClaim[]> {
  const inserted = await withBypassContext(() =>
    db.execute<{ id: string; node_id: string }>(sql`
      with advanced as (
        update flows set last_scheduled_run_at = ${due.latest}
         where id = ${flow.id} and org_id = ${flow.orgId}
           and (last_scheduled_run_at is null or last_scheduled_run_at < ${due.latest})
        returning id
      ),
      due_nodes(node_id) as (
        values ${sql.join(due.nodeIds.map((nodeId) => sql`(${nodeId}::text)`), sql`, `)}
      )
      insert into flow_scheduled_occurrences (org_id, flow_id, node_id, occurred_at)
      select ${flow.orgId}::uuid, ${flow.id}::uuid, n.node_id, ${due.latest}
        from advanced cross join due_nodes n
       on conflict (flow_id, node_id, occurred_at) do nothing
      returning id, node_id
    `));
  return inserted.rows.map((row) => ({
    id: row.id,
    orgId: flow.orgId,
    flowId: flow.id,
    nodeId: row.node_id,
    occurredAt: due.latest,
  }));
}

/**
 * Take an open/stale claim for (re)firing — CAS fencing so concurrent ticks
 * and recovery serialize on the attempt counter; the loser observes zero
 * updated rows and skips. Returns the new attempt count, or null when the
 * claim was not takeable (already being handled elsewhere).
 */
async function takeOccurrenceForFiring(claimId: string): Promise<number | null> {
  const taken = await withBypassContext(() =>
    db.execute<{ attempt_count: number }>(sql`
      update flow_scheduled_occurrences
         set status = 'firing',
             attempt_count = attempt_count + 1,
             result = null,
             updated_at = now()
       where id = ${claimId} and status in ('open', 'firing')
      returning attempt_count
    `));
  return taken.rows[0]?.attempt_count ?? null;
}

/** Close a claim that cannot be fired to completion. */
async function stampOccurrenceLost(claimId: string, reason: string, result?: Record<string, unknown>): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update flow_scheduled_occurrences
         set status = 'lost',
             result = ${JSON.stringify({ error: reason, ...result })}::jsonb,
             updated_at = now()
       where id = ${claimId} and status <> 'lost'
    `));
}

/** Rethrow-less failure bookkeeping shared by both firing entry points. */
async function handleFiringFailure(claim: FlowOccurrenceClaim, attempt: number | null, e: unknown): Promise<void> {
  // The claim stays 'firing' — its update chain already rolled back. A crash
  // between commit points leaves recovery to pick it up; an exhausted retry
  // budget goes visibly terminal immediately instead of waiting for stale.
  const message = rootErrorMessage(e);
  if (attempt !== null && attempt >= MAX_FLOW_OCCURRENCE_ATTEMPTS) {
    await stampOccurrenceLost(claim.id, `scheduled flow occurrence lost after final attempt: ${message}`);
    return;
  }
  console.error(`[flows] scheduled occurrence ${claim.id} of flow ${claim.flowId} ("${claim.nodeId}") failed; recovery will retry:`, e);
}

/** Drizzle wraps driver errors; surface the whole causal chain's messages. */
function rootErrorMessage(e: unknown): string {
  const parts: string[] = [];
  let current: unknown = e;
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  if (current !== undefined && current != null) parts.push(String(current));
  return parts.join(" | ") || "unknown firing failure";
}

/**
 * Run ONE claimed scheduled occurrence (a single trigger node). A completed
 * pass — including passes whose plan legitimately resolved to warnings or a
 * recorded failure — closes the claim 'fired'; only host-level errors leave
 * it behind for recovery. Every run created here carries the deterministic
 * flowRuns.occurrence_key so retried/resumed attempts adopt the same rows.
 */
async function fireScheduledOccurrence(claim: FlowOccurrenceClaim): Promise<void> {
  const [flow] = await withBypassContext(() =>
    db.select().from(schema.flows)
      .where(and(eq(schema.flows.id, claim.flowId), eq(schema.flows.orgId, claim.orgId))));
  // Claimed before the flow disappeared/was disabled: never ghost-fire a
  // switched-off automation, but do not strand the claim either.
  if (!flow || !flow.enabled) {
    await stampOccurrenceLost(claim.id, "flow disabled or deleted since claim");
    return;
  }
  const graph = parseFlowGraph(flow.id, flow.graph);
  if (!graph) {
    await stampOccurrenceLost(claim.id, "flow graph failed validation since claim");
    return;
  }

  await withOrg(flow.orgId, async () => {
    await runScheduledNode(flow, graph, claim.nodeId, claim.occurredAt);
    // Completion commits WITH the runs/effects/outbox emails this firing
    // produced: a crash before here rolls those back AND leaves the claim
    // unfired; a crash after leaves them durably delivered.
    await db.execute(sql`
      update flow_scheduled_occurrences
         set status = 'fired', updated_at = now()
       where id = ${claim.id}
    `);
  });
}

/**
 * Scan every enabled flow for due scheduled triggers and run them. Called
 * from the scheduler tick (org-less/bypass, like the user_scripts scan); the
 * per-flow execution runs inside withOrg(flow.orgId).
 */
export async function runDueScheduledFlows(now: Date = new Date()): Promise<{
  fired: number;
  errors: number;
}> {
  const result = { fired: 0, errors: 0 };

  // Cheap prefilter in SQL: only flows whose graph mentions a scheduled
  // trigger at all (the jsonb containment is broad; the parse below decides).
  // Discovery and the cursor claim span organizations and cross an explicit
  // trusted boundary; the firing itself already runs inside `withOrg` below. A
  // scheduler tick holds no request store, so without this the connection layer
  // denies by default and no scheduled flow is ever found.
  const candidates = await withBypassContext(() =>
    db.execute<{ id: string }>(sql`
    select flow.id
      from flows flow
      join orgs organization on organization.id = flow.org_id
     where flow.enabled and organization.env_kind = 'production'
       and coalesce((organization.settings->'features'->>'flows')::boolean, true)
       and flow.graph::text like '%"scheduled"%'
  `));

  for (const { id } of candidates.rows) {
    const [flow] = await withBypassContext(() =>
      db.select().from(schema.flows).where(eq(schema.flows.id, id)));
    if (!flow || !flow.enabled) continue;
    const graph = parseFlowGraph(flow.id, flow.graph);
    if (!graph) continue;

    const anchor = flow.lastScheduledRunAt ?? flow.createdAt;
    const due = dueScheduledNodes(graph, anchor, now);
    if (!due) continue;

    let claims: FlowOccurrenceClaim[];
    try {
      claims = await claimDueFlowOccurrences(flow, due);
    } catch (e) {
      console.error(`[flows] scheduled claim failed for flow ${flow.id}:`, e);
      continue;
    }

    for (const claim of claims) {
      // Take is fenced (CAS): only this firing may proceed past it. Errors
      // here are attributed like any other firing failure so one bad flow
      // never breaks the rest of the scan.
      let attempt: number | null;
      try {
        attempt = await takeOccurrenceForFiring(claim.id);
      } catch (e) {
        result.errors++;
        console.error(`[flows] scheduled firing take failed for flow ${flow.id}:`, e);
        continue;
      }
      if (attempt === null) continue;
      try {
        await fireScheduledOccurrence(claim);
        result.fired++;
      } catch (e) {
        result.errors++;
        await handleFiringFailure(claim, attempt, e);
      }
    }
  }
  return result;
}

/**
 * Reconcile firing claims after crashes and lost races: attempts past their
 * budget stamp a visible terminal loss; the rest are re-fired exactly once
 * by flowRunOccurrenceKey adoption — the resumed attempt finds whatever
 * flow_runs rows the crashed attempt committed under the same key (effect
 * checkpoints + outbox emails included) and skips them instead of resending.
 */
export async function recoverLostScheduledFlows(now = new Date()): Promise<void> {
  const staleBefore = new Date(now.getTime() - FLOW_OCCURRENCE_STALE_MS);

  // 1) An attempt that already consumed its retry and still has no completion
  //    evidence is a loss: stamp it visibly instead of retrying forever
  //    (double-firing notifications is worse than a loud, durable miss).
  await withBypassContext(() =>
    db.execute(sql`
      update flow_scheduled_occurrences
         set status = 'lost',
             result = jsonb_build_object('error', 'scheduled flow occurrence lost: no completion after retry'),
             updated_at = now()
       where status = 'firing'
         and attempt_count >= ${MAX_FLOW_OCCURRENCE_ATTEMPTS}
         and updated_at < ${staleBefore}
    `));

  // 2) Resume open ('open' = died between claim and take; 'firing' = died mid
  //    firing) stale occurrences within the retry budget, oldest first.
  const stale = await withBypassContext(() =>
    db.execute<{ id: string; org_id: string; flow_id: string; node_id: string; occurred_at: Date | string }>(sql`
      select occ.id, occ.org_id, occ.flow_id, occ.node_id, occ.occurred_at
        from flow_scheduled_occurrences occ
        join orgs organization on organization.id = occ.org_id
       where occ.status in ('open', 'firing')
         and occ.attempt_count < ${MAX_FLOW_OCCURRENCE_ATTEMPTS}
         and occ.updated_at < ${staleBefore}
         and coalesce((organization.settings->'features'->>'flows')::boolean, true)
       order by occ.updated_at
       limit ${RECOVERY_BATCH}
    `));
  for (const row of stale.rows) {
    const claim: FlowOccurrenceClaim = {
      id: row.id,
      orgId: row.org_id,
      flowId: row.flow_id,
      nodeId: row.node_id,
      occurredAt: asDbDate(row.occurred_at),
    };
    // CAS bump: a concurrent completion/recovery skips; survivors are fenced.
    let attempt: number | null;
    try {
      attempt = await takeOccurrenceForFiring(claim.id);
    } catch (e) {
      console.error(`[flows] recovery take failed for flow ${claim.flowId}:`, e);
      continue;
    }
    if (attempt === null) continue;
    try {
      await fireScheduledOccurrence(claim);
    } catch (e) {
      await handleFiringFailure(claim, attempt, e);
    }
  }
}

/**
 * Runtime guard mirroring lintWorkerTriggerCompatibility: drop gates and
 * non-safe actions with a recorded warning. `hasRecord` widens the safe set
 * (fan-out runs have a real subject, so set_field is well-defined).
 */
function toSafePlan(
  plan: AutomationPlan,
  hasRecord: boolean,
  warnings: string[],
): AutomationPlan {
  const safe = scheduledSafeActions(hasRecord);
  if (plan.gates.length > 0) {
    warnings.push(`skipped ${plan.gates.length} gate(s) — scheduled runs cannot pause for approval`);
  }
  const actionNodes = plan.actionNodes.filter((n) => {
    if (safe.has(n.action.action)) return true;
    warnings.push(`skipped "${n.action.action}" — not worker-safe for scheduled runs`);
    return false;
  });
  return { actions: actionNodes.map((n) => n.action), actionNodes, gates: [] };
}

/** Execute one scheduled firing as a flow_runs row; returns the failure text. */
async function executeScheduledRun(
  flow: FlowRow,
  subjectId: string,
  occurrenceKey: string,
  plan: AutomationPlan,
  evalCtx: EvalContext,
  warnings: string[],
  submitterUserId?: string | null,
): Promise<string | null> {
  // Insert-or-adopt on the deterministic occurrence key: a first firing and
  // any resumed attempt share ONE run row (migration 0052's partial unique
  // index), so checkpoint keys and outbox keys below can never fork into a
  // second send.
  const [existing] = await db
    .select({ id: schema.flowRuns.id })
    .from(schema.flowRuns)
    .where(eq(schema.flowRuns.occurrenceKey, occurrenceKey));
  let runId = existing?.id;
  if (!runId) {
    const [inserted] = await db
      .insert(schema.flowRuns)
      .values({
        orgId: flow.orgId,
        flowId: flow.id,
        subjectKind: flow.subjectKind,
        subjectId,
        trigger: "scheduled",
        status: "running",
        context:
          subjectId === flow.id
            ? {}
            : (JSON.parse(JSON.stringify(evalCtx.values)) as Record<string, unknown>),
        occurrenceKey,
      })
      .onConflictDoNothing()
      .returning({ id: schema.flowRuns.id });
    runId = inserted?.id;
    if (!runId) {
      // Lost the unique-index race to a concurrent firing of the same
      // occurrence: adopt its run and keep executing against it — the effect
      // claims make the side effects converge on once.
      const [adopted] = await db
        .select({ id: schema.flowRuns.id })
        .from(schema.flowRuns)
        .where(eq(schema.flowRuns.occurrenceKey, occurrenceKey));
      if (!adopted) {
        throw new Error(`scheduled occurrence ${occurrenceKey} lost its adoption target run`);
      }
      runId = adopted.id;
    }
  } else {
    // Resuming a crashed attempt's row: reopen it visibly while effects run.
    await db
      .update(schema.flowRuns)
      .set({ status: "running", error: null, finishedAt: null })
      .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, flow.orgId)));
  }

  const adapter = getFlowAdapter(flow.subjectKind);
  let failedText: string | null = null;
  if (plan.actionNodes.length > 0) {
    if (!adapter) {
      failedText = `no subject adapter for "${flow.subjectKind}"`;
    } else {
      const res = await executeFlowPlan({ orgId: flow.orgId }, adapter, {
        flow: { id: flow.id, name: flow.name, subjectKind: flow.subjectKind, graph: flow.graph },
        runId,
        subjectId,
        plan,
        evalCtx,
        submitterUserId,
      });
      if (res.failed.length > 0) failedText = res.failed.join("; ");
    }
  }

  const errorText = [failedText, ...warnings].filter(Boolean).join("; ") || null;
  await db
    .update(schema.flowRuns)
    .set({
      status: failedText ? "failed" : "completed",
      error: errorText,
      finishedAt: new Date(),
    })
    .where(and(eq(schema.flowRuns.id, runId), eq(schema.flowRuns.orgId, flow.orgId)));
  return failedText;
}

/**
 * Execute one claimed scheduled trigger node: plain schedules run ONCE with
 * no record; `select` schedules FAN OUT one run per matching record (source
 * platform "scheduled workflow over a saved search"). One node = one
 * occurrence = one claim row above, so recovery resumes per trigger node.
 */
async function runScheduledNode(
  flow: FlowRow,
  graph: AutomationGraph,
  nodeId: string,
  occurredAt: Date,
): Promise<void> {
  for (const node of graph.nodes) {
    if (node.id !== nodeId) continue;
    if (node.data.kind !== "trigger" || node.data.trigger.trigger !== "scheduled") continue;

    const select = node.data.trigger.select;
    if (!select) {
      const evalCtx: EvalContext = { values: { event_source: "schedule" }, rows: {} };
      const plan = planAutomation(graph, { kind: "scheduled" }, evalCtx, {
        triggerNodeIds: [nodeId],
      });
      if (plan.actionNodes.length === 0 && plan.gates.length === 0) return;
      const warnings: string[] = [];
      const safePlan = toSafePlan(plan, false, warnings);
      // flow_runs.subject_id is NOT NULL but a record-free firing has no
      // record — the flow's own id stands in.
      await executeScheduledRun(
        flow,
        flow.id,
        flowRunOccurrenceKey(flow.id, nodeId, occurredAt, flow.id),
        safePlan,
        evalCtx,
        warnings,
      );
      return;
    }

    const adapter = getFlowAdapter(flow.subjectKind);
    if (!adapter?.findCandidateIds) {
      console.error(
        `[flows] scheduled fan-out on "${flow.subjectKind}" needs an adapter with findCandidateIds — skipped`,
      );
      return;
    }
    const limit = Math.min(select.limit ?? DEFAULT_FANOUT_LIMIT, 1_000);
    const candidateIds = await adapter.findCandidateIds(limit);
    for (const subjectId of candidateIds) {
      const subject = await adapter.loadContext(subjectId);
      if (!subject) continue;
      const evalCtx: EvalContext = {
        values: { ...subject.values, event_source: "schedule" },
        rows: subject.rows ?? {},
      };
      if (select.rule && !evaluateLogicRule(select.rule, evalCtx)) continue;

      const plan = planAutomation(graph, { kind: "scheduled" }, evalCtx, {
        triggerNodeIds: [nodeId],
      });
      if (plan.actionNodes.length === 0 && plan.gates.length === 0) continue;
      const warnings: string[] = [];
      const safePlan = toSafePlan(plan, true, warnings);
      await executeScheduledRun(
        flow,
        subjectId,
        flowRunOccurrenceKey(flow.id, nodeId, occurredAt, subjectId),
        safePlan,
        evalCtx,
        warnings,
        subject.submitterUserId,
      );
    }
    return;
  }
}

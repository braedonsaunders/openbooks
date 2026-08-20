// Named export, NOT the default: under ESM/tsx the default resolves to the
// module namespace (no .parse), which silently breaks cron matching — see
// lastCronOccurrenceBetween's catch. CronExpressionParser.parse works under
// both CJS and ESM interop.
import { CronExpressionParser } from "cron-parser";
import { eq, sql } from "drizzle-orm";
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
 * downtime fast-forwards to ONE catch-up run instead of skipping. Claiming is
 * a conditional UPDATE on flows.last_scheduled_run_at (same pattern as the
 * user_scripts scan) so concurrent processes never double-fire.
 *
 * Scheduled plans run with the WORKER-SAFE action subset (send_email /
 * notify): the author-time lint (lintWorkerTriggerCompatibility) rejects the
 * rest, and this runner guards again at runtime — non-safe actions and gates
 * are skipped with a recorded warning rather than silently half-running.
 */

type FlowRow = typeof schema.flows.$inferSelect;

const DEFAULT_FANOUT_LIMIT = 200;

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

    // Claim by advancing the cursor MONOTONICALLY — only one claimer wins
    // (both compute the same cron-quantized occurrence; the second's `<`
    // guard fails). A crash after the claim loses at most this occurrence
    // (same trade as user_scripts). Deliberately not an equality compare:
    // JS Dates carry milliseconds while timestamptz keeps microseconds, so
    // read-back equality can never match a cursor written with now().
    const claimed = await withBypassContext(() =>
      db.execute(sql`
      update flows set last_scheduled_run_at = ${due.latest}
       where id = ${flow.id}
         and (last_scheduled_run_at is null or last_scheduled_run_at < ${due.latest})
    `));
    if (!claimed.rowCount) continue;

    try {
      await withOrg(flow.orgId, () => runScheduledFlow(flow, graph, due.nodeIds));
      result.fired++;
    } catch (e) {
      result.errors++;
      console.error(`[flows] scheduled flow ${flow.id} ("${flow.name}") failed:`, e);
    }
  }
  return result;
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
  plan: AutomationPlan,
  evalCtx: EvalContext,
  warnings: string[],
  submitterUserId?: string | null,
): Promise<string | null> {
  const [run] = await db
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
    })
    .returning({ id: schema.flowRuns.id });

  const adapter = getFlowAdapter(flow.subjectKind);
  let failedText: string | null = null;
  if (plan.actionNodes.length > 0) {
    if (!adapter) {
      failedText = `no subject adapter for "${flow.subjectKind}"`;
    } else {
      const res = await executeFlowPlan({ orgId: flow.orgId }, adapter, {
        flow: { id: flow.id, name: flow.name, subjectKind: flow.subjectKind, graph: flow.graph },
        runId: run.id,
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
    .where(eq(schema.flowRuns.id, run.id));
  return failedText;
}

async function runScheduledFlow(flow: FlowRow, graph: AutomationGraph, nodeIds: string[]): Promise<void> {
  // Due nodes split by shape: plain schedules run ONCE with no record;
  // `select` schedules FAN OUT one run per matching record (source platform
  // "scheduled workflow over a saved search"). Double-firing across
  // processes is prevented by the lastScheduledRunAt claim; a crash after
  // the claim loses at most this occurrence (documented trade above).
  const plainNodeIds: string[] = [];
  const fanoutNodes: Array<{ nodeId: string; rule?: Parameters<typeof evaluateLogicRule>[0]; limit: number }> = [];
  for (const node of graph.nodes) {
    if (!nodeIds.includes(node.id)) continue;
    if (node.data.kind !== "trigger" || node.data.trigger.trigger !== "scheduled") continue;
    const select = node.data.trigger.select;
    if (select) {
      fanoutNodes.push({
        nodeId: node.id,
        rule: select.rule,
        limit: Math.min(select.limit ?? DEFAULT_FANOUT_LIMIT, 1_000),
      });
    } else {
      plainNodeIds.push(node.id);
    }
  }

  if (plainNodeIds.length > 0) {
    const evalCtx: EvalContext = { values: { event_source: "schedule" }, rows: {} };
    const plan = planAutomation(graph, { kind: "scheduled" }, evalCtx, {
      triggerNodeIds: plainNodeIds,
    });
    if (plan.actionNodes.length > 0 || plan.gates.length > 0) {
      const warnings: string[] = [];
      const safePlan = toSafePlan(plan, false, warnings);
      // flow_runs.subject_id is NOT NULL but a record-free firing has no
      // record — the flow's own id stands in.
      await executeScheduledRun(flow, flow.id, safePlan, evalCtx, warnings);
    }
  }

  const adapter = getFlowAdapter(flow.subjectKind);
  for (const node of fanoutNodes) {
    if (!adapter?.findCandidateIds) {
      console.error(
        `[flows] scheduled fan-out on "${flow.subjectKind}" needs an adapter with findCandidateIds — skipped`,
      );
      continue;
    }
    const candidateIds = await adapter.findCandidateIds(node.limit);
    for (const subjectId of candidateIds) {
      const subject = await adapter.loadContext(subjectId);
      if (!subject) continue;
      const evalCtx: EvalContext = {
        values: { ...subject.values, event_source: "schedule" },
        rows: subject.rows ?? {},
      };
      if (node.rule && !evaluateLogicRule(node.rule, evalCtx)) continue;

      const plan = planAutomation(graph, { kind: "scheduled" }, evalCtx, {
        triggerNodeIds: [node.nodeId],
      });
      if (plan.actionNodes.length === 0 && plan.gates.length === 0) continue;
      const warnings: string[] = [];
      const safePlan = toSafePlan(plan, true, warnings);
      await executeScheduledRun(flow, subjectId, safePlan, evalCtx, warnings, subject.submitterUserId);
    }
  }
}

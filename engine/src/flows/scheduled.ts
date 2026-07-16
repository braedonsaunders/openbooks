import cronParser from "cron-parser";
import { eq, sql } from "drizzle-orm";
import { planAutomation, type AutomationGraph } from "@openbooks/forms-core";
import { db, schema, withOrg } from "../db.ts";
import { getFlowAdapter } from "./registry.ts";
import { executeFlowPlan } from "./execute.ts";
import { parseFlowGraph } from "./run.ts";

/**
 * Scheduled flow triggers — ported from beaconhs-platform's
 * apps/worker/src/lib/scheduled-flow-runner.ts, adapted to the openbooks 60s
 * scheduler tick (engine/src/scheduler.ts).
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

const WORKER_SAFE_ACTIONS = new Set(["send_email", "notify"]);

type FlowRow = typeof schema.flows.$inferSelect;

/** Latest occurrence of `cron` in (after, until]; null when none/invalid. */
export function lastCronOccurrenceBetween(
  cron: string,
  after: Date,
  until: Date,
  tz?: string,
): Date | null {
  try {
    const it = cronParser.parse(cron, { currentDate: after, tz: tz ?? "UTC" });
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
  const candidates = (await db.execute(sql`
    select id from flows
     where enabled and graph::text like '%"scheduled"%'
  `)) as unknown as { rows: { id: string }[] };

  for (const { id } of candidates.rows) {
    const [flow] = await db.select().from(schema.flows).where(eq(schema.flows.id, id));
    if (!flow || !flow.enabled) continue;
    const graph = parseFlowGraph(flow.id, flow.graph);
    if (!graph) continue;

    const anchor = flow.lastScheduledRunAt ?? flow.createdAt;
    const due = dueScheduledNodes(graph, anchor, now);
    if (!due) continue;

    // Claim by advancing the cursor — only one claimer wins; a crash after
    // the claim loses at most this occurrence (same trade as user_scripts).
    const claimed = (await db.execute(sql`
      update flows set last_scheduled_run_at = ${due.latest}
       where id = ${flow.id}
         and last_scheduled_run_at is not distinct from ${flow.lastScheduledRunAt}
    `)) as unknown as { rowCount?: number };
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

async function runScheduledFlow(flow: FlowRow, graph: AutomationGraph, nodeIds: string[]): Promise<void> {
  // No subject record: an empty EvalContext (the lint keeps scheduled
  // branches to record-free actions).
  const evalCtx = { values: {}, rows: {} };
  const plan = planAutomation(graph, { kind: "scheduled" }, evalCtx, { triggerNodeIds: nodeIds });
  if (plan.actionNodes.length === 0 && plan.gates.length === 0) return;

  // Runtime guard mirroring lintWorkerTriggerCompatibility: drop gates and
  // non-worker-safe actions with a recorded warning.
  const warnings: string[] = [];
  if (plan.gates.length > 0) {
    warnings.push(`skipped ${plan.gates.length} gate(s) — scheduled runs cannot pause for approval`);
  }
  const actionNodes = plan.actionNodes.filter((n) => {
    if (WORKER_SAFE_ACTIONS.has(n.action.action)) return true;
    warnings.push(`skipped "${n.action.action}" — not worker-safe for scheduled runs`);
    return false;
  });
  const safePlan = { actions: actionNodes.map((n) => n.action), actionNodes, gates: [] };

  const [run] = await db
    .insert(schema.flowRuns)
    .values({
      orgId: flow.orgId,
      flowId: flow.id,
      subjectKind: flow.subjectKind,
      // flow_runs.subject_id is NOT NULL but a scheduled firing has no record
      // — the flow's own id stands in (see the contract note in the report).
      subjectId: flow.id,
      trigger: "scheduled",
      status: "running",
      context: {},
    })
    .returning({ id: schema.flowRuns.id });

  const adapter = getFlowAdapter(flow.subjectKind);
  let failedText: string | null = null;
  if (safePlan.actionNodes.length > 0) {
    if (!adapter) {
      failedText = `no subject adapter for "${flow.subjectKind}"`;
    } else {
      const res = await executeFlowPlan({ orgId: flow.orgId }, adapter, {
        flow: { id: flow.id, name: flow.name, subjectKind: flow.subjectKind, graph: flow.graph },
        runId: run.id,
        subjectId: flow.id,
        plan: safePlan,
        evalCtx,
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
}

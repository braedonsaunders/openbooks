import { sql } from "drizzle-orm";
import { db, schema, withBypassContext, withOrg, withOrgContext } from "../platform/db.ts";
import {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  defaultContinuousCloseDetectors,
  enabledDetectorKeys,
  normalizeContinuousCloseAnalysisSettings,
  normalizeContinuousCloseDetectors,
  type ContinuousCloseAnalysisSettings,
  type ContinuousCloseAgentKey,
  type ContinuousCloseDetectorKey,
  type ContinuousCloseDetectorPolicy,
} from "../agents/continuous-close-config.ts";
import { AGENT_PACKS } from "../agents/registry.ts";
import type { AgentFinding, AgentFindingProposal } from "../agents/types.ts";
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";

export {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  CONTINUOUS_CLOSE_DETECTOR_SPECS,
  defaultContinuousCloseAnalysisSettings,
  defaultContinuousCloseDetectors,
  normalizeContinuousCloseAnalysisSettings,
  normalizeContinuousCloseDetectors,
  type AgentModelTier,
  type ContinuousCloseAnalysisSettings,
  type ContinuousCloseAgentKey,
  type ContinuousCloseDetectorKey,
  type ContinuousCloseDetectorPolicy,
  type ContinuousCloseDetectorSpec,
  type DetectorParameterSpec,
} from "../agents/continuous-close-config.ts";

/**
 * Continuous Close control plane.
 *
 * The evidence controls are deliberately deterministic: SQL and exact money
 * arithmetic establish measured findings. A second, tool-using model layer
 * investigates records, connects drivers, and produces narratives and
 * recommendations, but never decides whether the books balance or posts.
 * Every scan refreshes stable fingerprints, replaces their evidence snapshot,
 * reopens conditions that returned, and auto-resolves conditions that cleared.
 */

export type AgentCadence = "daily" | "weekly";
export type AgentTrigger = "manual" | "scheduler";
export type { WorkItemSeverity } from "../agents/measure.ts";
export {
  classifyBudgetVariance,
  classifyForensicItem,
  classifyPeriodPerformance,
  classifyUnmatchedBankActivity,
} from "../agents/measure.ts";

export const CONTINUOUS_CLOSE_DETECTOR_VERSION = "2026.07.2";

export type ContinuousClosePolicy = {
  id: string | null;
  agentKey: ContinuousCloseAgentKey;
  enabled: boolean;
  automaticRuns: boolean;
  cadence: AgentCadence;
  materialityThreshold: string;
  detectors: ContinuousCloseDetectorPolicy[];
  analysis: ContinuousCloseAnalysisSettings;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRunStatus: "completed" | "failed" | "skipped" | "running" | null;
};


export function isContinuousCloseAgentKey(value: unknown): value is ContinuousCloseAgentKey {
  return typeof value === "string" && (CONTINUOUS_CLOSE_AGENT_KEYS as readonly string[]).includes(value);
}

export function defaultContinuousClosePolicy(agentKey: ContinuousCloseAgentKey): ContinuousClosePolicy {
  return {
    id: null,
    agentKey,
    enabled: false,
    automaticRuns: false,
    cadence: "daily",
    materialityThreshold: "1000.0000",
    detectors: defaultContinuousCloseDetectors(agentKey),
    analysis: normalizeContinuousCloseAnalysisSettings(null),
    lastRunAt: null,
    nextRunAt: null,
    lastRunStatus: null,
  };
}

export function nextContinuousCloseRunAt(cadence: AgentCadence, from = new Date()): Date {
  const next = new Date(from);
  next.setUTCDate(next.getUTCDate() + (cadence === "weekly" ? 7 : 1));
  return next;
}

export async function getContinuousClosePolicies(orgId: string): Promise<ContinuousClosePolicy[]> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select p.id, p.agent_key, p.enabled, p.automatic_runs, p.cadence,
           p.materiality_threshold, p.detector_settings, p.analysis_settings,
           p.last_run_at, p.next_run_at,
           (select r.status from ai_agent_runs r
             where r.org_id = p.org_id and r.agent_key = p.agent_key
             order by r.started_at desc limit 1) as last_run_status
      from ai_agent_policies p
     where p.org_id = ${orgId}
  `));
  const byKey = new Map(rows.rows.map((row) => [String(row.agent_key), row]));
  return CONTINUOUS_CLOSE_AGENT_KEYS.map((agentKey) => {
    const row = byKey.get(agentKey);
    if (!row) return defaultContinuousClosePolicy(agentKey);
    return {
      id: String(row.id),
      agentKey,
      enabled: Boolean(row.enabled),
      automaticRuns: Boolean(row.automatic_runs),
      cadence: row.cadence === "weekly" ? "weekly" : "daily",
      materialityThreshold: String(row.materiality_threshold),
      detectors: normalizeContinuousCloseDetectors(agentKey, row.detector_settings),
      analysis: normalizeContinuousCloseAnalysisSettings(row.analysis_settings),
      lastRunAt: row.last_run_at ? new Date(row.last_run_at as string | Date).toISOString() : null,
      nextRunAt: row.next_run_at ? new Date(row.next_run_at as string | Date).toISOString() : null,
      lastRunStatus: (row.last_run_status as ContinuousClosePolicy["lastRunStatus"]) ?? null,
    };
  });
}


/**
 * A pack's proposed command travels inside the persisted summary (no schema
 * change) so the Agent Workbench can render the same governed review card the
 * chat uses. The token is minted per viewer at render time — never stored.
 */
export function findingSummaryWithProposal(
  summary: Record<string, unknown>,
  proposal: AgentFindingProposal | null | undefined,
): Record<string, unknown> {
  if (!proposal) return summary;
  return {
    ...summary,
    proposedCommand: { tool: proposal.tool, input: proposal.input, label: proposal.label },
  };
}

async function persistFinding(orgId: string, runId: string, finding: AgentFinding): Promise<string> {
  const summary = findingSummaryWithProposal(finding.summary, finding.proposal);
  const result = (await db.execute<{ id: string }>(sql`
    insert into ai_work_items (
      org_id, agent_key, finding_type, detector_version, fingerprint, severity,
      confidence, materiality, subject_type, subject_id, summary,
      last_detected_run_id, created_by, updated_by
    ) values (
      ${orgId}, ${finding.agentKey}, ${finding.findingType}, ${CONTINUOUS_CLOSE_DETECTOR_VERSION},
      ${finding.fingerprint}, ${finding.severity}, ${finding.confidence}, ${finding.materiality},
      ${finding.subjectType ?? null}, ${finding.subjectId ?? null}, ${JSON.stringify(summary)}::jsonb,
      ${runId}, null, null
    )
    on conflict (org_id, agent_key, fingerprint) do update set
      finding_type = excluded.finding_type,
      detector_version = excluded.detector_version,
      severity = excluded.severity,
      confidence = excluded.confidence,
      materiality = excluded.materiality,
      subject_type = excluded.subject_type,
      subject_id = excluded.subject_id,
      summary = excluded.summary,
      last_detected_at = now(),
      last_detected_run_id = excluded.last_detected_run_id,
      status = case when ai_work_items.status = 'resolved' then 'open' else ai_work_items.status end,
      resolved_at = case when ai_work_items.status = 'resolved' then null else ai_work_items.resolved_at end,
      resolved_by = case when ai_work_items.status = 'resolved' then null else ai_work_items.resolved_by end,
      updated_at = now()
    where ai_work_items.org_id = ${orgId}
    returning id
  `));
  const itemId = result.rows[0]!.id;
  await db.execute(sql`delete from ai_work_item_evidence where org_id = ${orgId} and work_item_id = ${itemId}`);
  if (finding.evidence.length > 0) {
    await db.insert(schema.aiWorkItemEvidence).values(
      finding.evidence.map((evidence) => ({
        orgId,
        workItemId: itemId,
        kind: evidence.kind,
        sourceType: evidence.sourceType ?? null,
        sourceId: evidence.sourceId ?? null,
        data: evidence.data,
      })),
    );
  }
  return itemId;
}

export type ContinuousCloseRunResult = {
  runId: string;
  agentKey: ContinuousCloseAgentKey;
  status: "completed" | "failed" | "skipped";
  detected: number;
  autoResolved: number;
};

/**
 * A scheduler tick that lost the compare-and-swap claim of its occurrence to
 * a racing tick owns nothing and must write nothing — the winner's run row is
 * the occurrence's one durable execution record.
 */
export type ContinuousCloseClaimLoss = {
  status: "claimed_elsewhere";
  agentKey: ContinuousCloseAgentKey;
};

export type ContinuousCloseEnrichmentInput = {
  orgId: string;
  runId: string;
  agentKey: ContinuousCloseAgentKey;
  trigger: AgentTrigger;
  findingIds: string[];
  analysis: ContinuousCloseAnalysisSettings;
};

export type ContinuousCloseEnrichmentResult = {
  status: "completed" | "skipped" | "failed";
  analyzedFindings: number;
  /** Structured, evidence-grounded brief persisted with the immutable run. */
  narrative?: Record<string, unknown> | null;
  model?: string | null;
  toolCalls?: number;
  reason?: string;
  /**
   * Finding analyses the model produced but that matched zero rows on write
   * (the finding moved on under another run). Reported, never counted in
   * `analyzedFindings`.
   */
  supersededFindings?: string[];
};

type ContinuousCloseEnricher = (
  input: ContinuousCloseEnrichmentInput,
) => Promise<ContinuousCloseEnrichmentResult>;

type ContinuousCloseRuntime = typeof globalThis & {
  __openbooksContinuousCloseEnricher?: ContinuousCloseEnricher | null;
};

function registeredContinuousCloseEnricher(): ContinuousCloseEnricher | null {
  return (globalThis as ContinuousCloseRuntime).__openbooksContinuousCloseEnricher ?? null;
}

/**
 * The web process registers the shared chatbot tool runtime at boot. Keeping
 * the hook here lets the accounting engine schedule scans without importing
 * Next.js, while manual and scheduled runs use the same governed tools.
 */
export function registerContinuousCloseEnricher(enricher: ContinuousCloseEnricher | null): void {
  // Next's development bundler can instantiate the engine through more than
  // one module identifier (for example the instrumentation and route graphs).
  // Process-global storage keeps the registered runtime shared in that case
  // and also survives hot-reload module replacement.
  (globalThis as ContinuousCloseRuntime).__openbooksContinuousCloseEnricher = enricher;
}

/**
 * Execute one continuous-close scan.
 *
 * When `scheduledOccurrence` names the due cadence slot a scheduler tick is
 * firing, the very first statement inside this scan's transaction claims that
 * slot: the policy cursor advances by compare-and-swap on the observed
 * `next_run_at`, org-scoped to the policy row. The advance therefore commits
 * atomically WITH the durable ai_agent_runs row and every detection artifact,
 * so a process killed anywhere before commit rolls back to "still due" and the
 * next tick refires the occurrence — there is no committed cursor state that
 * is not already backed by run evidence. The claimed fire time is persisted in
 * every outcome's stats as `scheduled_for`, keeping the occurrence's
 * scheduled-for timestamp on its durable record.
 */
export async function runContinuousCloseAgent(args: {
  orgId: string;
  agentKey: ContinuousCloseAgentKey;
  trigger: AgentTrigger;
  initiatedBy?: string | null;
  scheduledOccurrence?: {
    policyId: string;
    /** Fire time this tick observed as due, claimed with a compare-and-swap. */
    claimedNextRunAt: Date;
    /** Cursor value to commit for a won claim — the next cadence step. */
    nextRunAt: Date;
  };
}): Promise<ContinuousCloseRunResult | ContinuousCloseClaimLoss> {
  type PreparedRun =
    | { kind: "terminal"; result: ContinuousCloseRunResult }
    | {
        kind: "ready";
        runId: string;
        detected: number;
        autoResolved: number;
        evaluatedDetectors: ContinuousCloseDetectorKey[];
        findingIds: string[];
        analysis: ContinuousCloseAnalysisSettings;
      }
    | { kind: "unclaimed" };

  const prepared = await withOrg(args.orgId, async (): Promise<PreparedRun> => {
    const occurrence = args.scheduledOccurrence;
    const scheduledFor = occurrence ? occurrence.claimedNextRunAt.toISOString() : null;
    const occurrenceStats = scheduledFor === null ? {} : { scheduled_for: scheduledFor };
    // Fenced recheck of the authoritative continuousClose switch INSIDE the
    // write transaction, BEFORE the occurrence claim and before any run row
    // or detection artifact. The scheduler's due-SELECT and the HTTP
    // preflights can both observe the feature ON while Company Settings
    // disables it before this transaction starts; without this recheck the
    // scan would create findings and advance its cadence while disabled, and
    // direct engine callers would bypass the switch entirely. The advisory
    // fence serializes this scan against a concurrent disable's flag write,
    // so the gate answer cannot go stale between this check and the writes
    // below. A disabled feature refuses by name: a manual scan throws, while
    // a scheduled occurrence records one skipped row (the occurrence itself
    // is NOT claimed, so the cadence slot survives for re-enable).
    await acquireOrgFeatureGateLock(db, args.orgId);
    if (!(await lockAndCheckOrgFeature(db, args.orgId, "continuousClose"))) {
      if (occurrence) {
        const [skipped] = await db
          .insert(schema.aiAgentRuns)
          .values({
            orgId: args.orgId,
            agentKey: args.agentKey,
            trigger: args.trigger,
            status: "skipped",
            detectorVersion: CONTINUOUS_CLOSE_DETECTOR_VERSION,
            initiatedBy: args.initiatedBy ?? null,
            finishedAt: new Date(),
            stats: { reason: "feature_disabled", ...occurrenceStats },
          })
          .returning({ id: schema.aiAgentRuns.id });
        return { kind: "terminal", result: { runId: skipped!.id, agentKey: args.agentKey, status: "skipped", detected: 0, autoResolved: 0 } };
      }
      throw new Error("feature_disabled");
    }
    // Claim the occurrence BEFORE anything else in this transaction. A racing
    // tick blocks on this row lock and, when the winner commits, re-evaluates
    // the WHERE against the advanced value and claims zero rows — exactly one
    // scheduler execution per occurrence, no skip-noise rows from the loser.
    if (occurrence) {
      const claim = (await db.execute<{ id: string }>(sql`
        update ai_agent_policies set next_run_at = ${occurrence.nextRunAt}, updated_at = now()
         where id = ${occurrence.policyId} and org_id = ${args.orgId}
           and next_run_at = ${occurrence.claimedNextRunAt}
        returning id
      `));
      if (!claim.rows.length) return { kind: "unclaimed" }; // another tick owns it
    }
    const lock = (await db.execute<{ acquired: boolean }>(sql`
      select pg_try_advisory_xact_lock(hashtextextended(${`${args.orgId}:${args.agentKey}`}, 0)) as acquired
    `));
    if (!lock.rows[0]?.acquired) {
      const [skipped] = await db
        .insert(schema.aiAgentRuns)
        .values({
          orgId: args.orgId,
          agentKey: args.agentKey,
          trigger: args.trigger,
          status: "skipped",
          detectorVersion: CONTINUOUS_CLOSE_DETECTOR_VERSION,
          initiatedBy: args.initiatedBy ?? null,
          finishedAt: new Date(),
          stats: { reason: "already_running", ...occurrenceStats },
        })
        .returning({ id: schema.aiAgentRuns.id });
      return { kind: "terminal", result: { runId: skipped!.id, agentKey: args.agentKey, status: "skipped", detected: 0, autoResolved: 0 } };
    }
    // The advisory transaction lock closes the insert race. The run row stays
    // 'running' from its insert until enrichment finishes AFTER this
    // transaction commits, so the durable row — not just the short detector
    // transaction — keeps a second request from starting while the first run
    // is using network-bound model tools. The 15-minute window bounds a
    // crashed run's block: detectors are statement-timeout bounded and
    // enrichment aborts at ten minutes, so a legitimate run always finishes
    // inside its lease, while a stale lease is reaped below and can never
    // wedge the scheduler.
    const active = (await db.execute<{ id: string }>(sql`
      select id from ai_agent_runs
       where org_id = ${args.orgId} and agent_key = ${args.agentKey}
         and status = 'running' and started_at > now() - interval '15 minutes'
       order by started_at desc limit 1
    `));
    if (active.rows[0]) {
      const [skipped] = await db
        .insert(schema.aiAgentRuns)
        .values({
          orgId: args.orgId,
          agentKey: args.agentKey,
          trigger: args.trigger,
          status: "skipped",
          detectorVersion: CONTINUOUS_CLOSE_DETECTOR_VERSION,
          initiatedBy: args.initiatedBy ?? null,
          finishedAt: new Date(),
          stats: { reason: "already_running", activeRunId: active.rows[0].id, ...occurrenceStats },
        })
        .returning({ id: schema.aiAgentRuns.id });
      return { kind: "terminal", result: { runId: skipped!.id, agentKey: args.agentKey, status: "skipped", detected: 0, autoResolved: 0 } };
    }
    // Reclaim leases a crashed run left behind: a 'running' row older than
    // the overlap window can never become live again, so mark it failed with
    // its abandonment on the record instead of leaving a permanently
    // 'running' row in the history. This matches zero rows when nothing
    // crashed — a conditional cleanup, not a write whose effect must show.
    await db.execute(sql`
      update ai_agent_runs
         set status = 'failed', finished_at = now(), error_code = 'abandoned',
             stats = stats || ${JSON.stringify({ reason: "abandoned_lease_reclaimed" })}::jsonb
       where org_id = ${args.orgId} and agent_key = ${args.agentKey}
         and status = 'running' and started_at <= now() - interval '15 minutes'
    `);
    const global = (await db.execute<{ enabled: boolean }>(sql`
      select coalesce((settings->'ai'->>'enabled')::boolean, true) as enabled
        from orgs where id = ${args.orgId}
    `));
    const policy = (await db.execute<{
        enabled: boolean;
        materiality_threshold: string;
        detector_settings: unknown;
        analysis_settings: unknown;
      }>(sql`
      select enabled, materiality_threshold::text, detector_settings, analysis_settings
        from ai_agent_policies where org_id = ${args.orgId} and agent_key = ${args.agentKey}
    `));
    const configured = policy.rows[0];
    const [run] = await db
      .insert(schema.aiAgentRuns)
      .values({
        orgId: args.orgId,
        agentKey: args.agentKey,
        trigger: args.trigger,
        detectorVersion: CONTINUOUS_CLOSE_DETECTOR_VERSION,
        initiatedBy: args.initiatedBy ?? null,
      })
      .returning({ id: schema.aiAgentRuns.id });
    if (!global.rows[0]?.enabled || !configured?.enabled) {
      await db.execute(sql`
        update ai_agent_runs set status = 'skipped', finished_at = now(), stats = ${JSON.stringify({ reason: "disabled", ...occurrenceStats })}::jsonb
         where id = ${run!.id} and org_id = ${args.orgId}
      `);
      return { kind: "terminal", result: { runId: run!.id, agentKey: args.agentKey, status: "skipped", detected: 0, autoResolved: 0 } };
    }
    try {
      const detectors = normalizeContinuousCloseDetectors(args.agentKey, configured.detector_settings);
      const analysis = normalizeContinuousCloseAnalysisSettings(configured.analysis_settings);
      const evaluatedDetectors = enabledDetectorKeys(detectors);
      const findings = await AGENT_PACKS[args.agentKey](args.orgId, configured.materiality_threshold, detectors);
      const findingIds: string[] = [];
      for (const finding of findings) findingIds.push(await persistFinding(args.orgId, run!.id, finding));
      const resolved =
        evaluatedDetectors.length === 0
          ? { rows: [] as { id: string }[] }
          : ((await db.execute<{ id: string }>(sql`
            update ai_work_items
               set status = 'resolved', resolved_at = now(), resolved_by = null, updated_at = now()
             where org_id = ${args.orgId} and agent_key = ${args.agentKey}
               and finding_type in (${sql.join(
                 evaluatedDetectors.map((key) => sql`${key}`),
                 sql`, `,
               )})
                and status in ('open','in_review') and last_detected_run_id is distinct from ${run!.id}
             returning id
           `)));
      // Commit the measured stats INSIDE the claimed transaction together
      // with the cursor advance and every detection artifact above — but
      // leave the run 'running': the overlap guard above must stay held
      // through the network-bound enrichment below, which runs after this
      // transaction commits. The run flips to 'completed' only once
      // enrichment has appended its brief.
      const runStats = {
        detected: findings.length,
        autoResolved: resolved.rows.length,
        evaluatedDetectors,
        ...occurrenceStats,
      };
      await db.execute(sql`
        update ai_agent_runs set stats = ${JSON.stringify(runStats)}::jsonb
         where id = ${run!.id} and org_id = ${args.orgId}
      `);
      await db.execute(sql`
        update ai_agent_policies set last_run_at = now(), updated_at = now()
         where org_id = ${args.orgId} and agent_key = ${args.agentKey}
      `);
      return {
        kind: "ready",
        runId: run!.id,
        detected: findings.length,
        autoResolved: resolved.rows.length,
        evaluatedDetectors,
        findingIds,
        analysis,
      };
    } catch (error) {
      console.error(`[continuous-close] ${args.agentKey} scan failed`, error);
      await db.execute(sql`
        update ai_agent_runs set status = 'failed', finished_at = now(), error_code = 'detector_failed', stats = ${JSON.stringify({ reason: "detector_failed", ...occurrenceStats })}::jsonb
         where id = ${run!.id} and org_id = ${args.orgId}
      `);
      return { kind: "terminal", result: { runId: run!.id, agentKey: args.agentKey, status: "failed", detected: 0, autoResolved: 0 } };
    }
  });
  if (prepared.kind === "unclaimed") {
    return { status: "claimed_elsewhere", agentKey: args.agentKey };
  }
  if (prepared.kind === "terminal") return prepared.result;

  // Enrichment is model work that must not pin the claimed transaction while
  // it runs network-bound tools. The run itself is already durable — claim,
  // detection artifacts, measured stats, and last_run_at all committed with
  // it, still 'running' so the overlap guard stays held — and enrichment
  // appends its brief and flips the run to 'completed' afterwards. A crash
  // here leaves a 'running' row whose lease expires and is reclaimed by the
  // next scan instead of losing or wedging the occurrence.
  let enrichment: ContinuousCloseEnrichmentResult = {
    status: "skipped",
    analyzedFindings: 0,
    reason: registeredContinuousCloseEnricher() ? "all_model_capabilities_disabled" : "tool_runtime_unavailable",
  };
  const modelWorkEnabled = prepared.analysis.rootCauseAnalysis || prepared.analysis.recommendations || prepared.analysis.narrative;
  const enricher = registeredContinuousCloseEnricher();
  if (enricher && modelWorkEnabled) {
    try {
      enrichment = await withOrgContext(args.orgId, () => enricher({
        orgId: args.orgId,
        runId: prepared.runId,
        agentKey: args.agentKey,
        trigger: args.trigger,
        findingIds: prepared.findingIds,
        analysis: prepared.analysis,
      }));
    } catch (error) {
      console.error(`[continuous-close] ${args.agentKey} enrichment failed`, error);
      enrichment = {
        status: "failed",
        analyzedFindings: 0,
        reason: error instanceof Error && error.message === "continuous_close_agent_timeout"
          ? "enrichment_timeout"
          : error instanceof Error && error.message.startsWith("continuous_close_evidence_validation:")
            ? "evidence_validation_failed"
            : "enrichment_failed",
      };
    }
  }
  // The completion flip is the lease release: a write that matches zero rows
  // means this run's lease is gone (reclaimed, or never committed) and the
  // enrichment must not be reported as applied.
  const completed = await withOrgContext(args.orgId, () =>
    db.execute<{ id: string }>(sql`
      update ai_agent_runs set status = 'completed', finished_at = now(), stats = stats || ${JSON.stringify({ enrichment })}::jsonb
       where id = ${prepared.runId} and org_id = ${args.orgId} and status = 'running'
      returning id
    `));
  if (!completed.rows.length) {
    console.error(`[continuous-close] ${args.agentKey} run ${prepared.runId} completion matched zero rows`);
    throw new Error("continuous_close_completion_lost");
  }
  const resultStats = {
    detected: prepared.detected,
    autoResolved: prepared.autoResolved,
    evaluatedDetectors: prepared.evaluatedDetectors,
    enrichment,
  };
  return {
    runId: prepared.runId,
    agentKey: args.agentKey,
    status: "completed",
    ...resultStats,
  };
}

/** Claim and execute every tenant policy whose automatic scan is due. */
export async function runDueContinuousCloseAgents(now = new Date()): Promise<void> {
  // Finding which tenants have an agent due spans organizations and crosses an
  // explicit trusted boundary; the agent run itself is scoped to its own org. A
  // scheduler tick holds no request store — without these the connection layer
  // denies by default and no agent ever fires.
  const due = await withBypassContext(() =>
    db.execute<{
      id: string;
      org_id: string;
      agent_key: ContinuousCloseAgentKey;
      cadence: AgentCadence;
      next_run_at: Date | string;
    }>(sql`
    select p.id, p.org_id, p.agent_key, p.cadence, p.next_run_at
      from ai_agent_policies p
      join orgs o on o.id = p.org_id
     where p.enabled and p.automatic_runs and p.next_run_at <= ${now}
       and o.env_kind = 'production'
       and coalesce((o.settings->'ai'->>'enabled')::boolean, true)
       -- Registry fallback shape: a non-boolean stored value falls back to the
       -- default instead of throwing 22P02 like the previous ::boolean cast.
       and case (o.settings->'features'->>'continuousClose') when 'true' then true when 'false' then false else true end
     order by p.next_run_at
  `));
  for (const policy of due.rows) {
    // The occurrence claim now runs INSIDE the agent's own transaction (see
    // runContinuousCloseAgent): the cursor advance commits atomically with the
    // run row it justifies, so nothing between scan and execution can strand a
    // claimed-but-unrecorded cadence slot.
    try {
      await withOrgContext(policy.org_id, () =>
        runContinuousCloseAgent({
          orgId: policy.org_id,
          agentKey: policy.agent_key,
          trigger: "scheduler",
          scheduledOccurrence: {
            policyId: policy.id,
            claimedNextRunAt: new Date(policy.next_run_at),
            nextRunAt: nextContinuousCloseRunAt(policy.cadence, now),
          },
        }));
    } catch (error) {
      // The rolled-back claim leaves the policy still due; one broken org must
      // not starve the remaining tenants of their tick.
      console.error(`[continuous-close] ${policy.agent_key} scheduler tick failed`, error);
    }
  }
}

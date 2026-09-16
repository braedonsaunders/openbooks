import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../db.ts";
import { featureEnabled } from "../feature-registry.ts";
import {
  postAllocationRun,
  previewAllocationRun,
  type PreviewAllocationRunOptions,
} from "./period-run.ts";

/**
 * Allocation scheduling (fleet A10): the scheduler-outbox kind
 * `allocation_run` and the close-automation `run_allocation` action.
 *
 * Both paths call the real period-run engine directly: preview the
 * occurrence, then post it when the version's run_policy is auto_post.
 *
 * Preview is compute-only; posting addresses the persisted previewed run.
 * The post step therefore resolves the latest previewed run for the
 * (rule, period, book) occurrence — grounded in the kernel invariant that
 * at most one previewed run exists per occurrence — and fails loudly when
 * there is none. When the post opens an approval flow (approval_flow_id
 * set) the run waits there instead of posting — that decision lives in
 * period-run.
 *
 * Invariants enforced here, not by callers:
 * - feature off ⇒ no rule fires (enqueue skips the org; processing and the
 *   close action refuse). The allocations feature defaults off.
 * - every enqueue is idempotent per occurrence key
 *   `alloc:<rule>:<period>:<book>` (unique on kind + occurrence_key).
 * - processing always previews; it posts only for `auto_post` versions.
 */
export const ALLOCATION_RUN_OUTBOX_KIND = "allocation_run" as const;

export function allocationRunOccurrenceKey(
  ruleId: string,
  periodId: string,
  bookId: string,
): string {
  return `alloc:${ruleId}:${periodId}:${bookId}`;
}

export interface RunAllocationConfig {
  ruleIds: "all" | string[];
  post: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Close-automation `run_allocation` config. Fails closed on any shape it does not recognize. */
export function parseRunAllocationConfig(config: unknown): RunAllocationConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("run_allocation requires a config object with ruleIds and post");
  }
  const { ruleIds, post } = config as { ruleIds?: unknown; post?: unknown };
  let ids: "all" | string[];
  if (ruleIds === "all") {
    ids = "all";
  } else {
    if (!Array.isArray(ruleIds) || ruleIds.length === 0) {
      throw new Error("run_allocation config ruleIds must be 'all' or a non-empty uuid array");
    }
    for (const id of ruleIds) {
      if (typeof id !== "string" || !UUID_RE.test(id)) {
        throw new Error(`run_allocation config ruleIds must be uuids, got ${JSON.stringify(id)}`);
      }
    }
    ids = [...ruleIds];
  }
  if (post !== undefined && typeof post !== "boolean") {
    throw new Error("run_allocation config post must be a boolean");
  }
  return { ruleIds: ids, post: post === true };
}

/**
 * Preview input for a fire-and-forget scheduler or close-automation firing.
 * Unattended firings run as the published version's publisher
 * (`published_by`), never a borrowed human or a faceless system actor —
 * report-backed drivers resolve under that identity, so the report
 * engine's permission checks stay authoritative. Manual runs pass the
 * requesting actor instead (see the runs API routes).
 */
export function previewInputFor(args: {
  orgId: string;
  ruleId: string;
  periodId: string;
  bookId: string;
  triggerKind: "scheduled" | "close_automation";
  publishedBy: string;
}): PreviewAllocationRunOptions {
  if (!args.publishedBy.trim()) {
    throw new Error(`allocation rule ${args.ruleId} has no publisher to attribute the unattended run to`);
  }
  return {
    orgId: args.orgId,
    ruleId: args.ruleId,
    periodId: args.periodId,
    bookId: args.bookId,
    subsidiaryId: null,
    actorId: args.publishedBy,
    trigger: args.triggerKind,
  };
}

type DueCandidate = {
  org_id: string;
  features: Record<string, boolean> | null;
  rule_id: string;
  version_id: string;
  period_id: string;
  book_id: string;
};

/**
 * Enqueue one `allocation_run` outbox row per due occurrence: every published
 * period-mode version with run_policy != 'manual', for every ended period in
 * its effective window (ended at least run_offset_days ago) and book in its
 * book scope, unless a posted, previewed, or approval-waiting run already
 * covers that (rule, period, book). Orgs with the allocations feature off
 * are skipped outright. Returns the number of newly enqueued rows.
 */
export async function ensureAllocationRunOutboxRows(
  executor: SqlExecutor = db,
): Promise<number> {
  const due = (await executor.execute<DueCandidate>(sql`
    select o.id as org_id, o.settings->'features' as features,
           r.id as rule_id, v.id as version_id, p.id as period_id, b.id as book_id
      from allocation_rule_versions v
      join allocation_rules r on r.id = v.rule_id and r.org_id = v.org_id
      join orgs o on o.id = v.org_id
      join accounting_periods p on p.org_id = v.org_id
       and p.ends_on <= current_date - v.run_offset_days
       and p.ends_on >= v.effective_from
       and (v.effective_to is null or p.starts_on <= v.effective_to)
      join accounting_books b on b.org_id = v.org_id and b.is_active
       and (case v.book_scope
              when 'primary' then b.is_primary
              when 'all_posting' then b.posts_gl
              when 'books' then v.book_ids ? b.id::text
            end)
     where v.status = 'published'
       and v.run_policy <> 'manual'
       and r.mode = 'period'
       and r.is_active
       and not exists (
         select 1 from allocation_runs run
          where run.org_id = v.org_id and run.rule_id = r.id
            and run.period_id = p.id and run.book_id = b.id
            and run.status in ('previewed', 'pending_approval', 'posted'))
  `)).rows;
  let enqueued = 0;
  for (const candidate of due) {
    if (!featureEnabled(candidate.features ?? {}, "allocations")) continue;
    const occurrenceKey = allocationRunOccurrenceKey(
      candidate.rule_id,
      candidate.period_id,
      candidate.book_id,
    );
    const inserted = await executor.execute(sql`
      insert into scheduler_outbox (org_id, kind, subject_id, occurrence_key, status, next_attempt_at, payload)
      values (${candidate.org_id}, ${ALLOCATION_RUN_OUTBOX_KIND}, ${candidate.rule_id},
              ${occurrenceKey}, 'pending', now(),
              ${JSON.stringify({
                ruleId: candidate.rule_id,
                versionId: candidate.version_id,
                periodId: candidate.period_id,
                bookId: candidate.book_id,
                trigger: "scheduled",
              })}::jsonb)
      on conflict (kind, occurrence_key) do nothing
    `);
    enqueued += inserted.rowCount ?? 0;
  }
  return enqueued;
}

type CurrentVersion = {
  version_id: string;
  run_policy: string;
  mode: string;
  is_active: boolean;
  published_by: string | null;
};

/**
 * Fire one due occurrence: preview the rule's CURRENT published version for
 * the occurrence period/book, then post it when that version's run_policy is
 * auto_post. A retired rule, an unpublished current version, a non-period
 * rule, or a switched-off feature skips quietly — the schedule legitimately
 * went away, so there is nothing to retry.
 */
export async function processAllocationRunOutboxRow(
  row: { id: string; org_id: string | null; payload: unknown },
): Promise<{ outcome: "ran" | "skipped"; note: string }> {
  if (!row.org_id) return { outcome: "skipped", note: "allocation occurrence has no org" };
  const payload = (row.payload ?? {}) as {
    ruleId?: unknown;
    periodId?: unknown;
    bookId?: unknown;
  };
  if (
    typeof payload.ruleId !== "string" ||
    typeof payload.periodId !== "string" ||
    typeof payload.bookId !== "string"
  ) {
    throw new Error("allocation_run payload requires ruleId, periodId, and bookId");
  }
  const org = (
    await db.execute<{ settings: { features?: Record<string, boolean> } | null }>(sql`
      select settings from orgs where id = ${row.org_id}
    `)
  ).rows[0];
  if (!featureEnabled(org?.settings?.features ?? {}, "allocations")) {
    return { outcome: "skipped", note: "allocations feature is off" };
  }
  const current = (
    await db.execute<CurrentVersion>(sql`
      select v.id as version_id, v.run_policy, v.published_by, r.mode, r.is_active
        from allocation_rules r
        left join allocation_rule_versions v
          on v.id = r.current_version_id and v.org_id = r.org_id and v.status = 'published'
       where r.id = ${payload.ruleId} and r.org_id = ${row.org_id}
    `)
  ).rows[0];
  if (!current?.version_id || current.mode !== "period" || !current.is_active) {
    return { outcome: "skipped", note: "rule is gone, retired, or no longer period-mode" };
  }
  if (!current.published_by) {
    throw new Error(`allocation rule ${payload.ruleId} has no publisher to attribute the unattended run to`);
  }
  const preview = previewInputFor({
    orgId: row.org_id,
    ruleId: payload.ruleId,
    periodId: payload.periodId,
    bookId: payload.bookId,
    triggerKind: "scheduled",
    publishedBy: current.published_by,
  });
  const computed = await previewAllocationRun(preview);
  if (current.run_policy === "auto_post") {
    await postPreviewedOccurrence({
      orgId: row.org_id,
      actorId: preview.actorId,
      ruleId: payload.ruleId,
      periodId: payload.periodId,
      bookId: payload.bookId,
      reason: "scheduled auto_post policy",
    });
  }
  return {
    outcome: "ran",
    note:
      current.run_policy === "auto_post"
        ? `previewed and posted (source ${computed.sourceTotal})`
        : `previewed (source ${computed.sourceTotal})`,
  };
}

/**
 * Post the latest previewed run for an occurrence. Preview computes; the
 * persisted previewed row is what posting addresses.
 */
async function postPreviewedOccurrence(args: {
  orgId: string;
  actorId: string;
  ruleId: string;
  periodId: string;
  bookId: string;
  reason: string;
}): Promise<void> {
  const run = (
    await db.execute<{ id: string }>(sql`
      select id from allocation_runs
       where org_id = ${args.orgId} and rule_id = ${args.ruleId}
         and period_id = ${args.periodId} and book_id = ${args.bookId}
         and status = 'previewed'
       order by created_at desc limit 1
    `)
  ).rows[0];
  if (!run) {
    throw new Error(
      "auto_post found no persisted previewed run for the occurrence",
    );
  }
  await postAllocationRun(run.id, args.actorId, args.reason);
}

type CloseAllocationRule = {
  id: string;
  sort_order: number;
};

/**
 * The publisher an unattended close-automation firing runs as: the
 * published version the engine would run (its current published version
 * when it covers the period, else the latest covering published version —
 * the same preference as the period-run engine's version resolution).
 * Loud when no published version exists or it records no publisher.
 */
async function resolveRulePublisher(
  orgId: string,
  ruleId: string,
  periodId: string,
): Promise<string> {
  const rows = (
    await db.execute<{ published_by: string | null }>(sql`
      select v.published_by
        from allocation_rule_versions v
        join allocation_rules r on r.id = v.rule_id and r.org_id = v.org_id
        join accounting_periods p on p.id = ${periodId} and p.org_id = v.org_id
       where v.org_id = ${orgId} and v.rule_id = ${ruleId} and v.status = 'published'
         and v.effective_from <= p.ends_on
         and (v.effective_to is null or v.effective_to >= p.starts_on)
       order by (v.id = r.current_version_id) desc, v.version_no desc
       limit 1
    `)
  ).rows;
  if (rows.length === 0) {
    throw new Error(`run_allocation rule has no published version: ${ruleId}`);
  }
  const publisher = rows[0]?.published_by;
  if (!publisher) {
    throw new Error(`allocation rule ${ruleId} has no publisher to attribute the unattended run to`);
  }
  return publisher;
}

/**
 * Close-automation `run_allocation`: preview every selected rule for the
 * close run's period/book, posting each when the action config asks for it.
 * ruleIds 'all' means every active period-mode rule with a published current
 * version, in rule order. Each rule's effects commit under a per-rule stage
 * checkpoint (via the caller's commitStage, which wraps the existing
 * idempotent execution-claim machinery), so a crash mid-fan-out resumes
 * with finished rules skipped instead of re-fired. Throws plain Errors —
 * the executor records the message as the automation failure.
 */
export async function runAllocationCloseAction(args: {
  orgId: string;
  runId: string;
  config: unknown;
  commitStage: (
    stageKey: string,
    effect: (tx: SqlExecutor) => Promise<void>,
  ) => Promise<boolean>;
}): Promise<{ previewed: number; posted: number }> {
  const { ruleIds, post } = parseRunAllocationConfig(args.config);
  const org = (
    await db.execute<{ settings: { features?: Record<string, boolean> } | null }>(sql`
      select settings from orgs where id = ${args.orgId}
    `)
  ).rows[0];
  if (!featureEnabled(org?.settings?.features ?? {}, "allocations")) {
    throw new Error("run_allocation requires the allocations feature");
  }
  const run = (
    await db.execute<{ period_id: string; book_id: string }>(sql`
      select period_id, book_id from close_runs
       where id = ${args.runId} and org_id = ${args.orgId}
    `)
  ).rows[0];
  if (!run) throw new Error("close run not found");
  let rules: CloseAllocationRule[];
  if (ruleIds === "all") {
    rules = (
      await db.execute<CloseAllocationRule>(sql`
        select r.id, r.sort_order
          from allocation_rules r
          join allocation_rule_versions v
            on v.id = r.current_version_id and v.org_id = r.org_id and v.status = 'published'
         where r.org_id = ${args.orgId} and r.mode = 'period' and r.is_active
         order by r.sort_order, r.key
      `)
    ).rows;
  } else {
    const wanted = [...new Set(ruleIds)];
    const found = (
      await db.execute<CloseAllocationRule & { mode: string; is_active: boolean }>(sql`
        select r.id, r.sort_order, r.mode, r.is_active
          from allocation_rules r
         where r.org_id = ${args.orgId}
           and r.id in (${sql.join(
             wanted.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
      `)
    ).rows;
    const seen = new Set(found.map((item) => item.id));
    for (const id of wanted) {
      if (!seen.has(id)) throw new Error(`run_allocation rule not found: ${id}`);
    }
    rules = found
      .filter((item) => item.mode === "period" && item.is_active)
      .sort((a, b) => a.sort_order - b.sort_order);
    if (rules.length !== wanted.length) {
      const missing = wanted.find((id) => !rules.some((item) => item.id === id));
      throw new Error(`run_allocation rule is not an active period rule: ${missing}`);
    }
  }
  let previewed = 0;
  let posted = 0;
  for (const rule of rules) {
    // A resumed attempt adopts the previously committed stage instead of
    // re-firing; the counts below reflect effects fired by this call.
    await args.commitStage(`allocation:${rule.id}:${run.period_id}:${run.book_id}`, async () => {
      const preview = previewInputFor({
        orgId: args.orgId,
        ruleId: rule.id,
        periodId: run.period_id,
        bookId: run.book_id,
        triggerKind: "close_automation",
        publishedBy: await resolveRulePublisher(args.orgId, rule.id, run.period_id),
      });
      await previewAllocationRun(preview);
      previewed++;
      if (post) {
        await postPreviewedOccurrence({
          orgId: args.orgId,
          actorId: preview.actorId,
          ruleId: rule.id,
          periodId: run.period_id,
          bookId: run.book_id,
          reason: "close automation requested posting",
        });
        posted++;
      }
    });
  }
  return { previewed, posted };
}

import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import { withTickClaim } from "../scheduling/lock.ts";
import { schedulerOutboxBackoffMs } from "../scheduling/outbox.ts";
import { lastCronOccurrenceBetween } from "../flows/scheduled.ts";
import { executeAutomation } from "./execute.ts";
import { automationsFeatureOn } from "./services.ts";
import { parseAutomationTrigger, type AutomationTrigger } from "./triggers.ts";

/**
 * HR-16 automation tick — schedule, date_relative, and queued-event firing.
 *
 * Driven from the web scheduler interval (web/instrumentation.node.ts starts
 * it beside the flows tick — engine modules must not depend on automations,
 * so the tick is web-composed, never an engine edge). Each firing executes
 * through executeAutomation, so the run log, idempotency key, and
 * rules→conditions→actions gate apply identically to manual runs.
 *
 * - schedule: cron occurrence in (last_run_at ?? created, now] fires once
 *   (cron-parser, the same library flows/scheduled.ts uses — semantics
 *   reused, cursor per automation row).
 * - date_relative: the daily scan matches entity date fields against
 *   today ± offset in the ORG's timezone (orgs.settings.defaultTimezone,
 *   UTC when unset). The date math is DST-safe: the scan compares civil
 *   dates in the target zone, never 24h arithmetic — proven by the DST
 *   test in a non-UTC zone.
 * - field_change / event / document: entity write services stage durable
 *   rows in automation_event_queue in-transaction (never an inline call);
 *   the tick claims staged rows exactly once and fires matching recipes.
 */

export type TickSummary = {
  schedulesFired: number;
  schedulesFailed: number;
  dateRelativeFired: number;
  dateRelativeFailed: number;
  eventsDrained: number;
  eventsFailed: number;
  errors: string[];
};

/**
 * A staged trigger event is retried with the scheduler outbox's own
 * backoff (same ceiling shape, same growth) and parks dead at the same
 * attempt ceiling — one retry contract for durable work, not two.
 */
export const MAX_AUTOMATION_EVENT_ATTEMPTS = 8;

/** Cross-replica identity for the automation scan (distinct from the web
 *  scheduler's key so the two duty sets never suppress each other). */
export const AUTOMATION_TICK_LOCK_KEY = "openbooks:automation-tick";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the automation scan on the 60-second topology beside the flows
 * scheduler (called from web/instrumentation.node.ts under the same
 * OPENBOOKS_RUN_SCHEDULER mode decision — never a new scheduler
 * infrastructure: the claim primitive, the interval shape, and the cron
 * semantics are the scheduler's own). No engine module imports this —
 * the tick is web-composed so the pinned dependency cycle never grows.
 */
export function ensureAutomationTick(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void runAutomationTickClaimed().catch((e) => console.error("[automations] tick failed:", e));
  }, intervalMs);
  timer.unref?.();
  void runAutomationTickClaimed().catch((e) => console.error("[automations] tick failed:", e));
}

export async function runAutomationTickClaimed(now: Date = new Date()): Promise<TickSummary | null> {
  if (running) return null;
  running = true;
  try {
    return await withTickClaim(AUTOMATION_TICK_LOCK_KEY, () => runAutomationTick(now));
  } finally {
    running = false;
  }
}

/** Org civil date (YYYY-MM-DD) in the org's timezone. DST-safe: the zone's
 *  calendar day, not now() minus N×24h. */
export function orgCivilDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts;
}

export function addDaysCivil(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

async function orgTimezone(orgId: string): Promise<string> {
  const rows = await db.execute<{ settings: Record<string, unknown> | null }>(sql`
    select settings from orgs where id = ${orgId} limit 1
  `);
  const tz = rows.rows[0]?.settings?.["defaultTimezone"];
  if (typeof tz === "string" && tz) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz });
      return tz;
    } catch {
      return "UTC";
    }
  }
  return "UTC";
}

const DATE_RELATIVE_SOURCES: Record<string, { table: string; dateColumn: string; entity: string }> = {
  "employment:service_start": { table: "worker_employments", dateColumn: "service_start", entity: "employment" },
  "leave_request:starts_on": { table: "hrm_leave_requests", dateColumn: "starts_on", entity: "leave_request" },
  "leave_request:ends_on": { table: "hrm_leave_requests", dateColumn: "ends_on", entity: "leave_request" },
  "enrollment:coverage_to": { table: "hrm_benefit_enrollments", dateColumn: "coverage_to", entity: "enrollment" },
};

export async function runAutomationTick(now: Date = new Date()): Promise<TickSummary> {
  const summary: TickSummary = {
    schedulesFired: 0,
    schedulesFailed: 0,
    dateRelativeFired: 0,
    dateRelativeFailed: 0,
    eventsDrained: 0,
    eventsFailed: 0,
    errors: [],
  };
  await withBypassContext(async () => {
    const automations = await db.execute<{
      id: string; orgId: string; name: string; trigger: unknown; createdAt: string; lastRunAt: string | null;
    }>(sql`
      select id, org_id as "orgId", name, trigger,
             created_at as "createdAt", last_run_at as "lastRunAt"
        from automations where status = 'enabled'
    `);
    for (const automation of automations.rows) {
      try {
        await withOrg(automation.orgId, async () => {
          // Feature-off orgs never fire, even with stale enabled rows.
          if (!(await automationsFeatureOn(automation.orgId))) return;
          const trigger = parseAutomationTrigger(automation.trigger);
          if (trigger.kind === "schedule") {
            try {
              const outcome = await fireSchedule(automation, trigger, now);
              summary.schedulesFired += outcome.fired ? 1 : 0;
              summary.schedulesFailed += outcome.failed ? 1 : 0;
            } catch (e) {
              // Pre-claim refusal (lost permission, unparseable recipe):
              // no run row exists, the cursor does not advance, and the
              // failure counts — retried next tick, never consumed.
              summary.schedulesFailed += 1;
              throw e;
            }
          } else if (trigger.kind === "date_relative") {
            const outcome = await fireDateRelative(automation, trigger, now);
            summary.dateRelativeFired += outcome.fired;
            summary.dateRelativeFailed += outcome.failed;
            summary.errors.push(...outcome.errors);
          }
        });
      } catch (e) {
        summary.errors.push(`${automation.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const drained = await drainEventQueue(now);
    summary.eventsDrained += drained.drained;
    summary.eventsFailed += drained.failed;
    summary.errors.push(...drained.errors);
  });
  return summary;
}

async function fireSchedule(
  automation: { id: string; orgId: string; createdAt: string; lastRunAt: string | null },
  trigger: Extract<AutomationTrigger, { kind: "schedule" }>,
  now: Date,
): Promise<{ fired: boolean; failed: boolean }> {
  const after = automation.lastRunAt ? new Date(automation.lastRunAt) : new Date(automation.createdAt);
  // The flows scheduler's own occurrence function (same (after, now]
  // window, same catch-up-to-one semantics) — cron semantics reused,
  // cursor per automation row. flow_scheduled_occurrences rows are FK-bound
  // to flows graph nodes and cannot host non-graph recipes without shadow
  // flows, so the cursor lives on the automation row instead.
  let occurrence: Date | null;
  try {
    occurrence = lastCronOccurrenceBetween(trigger.cron, after, now, trigger.timezone);
  } catch {
    throw new Error(`schedule trigger has an invalid cron '${trigger.cron}' — fix the trigger and save again`);
  }
  if (!occurrence) return { fired: false, failed: false };
  const result = await executeAutomation({
    orgId: automation.orgId,
    actorId: await tickActor(automation.orgId),
    automationId: automation.id,
    triggerPayload: { kind: "schedule", occurredAt: occurrence.toISOString() },
    fingerprint: `schedule:${occurrence.toISOString()}`,
  });
  if (result.status === "failed") {
    // The durable run row keeps the error and the recipe surfaces error;
    // the cursor does NOT advance, so the occurrence is not consumed as
    // success — the next tick re-reports it instead of skipping it.
    return { fired: false, failed: true };
  }
  await db.execute(sql`update automations set last_run_at = ${now} where id = ${automation.id} and org_id = ${automation.orgId}`);
  return { fired: true, failed: false };
}

async function fireDateRelative(
  automation: { id: string; orgId: string },
  trigger: Extract<AutomationTrigger, { kind: "date_relative" }>,
  now: Date,
): Promise<{ fired: number; failed: number; errors: string[] }> {
  const source = DATE_RELATIVE_SOURCES[`${trigger.entity}:${trigger.dateField}`];
  if (!source) {
    throw new Error(
      `date_relative trigger on ${trigger.entity}.${trigger.dateField} is not a scannable date — scannable: ${Object.keys(DATE_RELATIVE_SOURCES).join(", ")}`,
    );
  }
  const timezone = await orgTimezone(automation.orgId);
  const today = orgCivilDate(now, timezone);
  // direction before + offset 3 on target T means T is 3 days AFTER today:
  // match rows whose date equals today + offset (before) or today - offset (after).
  const matchDate = trigger.direction === "before"
    ? addDaysCivil(today, trigger.offsetDays)
    : addDaysCivil(today, -trigger.offsetDays);
  const rows = await db.execute<{ id: string }>(sql`
    select id from ${sql.identifier(source.table)}
     where org_id = ${automation.orgId} and ${sql.identifier(trigger.dateField)} = ${matchDate}::date
     limit 200
  `);
  const outcome = { fired: 0, failed: 0, errors: [] as string[] };
  const actorId = await tickActor(automation.orgId);
  for (const row of rows.rows) {
    try {
      const result = await executeAutomation({
        orgId: automation.orgId,
        actorId,
        automationId: automation.id,
        subjectEntity: source.entity,
        subjectId: row.id,
        triggerPayload: { kind: "date_relative", matchDate },
        fingerprint: `date_relative:${matchDate}:${row.id}`,
      });
      // A failed subject keeps its run row but is not counted fired.
      // The loop continues past failures so every subject is attempted
      // and counted on its own — previously the first throw aborted the
      // scan and discarded even the subjects that had already fired.
      if (result.status === "failed") outcome.failed += 1;
      else outcome.fired += 1;
    } catch (e) {
      outcome.failed += 1;
      outcome.errors.push(`${source.entity} ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return outcome;
}

type ClaimedEvent = {
  id: string;
  orgId: string;
  eventKind: string;
  subjectKind: string | null;
  subjectId: string | null;
  triggerFingerprint: string;
  payload: unknown;
  attemptCount: number;
};

async function drainEventQueue(now: Date): Promise<{ drained: number; failed: number; errors: string[] }> {
  const claimed = await db.execute<ClaimedEvent>(sql`
    update automation_event_queue
       set status = 'claimed', claimed_at = now()
     where id in (
       select id from automation_event_queue
        where status = 'pending'
          and (next_attempt_at is null or next_attempt_at <= now())
        order by created_at limit 100
        for update skip locked
     )
    returning id, org_id as "orgId", event_kind as "eventKind",
              subject_kind as "subjectKind", subject_id as "subjectId",
              trigger_fingerprint as "triggerFingerprint", payload,
              attempt_count as "attemptCount"
  `);
  const outcome = { drained: 0, failed: 0, errors: [] as string[] };
  for (const event of claimed.rows) {
    try {
      const firings = await fireClaimedEvent(event);
      if (firings.failed > 0) {
        await parkEventForRetry(event, firings.firstError, now);
        outcome.failed += 1;
      } else if (firings.attempted === 0 && event.attemptCount > 0) {
        // A previous attempt failed and no enabled automation remains
        // (errored or disabled since): park dead with the history named,
        // never silently done.
        await markEventDead(event, "no enabled automation remains for this event after a previous failure — inspect the automation's error state, fix it, and re-stage the trigger");
        outcome.failed += 1;
      } else {
        const finished = await db.execute(sql`update automation_event_queue set status = 'done' where id = ${event.id} and org_id = ${event.orgId}`);
        if ((finished.rowCount ?? 0) !== 1) {
          throw new Error(`event ${event.id} fired but the done-mark matched no row — refusing to count it drained`);
        }
        outcome.drained += 1;
      }
    } catch (e) {
      // The drain's own bookkeeping failed (not the firing): same retry
      // contract — a lost update retries with backoff, never vanishes.
      const message = e instanceof Error ? e.message : String(e);
      outcome.failed += 1;
      outcome.errors.push(`event ${event.id}: ${message}`);
      try {
        await parkEventForRetry(event, message, now);
      } catch {
        // The park itself lost a race (row moved on); the next tick
        // re-reads the row's true state.
      }
    }
  }
  return outcome;
}

/** Fire one claimed event against every enabled automation it matches. */
async function fireClaimedEvent(event: ClaimedEvent): Promise<{ attempted: number; failed: number; firstError: string }> {
  return withOrg(event.orgId, async () => {
    const automations = await db.execute<{ id: string; trigger: unknown }>(sql`
      select id, trigger from automations
       where org_id = ${event.orgId} and status = 'enabled'
    `);
    const actorId = await tickActor(event.orgId);
    let attempted = 0;
    let failed = 0;
    let firstError = "";
    for (const automation of automations.rows) {
      let trigger: AutomationTrigger;
      try {
        trigger = parseAutomationTrigger(automation.trigger);
      } catch (e) {
        // One unparseable recipe must not starve the event's other
        // automations — count it and keep firing the rest.
        failed += 1;
        if (!firstError) firstError = e instanceof Error ? e.message : String(e);
        continue;
      }
      if (!triggerMatchesEvent(trigger, event)) continue;
      attempted += 1;
      try {
        const result = await executeAutomation({
          orgId: event.orgId,
          actorId,
          automationId: automation.id,
          subjectEntity: event.subjectKind,
          subjectId: event.subjectId,
          previous: (event.payload as Record<string, unknown>)?.["previous"] as Record<string, unknown> | undefined,
          triggerPayload: { kind: "queued", eventKind: event.eventKind },
          fingerprint: `${event.eventKind}:${event.triggerFingerprint}`,
        });
        if (result.status === "failed") {
          failed += 1;
          if (!firstError) firstError = `automation ${automation.id} recorded a failed run — see its run log`;
        }
      } catch (e) {
        failed += 1;
        if (!firstError) firstError = e instanceof Error ? e.message : String(e);
      }
    }
    return { attempted, failed, firstError };
  });
}

/** A failed firing keeps its queue row: back off, or park dead at the ceiling. */
async function parkEventForRetry(event: ClaimedEvent, message: string, now: Date): Promise<void> {
  const attempts = event.attemptCount + 1;
  if (attempts >= MAX_AUTOMATION_EVENT_ATTEMPTS) {
    await markEventDead(event, message);
    return;
  }
  const dueAt = new Date(now.getTime() + schedulerOutboxBackoffMs(attempts));
  const updated = await db.execute(sql`
    update automation_event_queue
       set status = 'pending', attempt_count = ${attempts},
           next_attempt_at = ${dueAt}, error = ${message.slice(0, 1000)}
     where id = ${event.id} and org_id = ${event.orgId} and status = 'claimed'
  `);
  if ((updated.rowCount ?? 0) !== 1) {
    throw new Error(`event ${event.id} left 'claimed' under the drain — refusing to overwrite its state`);
  }
}

async function markEventDead(event: ClaimedEvent, message: string): Promise<void> {
  const stamped = await db.execute(sql`
    update automation_event_queue
       set status = 'dead', attempt_count = ${event.attemptCount + 1}, error = ${message.slice(0, 1000)}
     where id = ${event.id} and org_id = ${event.orgId}
  `);
  if ((stamped.rowCount ?? 0) !== 1) {
    throw new Error(`event ${event.id} could not be parked dead — the row moved under the drain; refusing to report it dead`);
  }
}

function triggerMatchesEvent(
  trigger: AutomationTrigger,
  event: { eventKind: string; subjectKind: string | null; subjectId: string | null; payload: unknown },
): boolean {
  if (trigger.kind === "field_change") {
    if (event.eventKind !== "field_change") return false;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (trigger.entity !== payload["entity"]) return false;
    if (trigger.field !== payload["field"]) return false;
    if ("to" in trigger && trigger.to !== undefined && payload["to"] !== trigger.to) return false;
    if ("from" in trigger && trigger.from !== undefined && payload["from"] !== trigger.from) return false;
    return true;
  }
  if (trigger.kind === "event") {
    return event.eventKind === "flow_event"
      && (event.payload as Record<string, unknown>)?.["subjectKind"] === trigger.subjectKind
      && (event.payload as Record<string, unknown>)?.["eventKind"] === trigger.eventKind;
  }
  if (trigger.kind === "document") {
    if (event.eventKind !== "document") return false;
    return (event.payload as Record<string, unknown>)?.["event"] === trigger.event;
  }
  return false;
}

/** Stage a trigger event in-transaction (entity write services call this —
 *  never the engine inline). Dedupes on the natural key. */
export async function stageAutomationEvent(input: {
  orgId: string;
  eventKind: string;
  subjectKind?: string | null;
  subjectId?: string | null;
  triggerFingerprint: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`
    insert into automation_event_queue (org_id, event_kind, subject_kind, subject_id, trigger_fingerprint, payload)
    values (${input.orgId}, ${input.eventKind}, ${input.subjectKind ?? null}, ${input.subjectId ?? null},
            ${input.triggerFingerprint}, ${JSON.stringify(input.payload ?? {})}::jsonb)
    on conflict (org_id, event_kind, subject_kind, subject_id, trigger_fingerprint) do nothing
  `);
  // ON CONFLICT DO NOTHING is the staging dedupe: the same trigger firing
  // twice stages once (the runs idempotency key is the second fence), and
  // the conflict row is simply absent — never a lost write.
}

async function tickActor(orgId: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    select id from users where org_id = ${orgId} and is_active order by created_at limit 1
  `);
  const id = rows.rows[0]?.id;
  if (!id) throw new Error("no active user in this org to attribute the scheduled run to");
  return id;
}

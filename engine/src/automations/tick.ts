import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import { withTickClaim } from "../scheduling/lock.ts";
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
  dateRelativeFired: number;
  eventsDrained: number;
  errors: string[];
};

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
  const summary: TickSummary = { schedulesFired: 0, dateRelativeFired: 0, eventsDrained: 0, errors: [] };
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
            if (await fireSchedule(automation, trigger, now)) summary.schedulesFired += 1;
          } else if (trigger.kind === "date_relative") {
            summary.dateRelativeFired += await fireDateRelative(automation, trigger, now);
          }
        });
      } catch (e) {
        summary.errors.push(`${automation.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    summary.eventsDrained = await drainEventQueue(now);
  });
  return summary;
}

async function fireSchedule(
  automation: { id: string; orgId: string; createdAt: string; lastRunAt: string | null },
  trigger: Extract<AutomationTrigger, { kind: "schedule" }>,
  now: Date,
): Promise<boolean> {
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
  if (!occurrence) return false;
  await executeAutomation({
    orgId: automation.orgId,
    actorId: await tickActor(automation.orgId),
    automationId: automation.id,
    triggerPayload: { kind: "schedule", occurredAt: occurrence.toISOString() },
    fingerprint: `schedule:${occurrence.toISOString()}`,
  });
  await db.execute(sql`update automations set last_run_at = ${now} where id = ${automation.id} and org_id = ${automation.orgId}`);
  return true;
}

async function fireDateRelative(
  automation: { id: string; orgId: string },
  trigger: Extract<AutomationTrigger, { kind: "date_relative" }>,
  now: Date,
): Promise<number> {
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
  let fired = 0;
  for (const row of rows.rows) {
    await executeAutomation({
      orgId: automation.orgId,
      actorId: await tickActor(automation.orgId),
      automationId: automation.id,
      subjectEntity: source.entity,
      subjectId: row.id,
      triggerPayload: { kind: "date_relative", matchDate },
      fingerprint: `date_relative:${matchDate}:${row.id}`,
    });
    fired += 1;
  }
  return fired;
}

async function drainEventQueue(now: Date): Promise<number> {
  void now;
  const claimed = await db.execute<{ id: string; orgId: string; eventKind: string; subjectKind: string | null; subjectId: string | null; triggerFingerprint: string; payload: unknown }>(sql`
    update automation_event_queue
       set status = 'claimed', claimed_at = now()
     where id in (
       select id from automation_event_queue
        where status = 'pending'
        order by created_at limit 100
        for update skip locked
     )
    returning id, org_id as "orgId", event_kind as "eventKind",
              subject_kind as "subjectKind", subject_id as "subjectId",
              trigger_fingerprint as "triggerFingerprint", payload
  `);
  let drained = 0;
  for (const event of claimed.rows) {
    try {
      await withOrg(event.orgId, async () => {
        const automations = await db.execute<{ id: string; trigger: unknown }>(sql`
          select id, trigger from automations
           where org_id = ${event.orgId} and status = 'enabled'
        `);
        for (const automation of automations.rows) {
          const trigger = parseAutomationTrigger(automation.trigger);
          if (!triggerMatchesEvent(trigger, event)) continue;
          await executeAutomation({
            orgId: event.orgId,
            actorId: await tickActor(event.orgId),
            automationId: automation.id,
            subjectEntity: event.subjectKind,
            subjectId: event.subjectId,
            previous: (event.payload as Record<string, unknown>)?.["previous"] as Record<string, unknown> | undefined,
            triggerPayload: { kind: "queued", eventKind: event.eventKind },
            fingerprint: `${event.eventKind}:${event.triggerFingerprint}`,
          });
        }
      });
      await db.execute(sql`update automation_event_queue set status = 'done' where id = ${event.id} and org_id = ${event.orgId}`);
      drained += 1;
    } catch (e) {
      await db.execute(sql`
        update automation_event_queue set status = 'failed', error = ${e instanceof Error ? e.message : String(e)}
         where id = ${event.id} and org_id = ${event.orgId}
      `);
    }
  }
  return drained;
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

import { sql } from "drizzle-orm";
import { addCalendarDays, calendarDaysBetween, endOfMonth, startOfMonth, addMonthsStart } from "../../platform/civil-date.ts";
import { businessToday } from "../../platform/business-date.ts";
import { db, orgContext, withBypass, withOrg } from "../../platform/db.ts";
import { orgFeatureEnabled } from "../../organization/org-feature-lock.ts";
import { UsageBillingError } from "./errors.ts";
import { commitRateRun, previewRateRun } from "./rate-run.ts";

export type UsageRatingCadence = "billing_period" | "monthly" | "paused";
export type UsageRatingMode = "draft" | "auto_commit";

export interface UsageRatingSchedule {
  cadence: UsageRatingCadence;
  graceDays: number;
  mode: UsageRatingMode;
  lastRatedPeriodEnd: string | null;
}

export interface UsageRatingOrgError {
  orgId: string;
  error: string;
}

export interface UsageRatingScanResult {
  rated: number;
  invoiced: number;
  drafted: number;
  failed: number;
  orgErrors: UsageRatingOrgError[];
}

const DEFAULT_SCHEDULE: UsageRatingSchedule = {
  cadence: "billing_period",
  graceDays: 2,
  mode: "draft",
  lastRatedPeriodEnd: null,
};

const SETTINGS_REMEDY = "Correct the usage_rating_settings row for this link so cadence is billing_period, monthly or paused, grace days are 0 to 30, and mode is draft or auto_commit.";

function refuse(code: string, message: string, remedy: string): never {
  throw new UsageBillingError(code, message, remedy, { status: 422 });
}

function asCadence(value: unknown, linkId: string): UsageRatingCadence {
  if (value === "billing_period" || value === "monthly" || value === "paused") return value;
  refuse("usage_rating_schedule_invalid", `The rating schedule for usage link ${linkId} has an unsupported cadence.`, SETTINGS_REMEDY);
}

function asMode(value: unknown, linkId: string): UsageRatingMode {
  if (value === "draft" || value === "auto_commit") return value;
  refuse("usage_rating_schedule_invalid", `The rating schedule for usage link ${linkId} has an unsupported mode.`, SETTINGS_REMEDY);
}

function asGraceDays(value: unknown, linkId: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 30) return value;
  refuse("usage_rating_schedule_invalid", `The rating schedule for usage link ${linkId} has grace days outside 0 to 30.`, SETTINGS_REMEDY);
}

/** Resolve the effective schedule for one link: its own row, else the org
 * default row, else the built-in default (end of each billing period, two
 * grace days, draft). Stored values are re-validated so a row that drifts
 * past its check constraint refuses by name instead of misscheduling. */
export async function resolveUsageRatingSchedule(orgId: string, linkId: string): Promise<UsageRatingSchedule> {
  const rows = (await db.execute<{
    linkId: string | null;
    cadence: unknown;
    graceDays: unknown;
    mode: unknown;
    lastRatedPeriodEnd: string | null;
  }>(sql`
    select link_id as "linkId", cadence, grace_days as "graceDays", mode,
           last_rated_period_end::text as "lastRatedPeriodEnd"
      from usage_rating_settings
     where org_id = ${orgId} and (link_id = ${linkId} or link_id is null)`)).rows;
  const linkRow = rows.find((row) => row.linkId !== null);
  const orgRow = rows.find((row) => row.linkId === null);
  const cadence = linkRow?.cadence ?? orgRow?.cadence ?? DEFAULT_SCHEDULE.cadence;
  const grace = linkRow?.graceDays ?? orgRow?.graceDays ?? DEFAULT_SCHEDULE.graceDays;
  const mode = linkRow?.mode ?? orgRow?.mode ?? DEFAULT_SCHEDULE.mode;
  return {
    cadence: asCadence(cadence, linkId),
    graceDays: asGraceDays(grace, linkId),
    mode: asMode(mode, linkId),
    lastRatedPeriodEnd: linkRow?.lastRatedPeriodEnd ?? null,
  };
}

type LinkCandidate = {
  orgId: string;
  linkId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  currentPeriodStart: string | null;
  startOn: string;
};

/** The closed rating window for one link, or null when no full period has
 * closed past the watermark yet. Billing-period cadence rates everything
 * through the day before the subscription's current period started; monthly
 * cadence rates through the end of the last fully closed calendar month. */
export function closedRatingWindow(
  link: Pick<LinkCandidate, "effectiveFrom" | "effectiveTo" | "currentPeriodStart" | "startOn">,
  cadence: Exclude<UsageRatingCadence, "paused">,
  watermark: string | null,
  today: string,
): { start: string; end: string } | null {
  const periodStart = link.currentPeriodStart ?? link.startOn;
  const end = cadence === "monthly"
    ? endOfMonth(addMonthsStart(startOfMonth(today), -1))
    : addCalendarDays(periodStart, -1);
  const clampedEnd = link.effectiveTo !== null && end > link.effectiveTo ? link.effectiveTo : end;
  const start = watermark !== null ? addCalendarDays(watermark, 1) : link.effectiveFrom;
  if (clampedEnd < start) return null;
  return { start, end: clampedEnd };
}

async function activeRunForWindow(orgId: string, linkId: string, start: string, end: string) {
  return (await db.execute<{ id: string; inputHash: string; outputHash: string; invoiceId: string | null }>(sql`
    select id, input_hash as "inputHash", output_hash as "outputHash", invoice_id as "invoiceId"
      from usage_rating_runs
     where org_id = ${orgId} and link_id = ${linkId}
       and period_start = ${start} and period_end = ${end} and status = 'active'`)).rows[0] ?? null;
}

async function advanceWatermark(
  orgId: string,
  actorId: string | null,
  linkId: string,
  schedule: UsageRatingSchedule,
  periodEnd: string,
): Promise<void> {
  // Expected on every pass after the first: the link row created by an
  // earlier rating (or by the operator) already exists, so the conflict
  // path only refreshes the watermark instead of failing the scan.
  const written = await db.execute(sql`
    insert into usage_rating_settings (id, org_id, link_id, cadence, grace_days, mode, last_rated_period_end, created_by, updated_by)
    values (gen_random_uuid(), ${orgId}, ${linkId}, ${schedule.cadence}, ${schedule.graceDays}, ${schedule.mode}, ${periodEnd}, ${actorId}, ${actorId})
    on conflict (org_id, link_id) where link_id is not null
    do update set last_rated_period_end = ${periodEnd}, updated_at = now(), updated_by = ${actorId}`);
  if ((written.rowCount ?? 0) !== 1) {
    throw new Error(`the rating watermark for usage link ${linkId} was not stored — no row was written; retry the action`);
  }
}

async function rateDueLink(
  orgId: string,
  link: LinkCandidate,
  today: string,
  result: UsageRatingScanResult,
): Promise<void> {
  const schedule = await resolveUsageRatingSchedule(orgId, link.linkId);
  if (schedule.cadence === "paused") return;
  const window = closedRatingWindow(link, schedule.cadence, schedule.lastRatedPeriodEnd, today);
  if (!window) return;
  if (calendarDaysBetween(window.end, today) <= schedule.graceDays) return;
  const existing = await activeRunForWindow(orgId, link.linkId, window.start, window.end);
  if (schedule.mode === "auto_commit") {
    // The commit path is idempotent per (link, period): an unchanged replay
    // returns the stored run, while changed inputs refuse with the
    // void-and-rebill remedy instead of double-billing.
    const committed = await commitRateRun(orgId, null, link.linkId, window.start, window.end);
    if (existing && committed.run.id === existing.id) {
      await advanceWatermark(orgId, null, link.linkId, schedule, window.end);
      return;
    }
    await advanceWatermark(orgId, null, link.linkId, schedule, window.end);
    result.rated += 1;
    if (committed.invoiceId) result.invoiced += 1;
    else result.drafted += 1;
    return;
  }
  const preview = await previewRateRun(orgId, link.linkId, window.start, window.end);
  if (existing && (existing.inputHash !== preview.inputHash || existing.outputHash !== preview.outputHash)) {
    refuse(
      "usage_rate_run_inputs_changed",
      `The records, plan, or prepaid balance for ${window.start} through ${window.end} changed after rating run ${existing.id}.`,
      `Call voidAndRebillRateRun for rating run ${existing.id} to replace its invoice and rate the changed inputs.`,
    );
  }
  // Drafts are recorded by the watermark alone: no run row and no invoice,
  // so the operator still commits the window through the runs API and a
  // later pass cannot rate it twice.
  await advanceWatermark(orgId, null, link.linkId, schedule, window.end);
  if (!existing) {
    result.rated += 1;
    result.drafted += 1;
  }
}

export async function runDueUsageRating(asOf?: string): Promise<UsageRatingScanResult> {
  const result: UsageRatingScanResult = { rated: 0, invoiced: 0, drafted: 0, failed: 0, orgErrors: [] };
  // Simulation (and other tenant-scoped callers) run this helper while an
  // ambient org context is active. Keep that context as a hard candidate
  // boundary even though the scheduler's unscoped invocation legitimately
  // scans every production tenant under bypass: without this predicate, one
  // tenant's scan would rate unrelated tenants' closed periods.
  const scopedOrgId = orgContext.getStore()?.orgId;
  const orgScope = scopedOrgId ? sql`and l.org_id = ${scopedOrgId}` : sql``;
  // bypass: scheduler-tick — the unscoped scan finds links with closed
  // periods across every production organization.
  const candidates = await withBypass(async () =>
    (await db.execute<LinkCandidate>(sql`
      select l.org_id as "orgId", l.id as "linkId",
             l.effective_from::text as "effectiveFrom", l.effective_to::text as "effectiveTo",
             s.current_period_start::text as "currentPeriodStart", s.start_on::text as "startOn"
        from subscription_usage_links l
        join subscriptions s on s.org_id = l.org_id and s.id = l.subscription_id
       where s.status = 'active' ${orgScope}
       order by l.org_id, l.id`)).rows);
  const orgDateFailures = new Map<string, string>();
  const orgToday = new Map<string, string>();
  for (const link of candidates) {
    const gated = await withOrg(link.orgId, () => orgFeatureEnabled(link.orgId, "usageBilling"));
    if (!gated) continue;
    let today = asOf ?? orgToday.get(link.orgId);
    if (!today) {
      const dateFailure = orgDateFailures.get(link.orgId);
      if (dateFailure !== undefined) {
        result.failed += 1;
        result.orgErrors.push({ orgId: link.orgId, error: `business day unavailable: ${dateFailure}` });
        continue;
      }
      try {
        today = await withOrg(link.orgId, () => businessToday(link.orgId));
        orgToday.set(link.orgId, today);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        orgDateFailures.set(link.orgId, message);
        console.error(`[usage-rating] org ${link.orgId} business day failed:`, e);
        result.failed += 1;
        result.orgErrors.push({ orgId: link.orgId, error: `business day unavailable: ${message}` });
        continue;
      }
    }
    try {
      await withOrg(link.orgId, () => rateDueLink(link.orgId, link, today, result));
    } catch (e) {
      result.failed += 1;
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
      result.orgErrors.push({ orgId: link.orgId, error: message });
    }
  }
  return result;
}

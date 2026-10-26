import { NextResponse } from "next/server";

import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { db } from "@openbooks/engine/platform/db";
import { add } from "@openbooks/engine/money/money";
import {
  pendingOccurrences,
  previewRunTokens,
  remainingOccurrences,
  type Cadence,
} from "@openbooks/engine/billing/recurring";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { isDocKindEnabled } from "@/lib/documents";
import { notFound } from "@/lib/api/responses";
import { RecurringError } from "@openbooks/engine/billing/recurring";
import {
  readScheduleForPreview,
  readTemplateSummary,
  resolveTemplateDocument,
} from "@/lib/recurring/preview-reads";

export const runtime = "nodejs";

/**
 * Malformed recurrence input answers 400 on this route (the engine names
 * these 422 by default, but the route's idiom for bad schedule input is
 * 400). The message rides in a named refusal so the sanitizer carries it;
 * anything else answers through the shared mapping, which logs the cause
 * server-side and sends a generic failure.
 */
class RecurringInputRefusal extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "RecurringInputRefusal";
  }
}

/**
 * Catch-up preview for a recurring schedule: the exact missed occurrence
 * dates from next_run_on through today (and within ends_on), with the
 * template total and the estimated total across all of them. Serves both an
 * unsaved create spec (template + cadence + dates) and a stored schedule,
 * so the create and resume dialogs choose post-all/drafts/skip against the
 * same list the run will act on.
 */
export const GET = defineRoute({
  permission: "documents.manage",
  feature: {
    none: "Recurring schedules are governed by document permissions and template kind availability.",
  },
  handler: async ({ request, authz }) => {
    const url = new URL(request.url);
    const get = (key: string): string | null => {
      const value = url.searchParams.get(key);
      return value === null || value.trim() === "" ? null : value;
    };
    const scheduleId = get("scheduleId");
    const asOf = await businessToday(authz.user.orgId);

    let templateId: string;
    let cadence: Cadence;
    let cron: string | null;
    let nextRunOn: string;
    let endsOn: string | null;
    let anchorDay: number | null;
    let runCount = 0;
    let maxOccurrences: number | null = null;
    let skippedRunOns: string[] = [];
    if (scheduleId) {
      const row = await readScheduleForPreview(
        { orgId: authz.user.orgId, allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
        scheduleId,
      );
      if (!row) return notFound("record");
      ({ templateId, cadence, cron, nextRunOn, endsOn, anchorDay } = row);
      runCount = Number(row.runCount);
      maxOccurrences = row.maxOccurrences == null ? null : Number(row.maxOccurrences);
      skippedRunOns = [...new Set(row.skippedRunOns ?? [])].sort();
    } else {
      const cadences = [
        "weekly",
        "biweekly",
        "monthly",
        "quarterly",
        "annually",
        "custom_cron",
      ] as const;
      const rawCadence = get("cadence") ?? "monthly";
      if (!(cadences as readonly string[]).includes(rawCadence)) {
        return NextResponse.json({ error: "invalid cadence" }, { status: 400 });
      }
      cadence = rawCadence as Cadence;
      cron = get("cron");
      if (cadence === "custom_cron" && !cron) {
        return NextResponse.json({ error: "cron is required for custom_cron" }, { status: 400 });
      }
      nextRunOn = get("nextRunOn") ?? asOf;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextRunOn)) {
        return NextResponse.json(
          { error: "nextRunOn must be a calendar date (YYYY-MM-DD)" },
          { status: 400 },
        );
      }
      endsOn = get("endsOn");
      if (endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) {
        return NextResponse.json(
          { error: "endsOn must be a calendar date (YYYY-MM-DD)" },
          { status: 400 },
        );
      }
      if (endsOn && endsOn < nextRunOn) {
        return NextResponse.json({ error: "endsOn must not precede nextRunOn" }, { status: 400 });
      }
      const templateDocumentId = get("templateDocumentId");
      const templateDocumentNumber = get("templateDocumentNumber");
      if (!templateDocumentId && !templateDocumentNumber) {
        return NextResponse.json(
          { error: "a template document or schedule is required" },
          { status: 400 },
        );
      }
      const resolvedTemplate = await resolveTemplateDocument(
        { orgId: authz.user.orgId, allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
        { id: templateDocumentId, number: templateDocumentNumber },
      );
      if (!resolvedTemplate) return notFound("record");
      templateId = resolvedTemplate;
      anchorDay = Number(nextRunOn.slice(8, 10));
      // An unsaved create previews its own draft bounds: the occurrence
      // limit caps the billable count and draft skips stay out of the list,
      // exactly as the stored row would behave.
      const draftMax = get("maxOccurrences");
      if (draftMax !== null && (!/^\d+$/.test(draftMax) || Number(draftMax) < 1)) {
        return NextResponse.json(
          { error: "maxOccurrences must be a positive integer" },
          { status: 400 },
        );
      }
      maxOccurrences = draftMax === null ? null : Number(draftMax);
      skippedRunOns = [];
      for (const raw of url.searchParams.getAll("skippedRunOn")) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          return NextResponse.json(
            { error: `skipped date ${raw} must be a calendar date (YYYY-MM-DD)` },
            { status: 400 },
          );
        }
        skippedRunOns.push(raw);
      }
      skippedRunOns = [...new Set(skippedRunOns)].sort();
    }

    let preview;
    try {
      preview = pendingOccurrences(
        {
          cadence,
          cron,
          nextRunOn,
          endsOn,
          anchorDay,
          skippedRunOns,
          remaining: remainingOccurrences(maxOccurrences, runCount),
        },
        asOf,
      );
    } catch (e) {
      if (e instanceof RecurringError)
        return apiErrorResponse(new RecurringInputRefusal(e.message));
      return apiErrorResponse(e);
    }
    const template = await readTemplateSummary(authz.user.orgId, templateId);
    if (!template || !(await isDocKindEnabled(authz.user.orgId, template.kind)))
      return notFound("record");
    let estimatedTotal = "0";
    for (const _date of preview.occurrences) estimatedTotal = add(estimatedTotal, template.total);
    // The next run's resolved template text for live preview. An invalid
    // stored cadence refuses here rather than serving a misleading sample.
    let sample: { occurrenceOn: string; description: string | null; memo: string | null } | null =
      null;
    try {
      sample = scheduleId
        ? await previewRunTokens(
            db,
            authz.user.orgId,
            { scheduleId },
            { locale: get("locale") ?? undefined },
          )
        : await previewRunTokens(
            db,
            authz.user.orgId,
            { templateId, cadence, cron, nextRunOn, endsOn, maxOccurrences },
            { locale: get("locale") ?? undefined },
          );
    } catch (e) {
      if (e instanceof RecurringError)
        return apiErrorResponse(new RecurringInputRefusal(e.message));
      return apiErrorResponse(e);
    }
    return NextResponse.json({
      asOf,
      occurrences: preview.occurrences,
      truncated: preview.truncated,
      templateNumber: template.number,
      templateTotal: template.total,
      currency: template.currency,
      estimatedTotal,
      sample,
      maxOccurrences,
      skippedRunOns,
    });
  },
});

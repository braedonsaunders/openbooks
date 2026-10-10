import { notFound } from "@/lib/api/responses";
import { apiErrorResponse } from '@/lib/api/error-response'
import { isoDate, uuidId, parseJsonBody } from "@/lib/api/json";
import { z } from "zod";
import {
  advanceCadence,
  assertTemplateTokensKnown,
  CATCH_UP_CHOICE_THRESHOLD,
  pendingOccurrences,
  recurringTemplateScopeFilter,
  remainingOccurrences,
  runScheduleCatchUp,
  toDateArrayLiteral,
  type CatchUpMode,
} from "@openbooks/engine/src/billing/recurring.ts";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { can } from "../../../lib/authz";
import { defineRoute } from "../../../lib/api/route";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { disabledDocKinds, isDocKindEnabled } from "../../../lib/documents.ts";

export const runtime = "nodejs";

/**
 * Malformed recurrence input answers 400 on this route (the engine names
 * these 422 by default, but the route's idiom for bad schedule input is
 * 400, matching the endsOn check below). The message rides in a named
 * refusal so the sanitizer carries it.
 */
class RecurringInputRefusal extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "RecurringInputRefusal";
  }
}

const CADENCES = ["weekly", "biweekly", "monthly", "quarterly", "annually", "custom_cron"] as const;

const catchUpSchema = z.object({
  mode: z.enum(["post_all", "drafts", "skip", "selected"]),
  dates: z.array(isoDate()).optional(),
  post: z.boolean().optional(),
});

const createSchema = z.object({
  templateDocumentId: uuidId.optional(),
  templateDocumentNumber: z.string().trim().min(1).optional(),
  cadence: z.enum(CADENCES),
  cron: z.string().trim().min(1).nullable().optional(),
  nextRunOn: isoDate().optional(),
  endsOn: isoDate().nullable().optional(),
  maxOccurrences: z.number().int().min(1).nullable().optional(),
  skippedRunOns: z.array(isoDate()).optional(),
  autoPost: z.boolean().optional(),
  name: z.string().trim().max(255).nullable().optional(),
  catchUp: catchUpSchema.optional(),
});

/**
 * Recurring schedules — a template document + a cadence. The engine runner
 * (engine/src/billing/recurring.ts, driven by the scheduler) clones the template into a
 * fresh document each time next_run_on comes due. Gated on documents.manage
 * because a schedule mints (and optionally posts) real documents. Auto-posting
 * additionally requires gl.post because the scheduler later posts due
 * documents as a system actor.
 */
export const GET = defineRoute({
  permission: "documents.manage",
  feature: { none: "Recurring schedules are governed by document permissions and template kind availability." },
  handler: async ({ authz }) => {
  const hidden = new Set(await disabledDocKinds(authz.user.orgId));
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select rs.id, rs.cadence, rs.cron, rs.next_run_on as "nextRunOn", rs.ends_on as "endsOn",
           rs.auto_post as "autoPost", rs.is_active as "isActive", rs.run_count as "runCount",
           rs.max_occurrences as "maxOccurrences", rs.skipped_run_ons::text[] as "skippedRunOns",
           rs.last_run_at as "lastRunAt", rs.last_document_id as "lastDocumentId", rs.last_error as "lastError",
           coalesce(rs.name, d.document_number) as "name", d.kind as "templateKind",
           d.document_number as "templateNumber", p.display_name as "partyName"
      from recurring_schedules rs
      join documents d on d.id = rs.template_document_id and d.org_id = rs.org_id
      left join parties p on p.id = d.party_id and p.org_id = rs.org_id
     where rs.org_id = ${authz.user.orgId}
       ${recurringTemplateScopeFilter(authz.user.orgId, sql`d.id`, sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
     order by rs.is_active desc, rs.next_run_on
  `));
  return NextResponse.json({
    schedules: rows.rows.filter((row) => !hidden.has(String(row.templateKind))),
  });
  },
});

export const POST = defineRoute({
  permission: "documents.manage",
  feature: { none: "Recurring schedules are governed by document permissions and template kind availability." },
  handler: async ({ request: req, authz }) => {
  const parsedBody = await parseJsonBody(req, createSchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const autoPost = body.autoPost ?? false;
  if (autoPost && !can(authz, "gl.post")) {
    return NextResponse.json({ error: "missing permission: gl.post" }, { status: 403 });
  }

  if (!body.templateDocumentId && !body.templateDocumentNumber) {
    return NextResponse.json({ error: "a template document is required" }, { status: 400 });
  }
  if (body.cadence === "custom_cron" && !body.cron) {
    return NextResponse.json({ error: "cron is required for custom_cron" }, { status: 400 });
  }

  const today = await businessToday(authz.user.orgId);
  const nextRunOn = body.nextRunOn ?? today;
  try { advanceCadence(nextRunOn, body.cadence, body.cron); }
  catch (error) {
    return apiErrorResponse(error instanceof Error ? new RecurringInputRefusal(error.message) : error);
  }
  if (body.endsOn && body.endsOn < nextRunOn) {
    return NextResponse.json({ error: "endsOn must not precede nextRunOn" }, { status: 400 });
  }
  // Standing seasonal skips are stored sorted and deduplicated; matching is
  // exact-date, so only true calendar dates reach the row.
  const skippedRunOns = [...new Set(body.skippedRunOns ?? [])].sort();
  const maxOccurrences = body.maxOccurrences ?? null;
  // A backlog is a choice, never a side effect: creating into two or more
  // past-due occurrences without a catch-up mode refuses with the exact
  // missed dates, so the scheduler cannot silently bulk-post them. The
  // gate counts what the run would bill — skips excluded, capped at the
  // occurrence limit — so a choice covers exactly the listed dates.
  const pending = pendingOccurrences(
    {
      cadence: body.cadence, cron: body.cron ?? null, nextRunOn, endsOn: body.endsOn ?? null,
      anchorDay: Number(nextRunOn.slice(8, 10)), skippedRunOns, remaining: remainingOccurrences(maxOccurrences, 0),
    },
    today,
  );
  if (pending.occurrences.length >= CATCH_UP_CHOICE_THRESHOLD && !body.catchUp) {
    return NextResponse.json({
      error: `${pending.occurrences.length} periods are already due — choose how to catch up instead of bulk-generating them`,
      code: "catch_up_choice_required",
      occurrences: pending.occurrences,
      truncated: pending.truncated,
    }, { status: 409 });
  }
  const created = await db.transaction(async (tx) => {
    const candidates = await tx.execute<{ id: string; kind: string }>(sql`
      select d.id, d.kind from documents d where d.org_id = ${authz.user.orgId}
        and ${body.templateDocumentId ? sql`d.id = ${body.templateDocumentId}` : sql`d.document_number = ${body.templateDocumentNumber}`}
        ${recurringTemplateScopeFilter(authz.user.orgId, sql`d.id`, sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
      order by d.id limit 2 for share of d
    `);
    // Recheck line scope after the template locks: a concurrent line edit
    // may have committed while the candidate statement waited for its parent.
    if (!candidates.rows.length) return null;
    const tpl = await tx.execute<{ id: string; kind: string }>(sql`
      select d.id, d.kind from documents d where d.org_id = ${authz.user.orgId}
        and d.id = any(${`{${candidates.rows.map(row => row.id).join(",")}}`}::uuid[])
        ${recurringTemplateScopeFilter(authz.user.orgId, sql`d.id`, sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
      order by d.id
    `);
    if (!tpl.rows.length || !(await isDocKindEnabled(authz.user.orgId, tpl.rows[0]!.kind))) return null;
    if (tpl.rows.length > 1) return "ambiguous" as const;
    const templateDocumentId = tpl.rows[0]!.id;
    // Unknown period tokens refuse at save with their names, so a misspelled
    // token can never reach a customer invoice.
    await assertTemplateTokensKnown(tx, authz.user.orgId, templateDocumentId);
    // The anchor day pins month-end starts: a schedule whose first occurrence
    // is the 31st keeps billing on the 31st (clamped per month) instead of
    // drifting. nextRunOn is a validated ISO date (checked above).
    const anchorDay = Number(nextRunOn.slice(8, 10));
    const row = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
      insert into recurring_schedules (org_id, template_document_id, cadence, cron, next_run_on, ends_on,
                                       max_occurrences, skipped_run_ons,
                                       auto_post, name, anchor_day, created_by, updated_by)
      values (${authz.user.orgId}, ${templateDocumentId}, ${body.cadence}, ${body.cron ?? null},
              ${nextRunOn}, ${body.endsOn ?? null}, ${maxOccurrences}, ${toDateArrayLiteral(skippedRunOns)}::date[],
              ${autoPost}, ${body.name ?? null}, ${anchorDay},
              ${authz.user.id}, ${authz.user.id})
      returning *
    `));
    // A schedule mints real documents on every due date, so its creation is
    // recorded in the same transaction.
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${authz.user.orgId}, 'recurring_schedules', ${row.rows[0]!.id}, 'insert',
         ${JSON.stringify({ after: row.rows[0] })}::jsonb, ${authz.user.id})
    `);
    return row.rows[0]!;
  });
  if (!created) return notFound("record");
  if (created === "ambiguous") return NextResponse.json({ error: "document number is ambiguous; select a template ID" }, { status: 400 });
  if (body.catchUp) {
    try {
      const outcome = await runScheduleCatchUp(authz.user.orgId, String(created.id), {
        mode: body.catchUp.mode as CatchUpMode,
        selectedDates: body.catchUp.dates,
        postSelected: body.catchUp.post,
        asOf: today,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      return NextResponse.json({ id: created.id, catchUp: outcome }, { status: 201 });
    } catch (e) {
      return apiErrorResponse(e);
    }
  }
  return NextResponse.json({ id: created.id }, { status: 201 });
  },
});

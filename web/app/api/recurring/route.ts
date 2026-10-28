import { notFound } from "@/lib/api/responses";
import { apiErrorResponse } from "@/lib/api/error-response";
import { recurringTemplateScopeFilter } from "@openbooks/engine/billing/recurring";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { defineRoute } from "@/lib/api/route";
import { disabledDocKinds } from "@/lib/documents";
import {
  createRecurringSchedule,
  RecurringScheduleCreateRefusal,
  recurringScheduleCreateSchema,
} from "@/lib/recurring/create-schedule";

export const runtime = "nodejs";

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
  feature: {
    none: "Recurring schedules are governed by document permissions and template kind availability.",
  },
  handler: async ({ authz }) => {
    const hidden = new Set(await disabledDocKinds(authz.user.orgId));
    const rows = await db.execute<Record<string, unknown>>(
      sql`
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
  `,
      "objects",
    );
    return NextResponse.json({
      schedules: rows.filter((row) => !hidden.has(String(row.templateKind))),
    });
  },
});

export const POST = defineRoute({
  permission: "documents.manage",
  feature: {
    none: "Recurring schedules are governed by document permissions and template kind availability.",
  },
  body: recurringScheduleCreateSchema,
  handler: async ({ authz, body }) => {
    try {
      const result = await createRecurringSchedule(authz, body);
      if (result.kind === "not_found") return notFound("record");
      if (result.kind === "ambiguous")
        return NextResponse.json(
          { error: "document number is ambiguous; select a template ID" },
          { status: 400 },
        );
      return NextResponse.json(
        { id: result.id, ...(result.catchUp ? { catchUp: result.catchUp } : {}) },
        { status: 201 },
      );
    } catch (error) {
      if (error instanceof RecurringScheduleCreateRefusal) {
        return NextResponse.json(
          { error: error.message, ...(error.code ? { code: error.code } : {}), ...error.details },
          { status: error.status },
        );
      }
      return apiErrorResponse(error);
    }
  },
});

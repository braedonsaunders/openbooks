import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { recurringTemplateScopeFilter, type Cadence } from "@openbooks/engine/billing/recurring";

type Scope = { orgId: string; allowedSubsidiaryIds: ReadonlySet<string> | null | undefined };

/** A stored recurring schedule with its template, inside the caller's template scope. */
export async function readScheduleForPreview(scope: Scope, scheduleId: string) {
  return (
    (
      await db.execute<{
        templateId: string;
        cadence: Cadence;
        cron: string | null;
        nextRunOn: string;
        endsOn: string | null;
        anchorDay: number | null;
        runCount: number;
        maxOccurrences: number | null;
        skippedRunOns: string[] | null;
      }>(
        sql`
    select rs.template_document_id as "templateId", rs.cadence, rs.cron,
           rs.next_run_on::text as "nextRunOn", rs.ends_on::text as "endsOn",
           rs.anchor_day as "anchorDay",
           rs.run_count as "runCount", rs.max_occurrences as "maxOccurrences",
           rs.skipped_run_ons::text[] as "skippedRunOns"
      from recurring_schedules rs
      join documents d on d.id = rs.template_document_id and d.org_id = rs.org_id
     where rs.id = ${scheduleId} and rs.org_id = ${scope.orgId}
       ${recurringTemplateScopeFilter(scope.orgId, sql`d.id`, sql`d.subsidiary_id`, scope.allowedSubsidiaryIds ?? null)}
  `,
        "objects",
      )
    )[0] ?? null
  );
}

/** The template document named by id or number, when exactly one is visible to the caller. */
export async function resolveTemplateDocument(
  scope: Scope,
  by: { id?: string | null; number?: string | null },
): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(
    sql`
    select d.id from documents d where d.org_id = ${scope.orgId}
      and ${by.id ? sql`d.id = ${by.id}` : sql`d.document_number = ${by.number ?? ""}`}
      ${recurringTemplateScopeFilter(scope.orgId, sql`d.id`, sql`d.subsidiary_id`, scope.allowedSubsidiaryIds ?? null)}
    order by d.id limit 2
  `,
    "objects",
  );
  return rows.length === 1 && rows[0] ? rows[0].id : null;
}

/** A template document's number, total, currency and kind. */
export async function readTemplateSummary(orgId: string, templateId: string) {
  return (
    (
      await db.execute<{ number: string; total: string; currency: string; kind: string }>(
        sql`
    select document_number as "number", total::text as "total", currency, kind
      from documents where id = ${templateId} and org_id = ${orgId}
  `,
        "objects",
      )
    )[0] ?? null
  );
}

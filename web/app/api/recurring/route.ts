import { isoDate, uuidId, parseJsonBody } from "@/lib/api/json";
import { z } from "zod";
import { advanceCadence, recurringTemplateScopeFilter } from "@openbooks/engine/src/recurring.ts";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { can, guardPermission } from "../../../lib/authz";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { disabledDocKinds, isDocKindEnabled } from "../../../lib/documents";

export const runtime = "nodejs";

const CADENCES = ["weekly", "biweekly", "monthly", "quarterly", "annually", "custom_cron"] as const;

const createSchema = z.object({
  templateDocumentId: uuidId.optional(),
  templateDocumentNumber: z.string().trim().min(1).optional(),
  cadence: z.enum(CADENCES),
  cron: z.string().trim().min(1).nullable().optional(),
  nextRunOn: isoDate().optional(),
  endsOn: isoDate().nullable().optional(),
  autoPost: z.boolean().optional(),
  name: z.string().trim().max(255).nullable().optional(),
});

/**
 * Recurring schedules — a template document + a cadence. The engine runner
 * (engine/src/recurring.ts, driven by the scheduler) clones the template into a
 * fresh document each time next_run_on comes due. Gated on documents.manage
 * because a schedule mints (and optionally posts) real documents. Auto-posting
 * additionally requires gl.post because the scheduler later posts due
 * documents as a system actor.
 */
export async function GET() {
  const authz = await guardPermission("documents.manage");
  if (authz instanceof NextResponse) return authz;
  const hidden = new Set(await disabledDocKinds(authz.user.orgId));
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select rs.id, rs.cadence, rs.cron, rs.next_run_on as "nextRunOn", rs.ends_on as "endsOn",
           rs.auto_post as "autoPost", rs.is_active as "isActive", rs.run_count as "runCount",
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
}

export async function POST(req: Request) {
  const authz = await guardPermission("documents.manage");
  if (authz instanceof NextResponse) return authz;
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

  const nextRunOn = body.nextRunOn ?? await businessToday(authz.user.orgId);
  try { advanceCadence(nextRunOn, body.cadence, body.cron); }
  catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "invalid recurrence" }, { status: 400 });
  }
  if (body.endsOn && body.endsOn < nextRunOn) {
    return NextResponse.json({ error: "endsOn must not precede nextRunOn" }, { status: 400 });
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
    const row = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
      insert into recurring_schedules (org_id, template_document_id, cadence, cron, next_run_on, ends_on,
                                       auto_post, name, created_by, updated_by)
      values (${authz.user.orgId}, ${templateDocumentId}, ${body.cadence}, ${body.cron ?? null},
              ${nextRunOn}, ${body.endsOn ?? null}, ${autoPost}, ${body.name ?? null},
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
  if (!created) return NextResponse.json({ error: "template document not found" }, { status: 404 });
  if (created === "ambiguous") return NextResponse.json({ error: "document number is ambiguous; select a template ID" }, { status: 400 });
  return NextResponse.json({ id: created.id }, { status: 201 });
}

import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { requirePermission } from "../../../lib/authz";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { disabledDocKinds, isDocKindEnabled } from "../../../lib/documents";

export const runtime = "nodejs";

const CADENCES = ["weekly", "biweekly", "monthly", "quarterly", "annually", "custom_cron"] as const;

/**
 * Recurring schedules — a template document + a cadence. The engine runner
 * (engine/src/recurring.ts, driven by the scheduler) clones the template into a
 * fresh document each time next_run_on comes due. Gated on documents.manage
 * because a schedule mints (and optionally posts) real documents.
 */
export async function GET() {
  const authz = await requirePermission("documents.manage");
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
     order by rs.is_active desc, rs.next_run_on
  `));
  return NextResponse.json({
    schedules: rows.rows.filter((row) => !hidden.has(String(row.templateKind))),
  });
}

export async function POST(req: Request) {
  const authz = await requirePermission("documents.manage");
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    templateDocumentId?: string;
    templateDocumentNumber?: string;
    cadence?: string;
    cron?: string | null;
    nextRunOn?: string;
    endsOn?: string | null;
    autoPost?: boolean;
    name?: string | null;
  };

  if (!body.templateDocumentId && !body.templateDocumentNumber) {
    return NextResponse.json({ error: "a template document is required" }, { status: 400 });
  }
  if (!body.cadence || !CADENCES.includes(body.cadence as (typeof CADENCES)[number])) {
    return NextResponse.json({ error: "invalid cadence" }, { status: 400 });
  }
  if (body.cadence === "custom_cron" && !body.cron) {
    return NextResponse.json({ error: "cron is required for custom_cron" }, { status: 400 });
  }

  // Resolve by id or by the human document number (the UI hands a number).
  const tpl = (await db.execute<{ id: string; kind: string }>(
    body.templateDocumentId
      ? sql`select id, kind from documents where id = ${body.templateDocumentId} and org_id = ${authz.user.orgId}`
      : sql`select id, kind from documents where document_number = ${body.templateDocumentNumber} and org_id = ${authz.user.orgId} limit 1`,
  ));
  if (!tpl.rows.length) {
    return NextResponse.json({ error: "template document not found" }, { status: 404 });
  }
  if (!(await isDocKindEnabled(authz.user.orgId, tpl.rows[0]!.kind))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const templateDocumentId = tpl.rows[0]!.id;

  const nextRunOn = body.nextRunOn ?? await businessToday(authz.user.orgId);
  const created = await db.transaction(async (tx) => {
    const row = (await tx.execute<Record<string, unknown>>(sql`
      insert into recurring_schedules (org_id, template_document_id, cadence, cron, next_run_on, ends_on,
                                       auto_post, name, created_by, updated_by)
      values (${authz.user.orgId}, ${templateDocumentId}, ${body.cadence}, ${body.cron ?? null},
              ${nextRunOn}, ${body.endsOn ?? null}, ${body.autoPost ?? false}, ${body.name ?? null},
              ${authz.user.id}, ${authz.user.id})
      returning *
    `));
    // A schedule mints real documents on every due date, so its creation is
    // recorded in the same transaction.
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${authz.user.orgId}, 'recurring_schedules', ${(row.rows[0] as any).id as string}, 'insert',
         ${JSON.stringify({ after: row.rows[0] })}::jsonb, ${authz.user.id})
    `);
    return row.rows[0]!;
  });
  return NextResponse.json({ id: (created as any).id as string }, { status: 201 });
}

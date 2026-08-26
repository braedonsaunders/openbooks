import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { RecurringError, runScheduleNow } from "@openbooks/engine/src/recurring.ts";
import { guardPermission } from "../../../../lib/authz";
import { isDocKindEnabled } from "../../../../lib/documents";

export const runtime = "nodejs";

async function ownedEnabled(orgId: string, id: string): Promise<boolean> {
  const r = (await db.execute<{ kind: string }>(sql`
    select d.kind
      from recurring_schedules rs
      join documents d on d.id = rs.template_document_id and d.org_id = rs.org_id
     where rs.id = ${id} and rs.org_id = ${orgId}
  `));
  const kind = r.rows[0]?.kind;
  if (!kind) return false;
  return isDocKindEnabled(orgId, kind);
}

/** Toggle active, edit cadence/dates, or rename a schedule. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await guardPermission("documents.manage");
  if (authz instanceof NextResponse) return authz;
  const { id } = await params;
  if (!(await ownedEnabled(authz.user.orgId, id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>;
  const sets: SQL[] = [];
  if ("isActive" in body) sets.push(sql`is_active = ${Boolean(body.isActive)}`);
  if ("autoPost" in body) sets.push(sql`auto_post = ${Boolean(body.autoPost)}`);
  if ("nextRunOn" in body) sets.push(sql`next_run_on = ${body.nextRunOn as string}`);
  if ("endsOn" in body) sets.push(sql`ends_on = ${(body.endsOn as string | null) ?? null}`);
  if ("name" in body) sets.push(sql`name = ${(body.name as string | null) ?? null}`);
  if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  await db.transaction(async (tx) => {
    const before = (await tx.execute<Record<string, unknown>>(sql`
      select * from recurring_schedules where id = ${id} and org_id = ${authz.user.orgId}
    `));
    const updated = (await tx.execute<Record<string, unknown>>(sql`
      update recurring_schedules set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${authz.user.id}
       where id = ${id} and org_id = ${authz.user.orgId}
      returning *
    `));
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${authz.user.orgId}, 'recurring_schedules', ${id}, 'update',
         ${JSON.stringify({ before: before.rows[0] ?? null, after: updated.rows[0] ?? null })}::jsonb,
         ${authz.user.id})
    `);
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await guardPermission("documents.manage");
  if (authz instanceof NextResponse) return authz;
  const { id } = await params;
  const outcome = await db.transaction(async (tx) => {
    // Snapshot first: deleting a schedule removes the only record of what was
    // set to post automatically. Lock it so the audit evidence is the exact
    // state that this transaction deletes.
    const existing = (await tx.execute<Record<string, unknown>>(sql`
      select * from recurring_schedules where id = ${id} and org_id = ${authz.user.orgId}
       for update
    `));
    if (!existing.rows[0]) return "not_found" as const;
    const lineage = (await tx.execute<{ linked: boolean }>(sql`
      select true as linked
        from recurring_occurrence_documents
       where schedule_id = ${id} and org_id = ${authz.user.orgId}
       limit 1
    `));
    if (lineage.rows[0]) return "generated_documents_exist" as const;
    await tx.execute(
      sql`delete from recurring_schedules where id = ${id} and org_id = ${authz.user.orgId}`,
    );
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${authz.user.orgId}, 'recurring_schedules', ${id}, 'delete',
         ${JSON.stringify({ before: existing.rows[0], after: null })}::jsonb, ${authz.user.id})
    `);
    return "deleted" as const;
  });
  if (outcome === "not_found") return NextResponse.json({ error: "not found" }, { status: 404 });
  if (outcome === "generated_documents_exist") {
    return NextResponse.json(
      {
        error: "This recurring schedule cannot be deleted because generated documents exist; their immutable lineage must be preserved.",
        code: "generated_documents_exist",
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}

/** Run now — force-generate a document from the template immediately. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await guardPermission("documents.manage");
  if (authz instanceof NextResponse) return authz;
  const { id } = await params;
  if (!(await ownedEnabled(authz.user.orgId, id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const gen = await runScheduleNow(id, authz.user.id);
    return NextResponse.json(gen);
  } catch (e) {
    if (e instanceof RecurringError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "generation failed" },
      { status: 422 },
    );
  }
}

import { isoDate, uuidId, parseJsonBody } from "@/lib/api/json";
import { z } from "zod";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/src/db.ts";
import { RecurringError, runScheduleNow, recurringTemplateScopeFilter } from "@openbooks/engine/src/recurring.ts";
import { can, guardPermission, type Authz } from "../../../../lib/authz";
import { isDocKindEnabled } from "../../../../lib/documents";

export const runtime = "nodejs";

const patchSchema = z.object({
  isActive: z.boolean().optional(), autoPost: z.boolean().optional(),
  nextRunOn: isoDate().optional(), endsOn: isoDate().nullable().optional(),
  name: z.string().trim().max(255).nullable().optional(),
});

async function ownedEnabled(exec: SqlExecutor, authz: Authz, id: string) {
  const owned = (await exec.execute<{ templateId: string }>(sql`
    select template_document_id as "templateId" from recurring_schedules
     where id = ${id} and org_id = ${authz.user.orgId} for update
  `)).rows[0];
  if (!owned) return null;
  // A line writer locks its parent. Re-evaluate execution scope in a new
  // statement after acquiring that lock, not in the waiting query's snapshot.
  await exec.execute(sql`select id from documents
    where id = ${owned.templateId} and org_id = ${authz.user.orgId} for share`);
  const r = await exec.execute<Record<string, unknown> & { kind: string; auto_post: boolean; next_run_on: string; ends_on: string | null }>(sql`
    select rs.*, d.kind from recurring_schedules rs
      join documents d on d.id = rs.template_document_id and d.org_id = rs.org_id
     where rs.id = ${id} and rs.org_id = ${authz.user.orgId}
       ${recurringTemplateScopeFilter(authz.user.orgId, sql`d.id`, sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
     for update of rs for share of d
  `);
  const row = r.rows[0];
  return row && await isDocKindEnabled(authz.user.orgId, row.kind) ? row : null;
}

/** Toggle active, edit dates, or rename a schedule. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await guardPermission("documents.manage");
  if (authz instanceof NextResponse) return authz;
  const { id } = await params;
  if (!uuidId.safeParse(id).success) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsedBody = await parseJsonBody(req, patchSchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  if (body.autoPost && !can(authz, "gl.post")) return NextResponse.json({ error: "missing permission: gl.post" }, { status: 403 });
  const sets: SQL[] = [];
  if ("isActive" in body) sets.push(sql`is_active = ${body.isActive}`);
  if ("autoPost" in body) sets.push(sql`auto_post = ${body.autoPost}`);
  if ("nextRunOn" in body) sets.push(sql`next_run_on = ${body.nextRunOn}`);
  if ("endsOn" in body) sets.push(sql`ends_on = ${body.endsOn ?? null}`);
  if ("name" in body) sets.push(sql`name = ${body.name ?? null}`);
  if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  const outcome = await db.transaction(async (tx) => {
    const before = await ownedEnabled(tx, authz, id);
    if (!before) return NextResponse.json({ error: "not found" }, { status: 404 });
    if ((body.autoPost ?? before.auto_post) && !can(authz, "gl.post")
        && (body.isActive === true || body.nextRunOn !== undefined || body.endsOn !== undefined)) {
      return NextResponse.json({ error: "missing permission: gl.post" }, { status: 403 });
    }
    const nextRunOn = body.nextRunOn ?? before.next_run_on;
    const endsOn = body.endsOn === undefined ? before.ends_on : body.endsOn;
    if (endsOn && endsOn < nextRunOn && (body.isActive ?? before.is_active)) {
      return NextResponse.json({ error: "endsOn must not precede nextRunOn" }, { status: 400 });
    }
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
         ${JSON.stringify({ before, after: updated.rows[0] ?? null })}::jsonb,
         ${authz.user.id})
    `);
  });
  return outcome ?? NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await guardPermission("documents.manage");
  if (authz instanceof NextResponse) return authz;
  const { id } = await params;
  if (!uuidId.safeParse(id).success) return NextResponse.json({ error: "not found" }, { status: 404 });
  const outcome = await db.transaction(async (tx) => {
    // Snapshot first: deleting a schedule removes the only record of what was
    // set to post automatically. Lock it so the audit evidence is the exact
    // state that this transaction deletes.
    const existing = await ownedEnabled(tx, authz, id);
    if (!existing) return "not_found" as const;
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
         ${JSON.stringify({ before: existing, after: null })}::jsonb, ${authz.user.id})
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
  if (!uuidId.safeParse(id).success) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const existing = await db.transaction(tx => ownedEnabled(tx, authz, id));
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
    const gen = await runScheduleNow(id, authz.user.id, undefined, {
      orgId: authz.user.orgId, allowedSubsidiaryIds: authz.allowedSubsidiaryIds, canPost: can(authz, "gl.post"),
    });
    return NextResponse.json(gen);
  } catch (e) {
    if (e instanceof RecurringError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "generation failed" },
      { status: 422 },
    );
  }
}

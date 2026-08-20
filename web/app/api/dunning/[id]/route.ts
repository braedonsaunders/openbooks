import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { requirePermission } from "../../../../lib/authz";

export const runtime = "nodejs";

interface StageInput {
  sequence: number;
  name: string;
  offsetDays: number;
  subjectTemplate: string;
  bodyTemplate: string;
  escalate?: boolean;
}

function validStages(raw: unknown): StageInput[] | null {
  if (!Array.isArray(raw)) return null;
  const stages: StageInput[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) return null;
    const o = s as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name.trim()) return null;
    if (typeof o.subjectTemplate !== "string" || typeof o.bodyTemplate !== "string") return null;
    if (!Number.isInteger(Number(o.sequence)) || !Number.isInteger(Number(o.offsetDays))) return null;
    stages.push({
      sequence: Number(o.sequence),
      name: o.name,
      offsetDays: Number(o.offsetDays),
      subjectTemplate: o.subjectTemplate,
      bodyTemplate: o.bodyTemplate,
      escalate: Boolean(o.escalate),
    });
  }
  if (new Set(stages.map((s) => s.sequence)).size !== stages.length) return null;
  return stages;
}

async function owned(orgId: string, id: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from dunning_policies where id = ${id} and org_id = ${orgId}`,
  ));
  return r.rows.length > 0;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission("documents.manage");
  const { id } = await params;
  if (!(await owned(authz.user.orgId, id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const stages = "stages" in body ? validStages(body.stages) : undefined;
  if (stages === null) return NextResponse.json({ error: "invalid stages" }, { status: 400 });

  await db.transaction(async (tx) => {
    const sets = [];
    if ("name" in body) sets.push(sql`name = ${body.name as string}`);
    if ("appliesToKind" in body) sets.push(sql`applies_to_kind = ${body.appliesToKind as string}`);
    if ("gracePeriodDays" in body) sets.push(sql`grace_period_days = ${Number(body.gracePeriodDays)}`);
    if ("minBalance" in body) sets.push(sql`min_balance = ${String(body.minBalance)}`);
    if ("replyTo" in body) sets.push(sql`reply_to = ${(body.replyTo as string | null) ?? null}`);
    if ("isActive" in body) sets.push(sql`is_active = ${Boolean(body.isActive)}`);
    if (sets.length) {
      await tx.execute(sql`
        update dunning_policies set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${authz.user.id}
         where id = ${id} and org_id = ${authz.user.orgId}
      `);
    }
    if (stages) {
      // Replace the ladder as one unit. dunning_log rows are append-only and
      // keep their own copy of what was sent, so pruning stages is safe.
      await tx.execute(sql`delete from dunning_stages where policy_id = ${id} and org_id = ${authz.user.orgId}`);
      for (const s of stages) {
        await tx.execute(sql`
          insert into dunning_stages (org_id, policy_id, sequence, name, offset_days, subject_template,
                                      body_template, escalate, created_by, updated_by)
          values (${authz.user.orgId}, ${id}, ${s.sequence}, ${s.name}, ${s.offsetDays},
                  ${s.subjectTemplate}, ${s.bodyTemplate}, ${s.escalate ?? false}, ${authz.user.id}, ${authz.user.id})
        `);
      }
    }
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission("documents.manage");
  const { id } = await params;
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from dunning_stages where policy_id = ${id} and org_id = ${authz.user.orgId}`);
    await tx.execute(sql`delete from dunning_policies where id = ${id} and org_id = ${authz.user.orgId}`);
  });
  return NextResponse.json({ ok: true });
}

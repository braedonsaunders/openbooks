import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { requirePermission } from "../../../../lib/authz";
import { canonicalDecimal, compareDecimal } from "../../../../lib/exact-decimal";

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
  let minBalance: string | undefined;
  if ("minBalance" in body) {
    const minBalanceRaw = canonicalDecimal(body.minBalance, 4);
    if (minBalanceRaw === null || compareDecimal(minBalanceRaw, "0") < 0) {
      return NextResponse.json({ error: "minBalance must be a non-negative amount" }, { status: 400 });
    }
    minBalance = normalizeMoney(minBalanceRaw);
  }

  await db.transaction(async (tx) => {
    // Snapshot the current policy and its ladder before anything changes.
    const beforePolicy = (await tx.execute<Record<string, unknown>>(sql`
      select * from dunning_policies where id = ${id} and org_id = ${authz.user.orgId}
    `));
    const beforeStages = (await tx.execute<Record<string, unknown>>(sql`
      select * from dunning_stages where policy_id = ${id} and org_id = ${authz.user.orgId} order by sequence
    `));
    const sets = [];
    if ("name" in body) sets.push(sql`name = ${body.name as string}`);
    if ("appliesToKind" in body) sets.push(sql`applies_to_kind = ${body.appliesToKind as string}`);
    if ("gracePeriodDays" in body) sets.push(sql`grace_period_days = ${Number(body.gracePeriodDays)}`);
    if (minBalance !== undefined) sets.push(sql`min_balance = ${minBalance}`);
    if ("replyTo" in body) sets.push(sql`reply_to = ${(body.replyTo as string | null) ?? null}`);
    if ("isActive" in body) sets.push(sql`is_active = ${Boolean(body.isActive)}`);
    let afterPolicy: Record<string, unknown> | undefined;
    if (sets.length) {
      const updated = (await tx.execute<Record<string, unknown>>(sql`
        update dunning_policies set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${authz.user.id}
         where id = ${id} and org_id = ${authz.user.orgId}
        returning *
      `));
      afterPolicy = updated.rows[0];
    }
    let afterStages: Record<string, unknown>[] | undefined;
    if (stages) {
      // Replace the ladder as one unit. dunning_log rows are append-only and
      // keep their own copy of what was sent, so pruning stages is safe.
      await tx.execute(sql`delete from dunning_stages where policy_id = ${id} and org_id = ${authz.user.orgId}`);
      afterStages = [];
      for (const s of stages) {
        const stageRow = (await tx.execute<Record<string, unknown>>(sql`
          insert into dunning_stages (org_id, policy_id, sequence, name, offset_days, subject_template,
                                      body_template, escalate, created_by, updated_by)
          values (${authz.user.orgId}, ${id}, ${s.sequence}, ${s.name}, ${s.offsetDays},
                  ${s.subjectTemplate}, ${s.bodyTemplate}, ${s.escalate ?? false}, ${authz.user.id}, ${authz.user.id})
          returning *
        `));
        afterStages.push(stageRow.rows[0]!);
      }
    }
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${authz.user.orgId}, 'dunning_policies', ${id}, 'update',
         ${JSON.stringify({
           before: { ...beforePolicy.rows[0], stages: beforeStages.rows },
           after: {
             ...(afterPolicy ?? beforePolicy.rows[0]),
             stages: afterStages ?? beforeStages.rows,
           },
         })}::jsonb,
         ${authz.user.id})
    `);
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission("documents.manage");
  const { id } = await params;
  await db.transaction(async (tx) => {
    // Snapshot policy and ladder first: deletion removes the only record of
    // how this org chased overdue invoices.
    const beforePolicy = (await tx.execute<Record<string, unknown>>(sql`
      select * from dunning_policies where id = ${id} and org_id = ${authz.user.orgId}
    `));
    if (!beforePolicy.rows[0]) return;
    const beforeStages = (await tx.execute<Record<string, unknown>>(sql`
      select * from dunning_stages where policy_id = ${id} and org_id = ${authz.user.orgId} order by sequence
    `));
    await tx.execute(sql`delete from dunning_stages where policy_id = ${id} and org_id = ${authz.user.orgId}`);
    await tx.execute(sql`delete from dunning_policies where id = ${id} and org_id = ${authz.user.orgId}`);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${authz.user.orgId}, 'dunning_policies', ${id}, 'delete',
         ${JSON.stringify({ before: { ...beforePolicy.rows[0], stages: beforeStages.rows } })}::jsonb,
         ${authz.user.id})
    `);
  });
  return NextResponse.json({ ok: true });
}

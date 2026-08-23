import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { requirePermission } from "../../../lib/authz";
import { canonicalDecimal, compareDecimal } from "../../../lib/exact-decimal";

export const runtime = "nodejs";

/**
 * Dunning policies — an ordered ladder of reminder stages fired against overdue
 * invoices by engine/src/dunning.ts. A policy carries its stages inline; saving
 * replaces the whole stage set so the ladder is edited as one unit.
 */
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
    stages.push({
      sequence: Number(o.sequence),
      name: o.name,
      offsetDays: Number(o.offsetDays),
      subjectTemplate: o.subjectTemplate,
      bodyTemplate: o.bodyTemplate,
      escalate: Boolean(o.escalate),
    });
  }
  // Enforce unique, ascending sequences (the DB has a unique index too).
  const seqs = new Set(stages.map((s) => s.sequence));
  if (seqs.size !== stages.length) return null;
  if (stages.some((s) => !Number.isInteger(s.sequence) || !Number.isInteger(s.offsetDays))) return null;
  return stages;
}

export async function GET() {
  const authz = await requirePermission("documents.manage");
  const policies = (await db.execute<Record<string, unknown>>(sql`
    select id, name, applies_to_kind as "appliesToKind", grace_period_days as "gracePeriodDays",
           min_balance as "minBalance", reply_to as "replyTo", is_active as "isActive"
      from dunning_policies where org_id = ${authz.user.orgId} order by name
  `));
  const stages = (await db.execute<Record<string, unknown>>(sql`
    select id, policy_id as "policyId", sequence, name, offset_days as "offsetDays",
           subject_template as "subjectTemplate", body_template as "bodyTemplate", escalate
      from dunning_stages where org_id = ${authz.user.orgId} order by policy_id, sequence
  `));
  const byPolicy = new Map<string, Record<string, unknown>[]>();
  for (const s of stages.rows) {
    const key = s.policyId as string;
    (byPolicy.get(key) ?? byPolicy.set(key, []).get(key)!).push(s);
  }
  return NextResponse.json({
    policies: policies.rows.map((p) => ({ ...p, stages: byPolicy.get(p.id as string) ?? [] })),
  });
}

export async function POST(req: Request) {
  const authz = await requirePermission("documents.manage");
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const stages = validStages(body.stages ?? []);
  if (stages === null) return NextResponse.json({ error: "invalid stages" }, { status: 400 });
  const minBalanceRaw = canonicalDecimal(body.minBalance ?? "0", 4);
  if (minBalanceRaw === null || compareDecimal(minBalanceRaw, "0") < 0) {
    return NextResponse.json({ error: "minBalance must be a non-negative amount" }, { status: 400 });
  }
  const minBalance = normalizeMoney(minBalanceRaw);

  const id = await db.transaction(async (tx) => {
    const created = (await tx.execute<Record<string, unknown>>(sql`
      insert into dunning_policies (org_id, name, applies_to_kind, grace_period_days, min_balance,
                                    reply_to, is_active, created_by, updated_by)
      values (${authz.user.orgId}, ${body.name}, ${(body.appliesToKind as string) ?? "customer_invoice"},
              ${Number(body.gracePeriodDays ?? 0)}, ${minBalance},
              ${(body.replyTo as string | null) ?? null}, ${body.isActive !== false},
              ${authz.user.id}, ${authz.user.id})
      returning *
    `));
    const policyId = created.rows[0]!.id as string;
    const insertedStages: Record<string, unknown>[] = [];
    for (const s of stages) {
      const stageRow = (await tx.execute<Record<string, unknown>>(sql`
        insert into dunning_stages (org_id, policy_id, sequence, name, offset_days, subject_template,
                                    body_template, escalate, created_by, updated_by)
        values (${authz.user.orgId}, ${policyId}, ${s.sequence}, ${s.name}, ${s.offsetDays},
                ${s.subjectTemplate}, ${s.bodyTemplate}, ${s.escalate ?? false}, ${authz.user.id}, ${authz.user.id})
        returning *
      `));
      insertedStages.push(stageRow.rows[0]!);
    }
    // The policy decides how overdue customers are chased; record what was
    // created (ladder included) in the same transaction as the writes.
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${authz.user.orgId}, 'dunning_policies', ${policyId}, 'insert',
         ${JSON.stringify({ after: { ...created.rows[0], stages: insertedStages } })}::jsonb,
         ${authz.user.id})
    `);
    return policyId;
  });
  return NextResponse.json({ id }, { status: 201 });
}

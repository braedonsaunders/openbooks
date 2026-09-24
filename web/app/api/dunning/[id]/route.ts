import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { isDunnableDocumentKind } from "@openbooks/engine/src/receivables/dunning.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { guardPermission } from "../../../../lib/authz";
import { canonicalDecimal, compareDecimal } from "../../../../lib/exact-decimal";
import { isUuid } from "../../../../lib/list-params";
import { isValidEmailAddress } from "@openbooks/emails";

export const runtime = "nodejs";

interface StageInput {
  sequence: number;
  name: string;
  offsetDays: number;
  subjectTemplate: string;
  bodyTemplate: string;
  escalate?: boolean;
}

/** int4 range guard: sequence/offset_days beyond ±2^31 fail the write as an
 * unhandled storage error. Negative offsets stay legal (pre-due rungs). */
function isInt32(n: number): boolean {
  return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
}

type StagesParse =
  | { ok: true; stages: StageInput[] }
  | { ok: false; error: "invalid_stages" | "blank_template" };

function validStages(raw: unknown): StagesParse {
  const invalid = { ok: false, error: "invalid_stages" } as const;
  const blank = { ok: false, error: "blank_template" } as const;
  if (!Array.isArray(raw)) return invalid;
  const stages: StageInput[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) return invalid;
    const o = s as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name.trim()) return invalid;
    if (typeof o.subjectTemplate !== "string" || typeof o.bodyTemplate !== "string") return invalid;
    // A blank template renders an empty letter: refuse it at the boundary
    // with the fix named instead of storing a rung that mails nothing.
    if (!o.subjectTemplate.trim() || !o.bodyTemplate.trim()) return blank;
    if (!isInt32(Number(o.sequence)) || !isInt32(Number(o.offsetDays))) return invalid;
    stages.push({
      sequence: Number(o.sequence),
      name: o.name,
      offsetDays: Number(o.offsetDays),
      subjectTemplate: o.subjectTemplate,
      bodyTemplate: o.bodyTemplate,
      escalate: Boolean(o.escalate),
    });
  }
  if (new Set(stages.map((s) => s.sequence)).size !== stages.length) return invalid;
  return { ok: true, stages };
}

function stagesRefusal(error: "invalid_stages" | "blank_template"): NextResponse {
  return NextResponse.json(
    { error: error === "blank_template" ? "stage subject and body templates must not be blank" : "invalid stages" },
    { status: 400 },
  );
}

/**
 * Grace days are stored into an integer column. Anything that is not a
 * non-negative integer is a client error, never a storage error surfacing
 * as a 500. Same contract as the collection POST — including the int4 range:
 * a pasted 10-digit count is an integer but still not storable.
 */
function parseGracePeriodDays(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return 0;
  if (typeof raw === 'boolean') return null;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0 || days > 2147483647) return null;
  return days;
}

async function owned(orgId: string, id: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from dunning_policies where id = ${id} and org_id = ${orgId}`,
  ));
  return r.rows.length > 0;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await guardPermission("documents.manage");
  if (authz instanceof NextResponse) return authz;
  const { id } = await params;
  // A malformed id names nothing: same answer as a policy in another org.
  if (!isUuid(id) || !(await owned(authz.user.orgId, id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>;
  const parsedStages = "stages" in body ? validStages(body.stages) : undefined;
  if (parsedStages !== undefined && !parsedStages.ok) return stagesRefusal(parsedStages.error);
  const stages = parsedStages !== undefined && parsedStages.ok ? parsedStages.stages : undefined;
  if (
    "appliesToKind" in body &&
    (typeof body.appliesToKind !== "string" || !isDunnableDocumentKind(body.appliesToKind))
  ) {
    return NextResponse.json({ error: "appliesToKind must be a dunnable receivable document kind" }, { status: 422 });
  }
  let minBalance: string | undefined;
  if ("minBalance" in body) {
    const minBalanceRaw = canonicalDecimal(body.minBalance, 4);
    if (minBalanceRaw === null || compareDecimal(minBalanceRaw, "0") < 0) {
      return NextResponse.json({ error: "minBalance must be a non-negative amount" }, { status: 400 });
    }
    // min_balance is numeric(19,4): fifteen whole digits.
    if (minBalanceRaw.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
      return NextResponse.json({ error: "minBalance must be a non-negative amount" }, { status: 400 });
    }
    minBalance = normalizeMoney(minBalanceRaw);
  }
  // PATCH enforces the same field contracts as POST: the non-empty name,
  // a storable grace period, and a real boolean active flag.
  if ("name" in body && (typeof body.name !== "string" || !body.name.trim())) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if ("isActive" in body && typeof body.isActive !== "boolean") {
    return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
  }
  if (
    "replyTo" in body &&
    body.replyTo !== null &&
    (typeof body.replyTo !== "string" || !isValidEmailAddress(body.replyTo))
  ) {
    return NextResponse.json({ error: "replyTo must be a valid email address" }, { status: 400 });
  }
  let gracePeriodDays: number | undefined;
  if ("gracePeriodDays" in body) {
    const parsed = parseGracePeriodDays(body.gracePeriodDays);
    if (parsed === null) {
      return NextResponse.json({ error: "gracePeriodDays must be a non-negative integer" }, { status: 400 });
    }
    gracePeriodDays = parsed;
  }
  // Same activation fence as POST: flipping a stage-less ladder on, or
  // pruning the ladder off a live policy, stores a collections policy the
  // runner skips every tick. Judge the resulting state (supplied half plus
  // the stored half), not just the supplied keys.
  if (("isActive" in body && body.isActive === true) || "stages" in body) {
    const current = (await db.execute<{ isActive: boolean; stageCount: number }>(sql`
      select p.is_active as "isActive",
             (select count(*)::int from dunning_stages s where s.policy_id = p.id and s.org_id = p.org_id) as "stageCount"
        from dunning_policies p where p.id = ${id} and p.org_id = ${authz.user.orgId}
    `)).rows[0]!;
    const resultingActive = "isActive" in body ? (body.isActive as boolean) : current.isActive;
    const resultingStages = stages !== undefined ? stages.length : current.stageCount;
    if (resultingActive && resultingStages === 0) {
      return NextResponse.json({ error: "cannot activate a policy with no stages — add at least one stage or deactivate it first" }, { status: 422 });
    }
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
    if (gracePeriodDays !== undefined) sets.push(sql`grace_period_days = ${gracePeriodDays}`);
    if (minBalance !== undefined) sets.push(sql`min_balance = ${minBalance}`);
    if ("replyTo" in body) sets.push(sql`reply_to = ${(body.replyTo as string | null) ?? null}`);
    if ("isActive" in body) sets.push(sql`is_active = ${body.isActive as boolean}`);
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
      // Replace the ladder as one unit. dunning_log sent rows are terminal
      // and never mutated or deleted (the guard refuses every transition out
      // of sent), and each row keeps its own copy of what was sent, so
      // pruning stages is safe.
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
  const authz = await guardPermission("documents.manage");
  if (authz instanceof NextResponse) return authz;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
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

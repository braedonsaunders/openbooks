import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { isDunnableDocumentKind } from "@openbooks/engine/src/receivables/dunning.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { guardPermission, guardUnrestrictedScope } from "../../../lib/authz";
import { canonicalDecimal, compareDecimal } from "../../../lib/exact-decimal";
import { isValidEmailAddress } from "@openbooks/emails";

export const runtime = "nodejs";

/**
 * Dunning policies — an ordered ladder of reminder stages fired against overdue
 * invoices by engine/src/receivables/dunning.ts. A policy carries its stages inline; saving
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
  if (seqs.size !== stages.length) return invalid;
  // sequence/offset_days are int4: integers beyond ±2^31 fail the insert as
  // an unhandled storage error (500). Negative offsets are legitimate
  // (pre-due courtesy rungs), so the bound is the column range, not >= 0.
  if (stages.some((s) => !isInt32(s.sequence) || !isInt32(s.offsetDays))) return invalid;
  return { ok: true, stages };
}

function stagesRefusal(error: "invalid_stages" | "blank_template"): NextResponse {
  return NextResponse.json(
    { error: error === "blank_template" ? "stage subject and body templates must not be blank" : "invalid stages" },
    { status: 400 },
  );
}

/** int4 range guard shared by the day-count fields. */
function isInt32(n: number): boolean {
  return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
}

/**
 * Grace days are stored into an integer column. Anything that is not a
 * non-negative integer — non-numeric strings, booleans, fractions,
 * negatives — is a client error, never a storage error surfacing as a 500.
 * The int4 range is enforced too: a pasted 10-digit count is an integer but
 * still not storable.
 */
function parseGracePeriodDays(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return 0;
  if (typeof raw === 'boolean') return null;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0 || days > 2147483647) return null;
  return days;
}

export async function GET() {
  const authz = await guardPermission("documents.manage");
  if (authz instanceof NextResponse) return authz;
  // The policy and its stages carry no subsidiary lineage yet apply to every
  // entity's open items, and stage templates can hold entity-specific copy —
  // so the read itself discloses cross-entity material and needs unrestricted
  // scope, like the writes below.
  const scopeDenied = guardUnrestrictedScope(authz);
  if (scopeDenied) return scopeDenied;
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
  const authz = await guardPermission("documents.manage");
  if (authz instanceof NextResponse) return authz;
  // Org-wide collections policy: an A-only caller must never write the
  // ladder that chases B's debtors. Named 403 before any parsing or write.
  const scopeDenied = guardUnrestrictedScope(authz);
  if (scopeDenied) return scopeDenied;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>;
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const parsedStages = validStages(body.stages ?? []);
  if (!parsedStages.ok) return stagesRefusal(parsedStages.error);
  const stages = parsedStages.stages;
  // The runner selects documents by this kind and mails their party; only a
  // dunnable receivable kind may ever be configured (see engine dunning.ts).
  const appliesToKind = body.appliesToKind === undefined ? "customer_invoice" : body.appliesToKind;
  if (typeof appliesToKind !== "string" || !isDunnableDocumentKind(appliesToKind)) {
    return NextResponse.json({ error: "appliesToKind must be a dunnable receivable document kind" }, { status: 422 });
  }
  const minBalanceRaw = canonicalDecimal(body.minBalance ?? "0", 4);
  if (minBalanceRaw === null || compareDecimal(minBalanceRaw, "0") < 0) {
    return NextResponse.json({ error: "minBalance must be a non-negative amount" }, { status: 400 });
  }
  // min_balance is numeric(19,4): fifteen whole digits. The format check
  // admits any magnitude, so a pasted 20-digit balance died in Postgres with
  // a storage error.
  if (minBalanceRaw.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
    return NextResponse.json({ error: "minBalance must be a non-negative amount" }, { status: 400 });
  }
  const minBalance = normalizeMoney(minBalanceRaw);
  const gracePeriodDays = parseGracePeriodDays(body.gracePeriodDays);
  if (gracePeriodDays === null) {
    return NextResponse.json({ error: "gracePeriodDays must be a non-negative integer" }, { status: 400 });
  }
  // An explicitly supplied active flag must be a real boolean: loose
  // coercion would let isActive: "false" silently ACTIVATE a collections
  // ladder the admin tried to switch off. Omission stays active.
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
    return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
  }
  // A malformed reply-to would fail every dunning tick at enqueue time, so
  // refuse it at the boundary with the address named.
  if (
    body.replyTo !== undefined &&
    body.replyTo !== null &&
    (typeof body.replyTo !== "string" || !isValidEmailAddress(body.replyTo))
  ) {
    return NextResponse.json({ error: "replyTo must be a valid email address" }, { status: 400 });
  }
  // A ladder with no rungs can never fire: activating one only parks a
  // collections policy the runner skips every tick. Refuse the activation
  // itself — with the fix named — rather than storing a live no-op. Runs
  // after every other validation so malformed fields still report their
  // own errors first.
  const active = (body.isActive as boolean | undefined) ?? true;
  if (active && stages.length === 0) {
    return NextResponse.json({ error: "cannot activate a policy with no stages — add at least one stage or create it inactive" }, { status: 422 });
  }

  const id = await db.transaction(async (tx) => {
    const created = (await tx.execute<Record<string, unknown>>(sql`
      insert into dunning_policies (org_id, name, applies_to_kind, grace_period_days, min_balance,
                                    reply_to, is_active, created_by, updated_by)
      values (${authz.user.orgId}, ${body.name}, ${appliesToKind},
              ${gracePeriodDays}, ${minBalance},
              ${(body.replyTo as string | null) ?? null}, ${active},
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

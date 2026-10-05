import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { isDunnableDocumentKind } from "@openbooks/engine/src/receivables/dunning.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { guardUnrestrictedScope } from "../../../lib/authz";
import { canonicalDecimal, compareDecimal } from "../../../lib/exact-decimal";
import { moneyRefusal } from "../../../lib/payroll-decimal-refusal";
import { isValidEmailAddress } from "@openbooks/emails";
import { isUuid } from '@/lib/list-params'
import { claimSetupCreate, SetupCreateConflict } from '@/lib/api/idempotency'
import { autopayFieldError, normalizeFinalAction, normalizeRetryOffsets, requireAutopayWrite, retryOffsetsSql } from './autopay-fields'
const stageSchema = z.object({
  sequence: z.number().int(), name: z.string().min(1), offsetDays: z.number().int(),
  subjectTemplate: z.string(), bodyTemplate: z.string(), escalate: z.boolean().optional(),
});
const gracePeriodDaysSchema = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/), z.null()]);
const POSTBodySchema1 = z.object({
  // The handler names the eligible receivable kind in its 422 refusal.
  appliesToKind: z.union([z.string(), z.number(), z.null()]).optional(),
  gracePeriodDays: gracePeriodDaysSchema.optional(),
  isActive: z.boolean().optional(), minBalance: z.string().nullable().optional(),
  name: z.string().trim().min(1), replyTo: z.string().email().nullable().optional(),
  stages: z.array(stageSchema).optional(),
  // Autopay retry schedule (setup rows of {days}) and final action: validated
  // by the autopay engine, which is also what the scan executes.
  retryOffsetsDays: z.array(z.unknown()).optional(),
  finalAction: z.string().nullable().optional(),
});


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
    if (o.escalate !== undefined && typeof o.escalate !== "boolean") return invalid;
    // A blank template renders an empty letter: refuse it at the boundary
    // with the fix named instead of storing a rung that mails nothing.
    if (!o.subjectTemplate.trim() || !o.bodyTemplate.trim()) return blank;
    stages.push({
      sequence: Number(o.sequence),
      name: o.name,
      offsetDays: Number(o.offsetDays),
      subjectTemplate: o.subjectTemplate,
      bodyTemplate: o.bodyTemplate,
      escalate: o.escalate ?? false,
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

export const GET = defineRoute({
  permission: 'documents.manage',
  feature: { none: "This always-on route is governed by documents.manage; the existing route has no separate feature gate." },
  handler: async ({ authz: routeAuthz }) => {
    const authz = routeAuthz;
    const scopeDenied = guardUnrestrictedScope(authz);
    if (scopeDenied) return scopeDenied;
    const policies = (await db.execute<Record<string, unknown>>(sql`
        select id, name, applies_to_kind as "appliesToKind", grace_period_days as "gracePeriodDays",
               min_balance as "minBalance", reply_to as "replyTo", is_active as "isActive",
               autopay_retry_offsets_days as "retryOffsetsDays",
               autopay_final_action as "finalAction",
               to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
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
    // The setup form edits retry rows of {days}; the policy stores an
    // integer list, so the read maps one shape to the other.
    const toRetryRows = (offsets: unknown) =>
      (Array.isArray(offsets) ? offsets : []).map((days) => ({ days }));
    return NextResponse.json({
        policies: policies.rows.map((p) => ({
          ...p,
          retryOffsetsDays: toRetryRows(p.retryOffsetsDays),
          stages: byPolicy.get(p.id as string) ?? [],
        })),
      });
  },
});

export const POST = defineRoute({
  permission: 'documents.manage',
  feature: { none: "This always-on route is governed by documents.manage; the existing route has no separate feature gate." },
  body: POSTBodySchema1,
  opaque: {
    retryOffsetsDays: "retry offsets are normalized by normalizeRetryOffsets, refusing non-integer days with a 422",
  },
  handler: async ({ request, authz: routeAuthz, body: routeBody }) => {
    const authz = routeAuthz;
    const scopeDenied = guardUnrestrictedScope(authz);
    if (scopeDenied) return scopeDenied;

    const body = (routeBody) as Record<string, unknown>;
    const requestId = request.headers.get('Idempotency-Key')?.trim() ?? null
    if (requestId && !isUuid(requestId)) return NextResponse.json({ error: 'Idempotency-Key must be a UUID' }, { status: 400 })
    if (typeof body.name !== "string" || !body.name.trim()) {
        return NextResponse.json({ error: "name is required" }, { status: 400 });
      }
    const parsedStages = validStages(body.stages ?? []);
    if (!parsedStages.ok) return stagesRefusal(parsedStages.error);
    const stages = parsedStages.stages;
    const appliesToKind = body.appliesToKind === undefined ? "customer_invoice" : body.appliesToKind;
    if (typeof appliesToKind !== "string" || !isDunnableDocumentKind(appliesToKind)) {
        return NextResponse.json({ error: "appliesToKind must be a dunnable receivable document kind" }, { status: 422 });
      }
    const minBalanceRaw = canonicalDecimal(body.minBalance ?? "0", 4);
    if (minBalanceRaw === null) {
        return NextResponse.json({ error: moneyRefusal("minBalance", body.minBalance ?? "0") }, { status: 400 });
      }
    if (compareDecimal(minBalanceRaw, "0") < 0) {
        return NextResponse.json({ error: "minBalance must be a non-negative amount" }, { status: 400 });
      }
    if (minBalanceRaw.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
        return NextResponse.json({ error: "minBalance must fit the ledger (at most 15 whole digits)" }, { status: 400 });
      }
    const minBalance = normalizeMoney(minBalanceRaw);
    const gracePeriodDays = parseGracePeriodDays(body.gracePeriodDays);
    if (gracePeriodDays === null) {
        return NextResponse.json({ error: "gracePeriodDays must be a non-negative integer" }, { status: 400 });
      }
    if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
        return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
      }
    if (
        body.replyTo !== undefined &&
        body.replyTo !== null &&
        (typeof body.replyTo !== "string" || !isValidEmailAddress(body.replyTo))
      ) {
        return NextResponse.json({ error: "replyTo must be a valid email address" }, { status: 400 });
      }
    const active = (body.isActive as boolean | undefined) ?? true;
    if (active && stages.length === 0) {
        return NextResponse.json({ error: "cannot activate a policy with no stages — add at least one stage or create it inactive" }, { status: 422 });
      }
    // The autopay schedule moves money: it needs its own duty even though it
    // rides on this policy. Absent fields keep the migration defaults (no
    // retries, no final action), so plain reminder policies are unaffected.
    let retryOffsets: number[] | undefined;
    let finalAction: 'none' | 'suspend' | 'cancel' | undefined;
    if (body.retryOffsetsDays !== undefined || body.finalAction !== undefined) {
      const denied = await requireAutopayWrite(authz);
      if (denied) return denied;
      try {
        if (body.retryOffsetsDays !== undefined) retryOffsets = normalizeRetryOffsets(body.retryOffsetsDays);
        if (body.finalAction !== undefined && body.finalAction !== null) finalAction = normalizeFinalAction(body.finalAction);
      } catch (e) {
        const refusal = autopayFieldError(e);
        if (refusal) return refusal;
        throw e;
      }
    }
    const id = await db.transaction(async (tx) => {
        const match = { name: body.name, appliesToKind, gracePeriodDays, minBalance,
          replyTo: body.replyTo ?? null, isActive: active, stages }
        if (requestId) {
          // The request identity serializes creation of the entire policy.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'dunning-policy-create:' + requestId}, 0))`)
          const claim = await claimSetupCreate(tx, { orgId: authz.user.orgId, table: 'dunning_policies', key: requestId, match })
          if (claim.kind === 'replay') return claim.id
        }
        const created = (await tx.execute<Record<string, unknown>>(sql`
          insert into dunning_policies (id, org_id, name, applies_to_kind, grace_period_days, min_balance,
                                        reply_to, is_active, autopay_retry_offsets_days, autopay_final_action,
                                        created_by, updated_by)
          values (coalesce(${requestId}::uuid, gen_random_uuid()), ${authz.user.orgId}, ${body.name}, ${appliesToKind},
                  ${gracePeriodDays}, ${minBalance},
                  ${(body.replyTo as string | null) ?? null}, ${active},
                  ${retryOffsets !== undefined ? retryOffsetsSql(retryOffsets) : sql`'{}'::integer[]`},
                  ${finalAction ?? 'none'},
                  ${authz.user.id}, ${authz.user.id})
          -- A request identity already claimed cannot create another policy.
          on conflict (id) do nothing returning *
        `));
        if (!created.rows[0]) throw new SetupCreateConflict('foreign-key')
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
          if (!stageRow.rows[0]) throw new Error('The reminder stage was not created; policy creation was rolled back.')
          insertedStages.push(stageRow.rows[0]);
        }
        // The policy decides how overdue customers are chased; record what was
        // created (ladder included) in the same transaction as the writes.
        await tx.execute(sql`
          insert into audit_log
            (org_id, table_name, row_id, action, changes, actor_id, request_id)
          values
            (${authz.user.orgId}, 'dunning_policies', ${policyId}, 'insert',
             ${JSON.stringify({ after: { ...created.rows[0], stages: insertedStages }, match })}::jsonb,
             ${authz.user.id}, ${requestId})
        `);
        return policyId;
      });
    return NextResponse.json({ id }, { status: 201 });
  },
});

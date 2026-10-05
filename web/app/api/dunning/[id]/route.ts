import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { isDunnableDocumentKind } from "@openbooks/engine/src/receivables/dunning.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { guardUnrestrictedScope } from "../../../../lib/authz";
import { canonicalDecimal, compareDecimal } from "../../../../lib/exact-decimal";
import { isUuid } from "../../../../lib/list-params";
import { isValidEmailAddress } from "@openbooks/emails";
import { dunningStageIdentities } from '@/lib/dunning-stage-identity'
import { notFound } from "@/lib/api/responses";
import { autopayFieldError, normalizeExpiryNoticeDays, normalizeFinalAction, normalizeRetryOffsets, requireAutopayWrite, retryOffsetsSql } from '../autopay-fields'
const stageSchema = z.object({
  id: z.string().uuid().optional(),
  sequence: z.number().int(), name: z.string().min(1), offsetDays: z.number().int(),
  subjectTemplate: z.string(), bodyTemplate: z.string(), escalate: z.boolean().optional(),
});
const gracePeriodDaysSchema = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/), z.null()]);
const PATCHBodySchema1 = z.object({
  expectedUpdatedAt: z.string().datetime().optional(),
  appliesToKind: z.union([z.string(), z.number(), z.null()]).optional(),
  gracePeriodDays: gracePeriodDaysSchema.optional(), isActive: z.boolean().optional(),
  minBalance: z.string().nullable().optional(), name: z.string().trim().min(1).optional(),
  replyTo: z.string().email().nullable().optional(), stages: z.array(stageSchema).optional(),
  retryOffsetsDays: z.array(z.unknown()).optional(),
  insufficientFundsOffsetsDays: z.array(z.unknown()).optional(),
  expiryNoticeDays: z.union([z.number().int(), z.string().regex(/^\d+$/), z.null()]).optional(),
  finalAction: z.string().nullable().optional(),
}).refine((body) => body.name !== undefined || body.appliesToKind !== undefined ||
  body.gracePeriodDays !== undefined || body.isActive !== undefined || body.minBalance !== undefined ||
  body.replyTo !== undefined || body.stages !== undefined ||
  body.retryOffsetsDays !== undefined || body.insufficientFundsOffsetsDays !== undefined ||
  body.expiryNoticeDays !== undefined || body.finalAction !== undefined, { message: "At least one field must be provided." });



export const runtime = "nodejs";

class PolicyEditConflict extends Error {
  readonly status = 409
  constructor(message = 'This policy changed or was removed while you were editing. Close the editor, refresh Policies, and reopen the record before saving.') { super(message) }
}

class PolicyStagesRefusal extends Error {
  readonly status = 422
  constructor() { super('cannot activate a policy with no stages — add at least one stage or deactivate it first') }
}

interface StageInput {
  id?: string;
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
    if (o.id !== undefined && (typeof o.id !== 'string' || !isUuid(o.id))) return invalid;
    if (typeof o.name !== "string" || !o.name.trim()) return invalid;
    if (typeof o.subjectTemplate !== "string" || typeof o.bodyTemplate !== "string") return invalid;
    if (o.escalate !== undefined && typeof o.escalate !== "boolean") return invalid;
    // A blank template renders an empty letter: refuse it at the boundary
    // with the fix named instead of storing a rung that mails nothing.
    if (!o.subjectTemplate.trim() || !o.bodyTemplate.trim()) return blank;
    if (!isInt32(Number(o.sequence)) || !isInt32(Number(o.offsetDays))) return invalid;
    stages.push({
      ...(typeof o.id === 'string' ? { id: o.id } : {}),
      sequence: Number(o.sequence),
      name: o.name,
      offsetDays: Number(o.offsetDays),
      subjectTemplate: o.subjectTemplate,
      bodyTemplate: o.bodyTemplate,
      escalate: o.escalate ?? false,
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

export const PATCH = defineRoute({
  permission: 'documents.manage',
  feature: { none: "This always-on route is governed by documents.manage; the existing route has no separate feature gate." },
  body: PATCHBodySchema1,
  opaque: {
    retryOffsetsDays: "retry offsets are normalized by normalizeRetryOffsets, refusing non-integer days with a 422",
    insufficientFundsOffsetsDays: "insufficient-funds offsets are normalized by normalizeRetryOffsets, refusing non-integer days with a 422",
  },
  handler: async ({ authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = routeAuthz;
    const scopeDenied = guardUnrestrictedScope(authz);
    if (scopeDenied) return scopeDenied;
    const { id } = await params;
    if (!isUuid(id) || !(await owned(authz.user.orgId, id))) {
        return notFound("record");
      }

    const body = (routeBody) as Record<string, unknown>;
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
    // The autopay schedule moves money: it needs its own duty even though it
    // rides on this policy.
    let retryOffsets: number[] | undefined;
    let insufficientFundsOffsets: number[] | undefined;
    let expiryNoticeDays: number | undefined;
    let finalAction: 'none' | 'suspend' | 'cancel' | undefined;
    if ("retryOffsetsDays" in body || "insufficientFundsOffsetsDays" in body ||
        "expiryNoticeDays" in body || "finalAction" in body) {
      const denied = await requireAutopayWrite(authz);
      if (denied) return denied;
      try {
        if ("retryOffsetsDays" in body) retryOffsets = normalizeRetryOffsets(body.retryOffsetsDays);
        if ("insufficientFundsOffsetsDays" in body) insufficientFundsOffsets = normalizeRetryOffsets(body.insufficientFundsOffsetsDays);
        if ("expiryNoticeDays" in body && body.expiryNoticeDays !== null) {
          expiryNoticeDays = normalizeExpiryNoticeDays(typeof body.expiryNoticeDays === 'string' ? Number(body.expiryNoticeDays) : body.expiryNoticeDays);
        }
        if ("finalAction" in body && body.finalAction !== null) finalAction = normalizeFinalAction(body.finalAction);
      } catch (e) {
        const refusal = autopayFieldError(e);
        if (refusal) return refusal;
        throw e;
      }
    }
    await db.transaction(async (tx) => {
        // Snapshot the current policy and its ladder before anything changes.
        const beforePolicy = (await tx.execute<Record<string, unknown>>(sql`
          select *, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as policy_revision
            from dunning_policies where id = ${id} and org_id = ${authz.user.orgId} for update
        `));
        const before = beforePolicy.rows[0]
        if (!before) throw new PolicyEditConflict()
        if (body.expectedUpdatedAt !== undefined &&
          before.policy_revision !== body.expectedUpdatedAt) throw new PolicyEditConflict()
        const beforeStages = (await tx.execute<Record<string, unknown>>(sql`
          select * from dunning_stages where policy_id = ${id} and org_id = ${authz.user.orgId} order by sequence
        `));
        if ((body.isActive ?? before.is_active) === true && (stages ?? beforeStages.rows).length === 0) {
          throw new PolicyStagesRefusal()
        }
        const sets = [];
        if ("name" in body) sets.push(sql`name = ${body.name as string}`);
        if ("appliesToKind" in body) sets.push(sql`applies_to_kind = ${body.appliesToKind as string}`);
        if (gracePeriodDays !== undefined) sets.push(sql`grace_period_days = ${gracePeriodDays}`);
        if (minBalance !== undefined) sets.push(sql`min_balance = ${minBalance}`);
        if ("replyTo" in body) sets.push(sql`reply_to = ${(body.replyTo as string | null) ?? null}`);
        if ("isActive" in body) sets.push(sql`is_active = ${body.isActive as boolean}`);
        if (retryOffsets !== undefined) sets.push(sql`autopay_retry_offsets_days = ${retryOffsetsSql(retryOffsets)}`);
        if (insufficientFundsOffsets !== undefined) sets.push(sql`autopay_insufficient_funds_offsets_days = ${retryOffsetsSql(insufficientFundsOffsets)}`);
        if (expiryNoticeDays !== undefined) sets.push(sql`autopay_expiry_notice_days = ${expiryNoticeDays}`);
        if (finalAction !== undefined) sets.push(sql`autopay_final_action = ${finalAction}`);
        let afterPolicy: Record<string, unknown> | undefined;
        if (sets.length || stages !== undefined) {
          sets.push(sql`updated_at = now()`, sql`updated_by = ${authz.user.id}`)
          const updated = (await tx.execute<Record<string, unknown>>(sql`
            update dunning_policies set ${sql.join(sets, sql`, `)}
             where id = ${id} and org_id = ${authz.user.orgId}
            returning *
          `));
          afterPolicy = updated.rows[0];
          if (!afterPolicy) throw new PolicyEditConflict()
        }
        let afterStages: Record<string, unknown>[] | undefined;
        if (stages) {
          const identities = dunningStageIdentities(beforeStages.rows.map((stage) => ({ id: String(stage.id), sequence: Number(stage.sequence) })), stages)
          if (!identities.ok) throw new PolicyEditConflict(identities.error)
          // Replace atomically to permit sequence swaps under the unique
          // index. Retain stage ids and creation evidence: delivery claims
          // remain attached to the same reminder after an ordinary edit.
          await tx.execute(sql`delete from dunning_stages where policy_id = ${id} and org_id = ${authz.user.orgId}`);
          afterStages = [];
          for (const [index, s] of stages.entries()) {
            const stageId = identities.ids[index] ?? null
            const original = beforeStages.rows.find((row) => row.id === stageId)
            const stageRow = (await tx.execute<Record<string, unknown>>(sql`
              insert into dunning_stages (id, org_id, policy_id, sequence, name, offset_days, subject_template,
                                          body_template, escalate, created_at, created_by, updated_by)
              values (coalesce(${stageId}::uuid, gen_random_uuid()), ${authz.user.orgId}, ${id}, ${s.sequence}, ${s.name}, ${s.offsetDays},
                      ${s.subjectTemplate}, ${s.bodyTemplate}, ${s.escalate ?? false}, coalesce(${original?.created_at ?? null}::timestamptz, now()),
                      ${original?.created_by ?? authz.user.id}, ${authz.user.id})
              returning *
            `));
            if (!stageRow.rows[0]) throw new PolicyEditConflict()
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
  },
});

export const DELETE = defineRoute({
  permission: 'documents.manage',
  feature: { none: "This always-on route is governed by documents.manage; the existing route has no separate feature gate." },
  handler: async ({ authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = routeAuthz;
    const scopeDenied = guardUnrestrictedScope(authz);
    if (scopeDenied) return scopeDenied;
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
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
  },
});

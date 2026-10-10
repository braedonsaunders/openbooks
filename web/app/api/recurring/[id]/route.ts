import { apiErrorResponse } from '@/lib/api/error-response'
import { isoDate, uuidId, parseJsonBody } from "@/lib/api/json";
import { z } from "zod";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/src/platform/db.ts";
import {
  assertTemplateTokensKnown,
  CATCH_UP_CHOICE_THRESHOLD,
  pendingOccurrences,
  RecurringError,
  remainingOccurrences,
  runScheduleCatchUp,
  runScheduleNow,
  recurringTemplateScopeFilter,
  toDateArrayLiteral,
  type Cadence,
  type CatchUpMode,
} from "@openbooks/engine/src/billing/recurring.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { can, type Authz } from "../../../../lib/authz";
import { defineRoute } from "../../../../lib/api/route";
import { isDocKindEnabled } from "../../../../lib/documents.ts";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

const patchSchema = z.object({
  isActive: z.boolean().optional(), autoPost: z.boolean().optional(),
  nextRunOn: isoDate().optional(), endsOn: isoDate().nullable().optional(),
  maxOccurrences: z.number().int().min(1).nullable().optional(),
  skippedRunOns: z.array(isoDate()).optional(),
  name: z.string().trim().max(255).nullable().optional(),
  catchUp: z.object({
    mode: z.enum(["post_all", "drafts", "skip", "selected"]),
    dates: z.array(isoDate()).optional(),
    post: z.boolean().optional(),
  }).optional(),
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
export const PATCH = defineRoute({
  permission: "documents.manage",
  feature: { none: "Recurring schedules are governed by document permissions and template kind availability." },
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz, params }) => {
  const { id } = params;
  if (!uuidId.safeParse(id).success) return notFound("record");
  const parsedBody = await parseJsonBody(req, patchSchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  if (body.autoPost && !can(authz, "gl.post")) return NextResponse.json({ error: "missing permission: gl.post" }, { status: 403 });
  const today = await businessToday(authz.user.orgId);
  // Resuming into a backlog is a choice, never a side effect: refuse with
  // the exact missed dates unless the resume carries its catch-up mode.
  // Plain edits never trip this gate; the catch-up run recomputes from
  // stored state, so a concurrent tick between this read and the run cannot
  // bill anything the choice did not cover.
  if (body.isActive === true && !body.catchUp) {
    const current = (await db.execute<{
      isActive: boolean; nextRunOn: string; endsOn: string | null;
      cadence: string; cron: string | null; anchorDay: number | null;
      runCount: number; maxOccurrences: number | null; skippedRunOns: string[] | null;
    }>(sql`
      select rs.is_active as "isActive", rs.next_run_on::text as "nextRunOn",
             rs.ends_on::text as "endsOn", rs.cadence, rs.cron, rs.anchor_day as "anchorDay",
             rs.run_count as "runCount", rs.max_occurrences as "maxOccurrences",
             rs.skipped_run_ons::text[] as "skippedRunOns"
        from recurring_schedules rs
        join documents d on d.id = rs.template_document_id and d.org_id = rs.org_id
       where rs.id = ${id} and rs.org_id = ${authz.user.orgId} and not rs.is_active
         ${recurringTemplateScopeFilter(authz.user.orgId, sql`d.id`, sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
    `)).rows[0];
    if (current) {
      const pending = pendingOccurrences(
        {
          cadence: current.cadence as Cadence, cron: current.cron, nextRunOn: current.nextRunOn,
          endsOn: current.endsOn, anchorDay: current.anchorDay,
          skippedRunOns: current.skippedRunOns ?? [],
          remaining: remainingOccurrences(
            current.maxOccurrences == null ? null : Number(current.maxOccurrences), Number(current.runCount),
          ),
        },
        today,
      );
      if (pending.occurrences.length >= CATCH_UP_CHOICE_THRESHOLD) {
        return NextResponse.json({
          error: `${pending.occurrences.length} periods are already due — choose how to catch up instead of bulk-generating them`,
          code: "catch_up_choice_required",
          occurrences: pending.occurrences,
          truncated: pending.truncated,
        }, { status: 409 });
      }
    }
  }
  const sets: SQL[] = [];
  if ("isActive" in body) sets.push(sql`is_active = ${body.isActive}`);
  if ("autoPost" in body) sets.push(sql`auto_post = ${body.autoPost}`);
  if ("nextRunOn" in body) sets.push(sql`next_run_on = ${body.nextRunOn}`);
  if ("endsOn" in body) sets.push(sql`ends_on = ${body.endsOn ?? null}`);
  if ("maxOccurrences" in body) sets.push(sql`max_occurrences = ${body.maxOccurrences ?? null}`);
  if ("skippedRunOns" in body) {
    sets.push(sql`skipped_run_ons = ${toDateArrayLiteral([...new Set(body.skippedRunOns ?? [])].sort())}::date[]`);
  }
  if ("name" in body) sets.push(sql`name = ${body.name ?? null}`);
  if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  const outcome = await db.transaction(async (tx) => {
    const before = await ownedEnabled(tx, authz, id);
    if (!before) return notFound("record");
    if ((body.autoPost ?? before.auto_post) && !can(authz, "gl.post")
        && (body.isActive === true || body.nextRunOn !== undefined || body.endsOn !== undefined)) {
      return NextResponse.json({ error: "missing permission: gl.post" }, { status: 403 });
    }
    const nextRunOn = body.nextRunOn ?? before.next_run_on;
    const endsOn = body.endsOn === undefined ? before.ends_on : body.endsOn;
    if (endsOn && endsOn < nextRunOn && (body.isActive ?? before.is_active)) {
      return NextResponse.json({ error: "endsOn must not precede nextRunOn" }, { status: 400 });
    }
    // A pause or resume never blocks on template text; any other save
    // re-validates it, so a token added since creation is caught here.
    const touchesConfig = ["autoPost", "nextRunOn", "endsOn", "maxOccurrences", "skippedRunOns", "name"].some((key) => key in body);
    if (touchesConfig) {
      await assertTemplateTokensKnown(tx, authz.user.orgId, String(before.template_document_id));
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
  if (outcome) return outcome;
  if (body.catchUp) {
    try {
      const catchUpOutcome = await runScheduleCatchUp(authz.user.orgId, id, {
        mode: body.catchUp.mode as CatchUpMode,
        selectedDates: body.catchUp.dates,
        postSelected: body.catchUp.post,
        asOf: today,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      return NextResponse.json({ ok: true, catchUp: catchUpOutcome });
    } catch (e) {
      return apiErrorResponse(e);
    }
  }
  return NextResponse.json({ ok: true });
  },
});

export const DELETE = defineRoute({
  permission: "documents.manage",
  feature: { none: "Recurring schedules are governed by document permissions and template kind availability." },
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params }) => {
  const { id } = params;
  if (!uuidId.safeParse(id).success) return notFound("record");
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
  if (outcome === "not_found") return notFound("record");
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
  },
});

/**
 * Run now — force-generate a document from the template immediately — or run
 * an explicit catch-up choice ({ catchUp: { mode } }) against the pending
 * backlog. An absent body keeps the historical run-now behavior.
 */
export const POST = defineRoute({
  permission: "documents.manage",
  feature: { none: "Recurring schedules are governed by document permissions and template kind availability." },
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz, params }) => {
  const { id } = params;
  if (!uuidId.safeParse(id).success) return notFound("record");
  const parsedBody = await parseJsonBody(req, z.object({ catchUp: z.object({
    mode: z.enum(["post_all", "drafts", "skip", "selected"]),
    dates: z.array(isoDate()).optional(),
    post: z.boolean().optional(),
  }).optional() }).default({}));
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const existing = await db.transaction(tx => ownedEnabled(tx, authz, id));
    if (!existing) return notFound("record");
    if (parsedBody.data.catchUp) {
      const outcome = await runScheduleCatchUp(authz.user.orgId, id, {
        mode: parsedBody.data.catchUp.mode as CatchUpMode,
        selectedDates: parsedBody.data.catchUp.dates,
        postSelected: parsedBody.data.catchUp.post,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      return NextResponse.json({ ok: true, catchUp: outcome });
    }
    const gen = await runScheduleNow(authz.user.orgId, id, authz.user.id, undefined, {
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds, canPost: can(authz, "gl.post"),
    });
    return NextResponse.json(gen);
  } catch (e) {
    if (e instanceof RecurringError) return apiErrorResponse(e);
    return apiErrorResponse(e);
  }
  },
});

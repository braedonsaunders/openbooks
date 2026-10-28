import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, type SqlExecutor } from "@openbooks/engine/platform/db";
import {
  assertTemplateTokensKnown,
  CATCH_UP_CHOICE_THRESHOLD,
  pendingOccurrences,
  recurringTemplateScopeFilter,
  remainingOccurrences,
  runScheduleCatchUp,
  toDateArrayLiteral,
  type Cadence,
  type CatchUpMode,
} from "@openbooks/engine/billing/recurring";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { isoDate } from "../api/json";
import { can, type Authz } from "../authz";
import { isDocKindEnabled } from "../documents";

const catchUpSchema = z.object({
  mode: z
    .enum(["post_all", "drafts", "skip", "selected"])
    .describe("How to resolve pending occurrence dates."),
  dates: z
    .array(isoDate())
    .max(1000)
    .optional()
    .describe("Occurrence dates when mode is selected."),
  post: z.boolean().optional().describe("Whether selected catch-up documents should post."),
});

export const recurringSchedulePatchSchema = z.object({
  isActive: z
    .boolean()
    .optional()
    .describe("Whether the schedule should generate future occurrences."),
  autoPost: z
    .boolean()
    .optional()
    .describe("Whether generated documents should be posted automatically."),
  nextRunOn: isoDate()
    .optional()
    .describe("Next occurrence date; changing it may require a catch-up choice."),
  endsOn: isoDate().nullable().optional().describe("Optional final occurrence date."),
  maxOccurrences: z
    .number()
    .int()
    .min(1)
    .nullable()
    .optional()
    .describe("Maximum number of generated occurrences, or null for no limit."),
  skippedRunOns: z
    .array(isoDate())
    .max(1000)
    .optional()
    .describe("Occurrence dates that the schedule should skip."),
  name: z.string().trim().max(255).nullable().optional().describe("Optional schedule name."),
  catchUp: catchUpSchema
    .optional()
    .describe("Explicit choice for backlog occurrences when resuming a schedule."),
});

export type RecurringSchedulePatch = z.infer<typeof recurringSchedulePatchSchema>;

export class RecurringScheduleActionRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RecurringScheduleActionRefusal";
  }
}
export async function ownedRecurringSchedule(exec: SqlExecutor, authz: Authz, id: string) {
  const owned = (
    await exec.execute<{ templateId: string }>(
      sql`select template_document_id as "templateId" from recurring_schedules
           where id = ${id} and org_id = ${authz.user.orgId} for update`,
      "objects",
    )
  )[0];
  if (!owned) return null;
  await exec.execute(
    sql`select id from documents where id = ${owned.templateId} and org_id = ${authz.user.orgId} for share`,
  );
  const row = (
    await exec.execute<
      Record<string, unknown> & {
        kind: string;
        auto_post: boolean;
        next_run_on: string;
        ends_on: string | null;
        template_document_id: string;
        is_active: boolean;
      }
    >(
      sql`select rs.*, d.kind from recurring_schedules rs
            join documents d on d.id = rs.template_document_id and d.org_id = rs.org_id
           where rs.id = ${id} and rs.org_id = ${authz.user.orgId}
             ${recurringTemplateScopeFilter(authz.user.orgId, sql`d.id`, sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
           for update of rs for share of d`,
      "objects",
    )
  )[0];
  return row && (await isDocKindEnabled(authz.user.orgId, row.kind)) ? row : null;
}

/** Pause one schedule using the same lock, scope, and audit path as its route. */
export async function pauseRecurringSchedule(authz: Authz, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const before = await ownedRecurringSchedule(tx, authz, id);
    if (!before) return false;
    const updated = await tx.execute<Record<string, unknown>>(
      sql`update recurring_schedules set is_active = false, updated_at = now(), updated_by = ${authz.user.id}
           where id = ${id} and org_id = ${authz.user.orgId} returning *`,
      "objects",
    );
    if (updated.length !== 1)
      throw new Error("recurring schedule changed while it was being paused");
    await tx.execute(sql`insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id)
      values (${authz.user.orgId}, 'recurring_schedules', ${id}, 'update',
        ${JSON.stringify({ before, after: updated[0] })}::jsonb, ${authz.user.id})`);
    return true;
  });
}

/** Update a schedule through the same locking, validation, and audit path as its route. */
export async function updateRecurringSchedule(
  authz: Authz,
  id: string,
  body: RecurringSchedulePatch,
): Promise<{ catchUp?: Awaited<ReturnType<typeof runScheduleCatchUp>> } | null> {
  if (body.autoPost && !can(authz, "gl.post")) {
    throw new RecurringScheduleActionRefusal("missing permission: gl.post", 403);
  }
  if (body.isActive === false && Object.keys(body).length === 1) {
    return (await pauseRecurringSchedule(authz, id)) ? {} : null;
  }

  const today = await businessToday(authz.user.orgId);
  if (body.isActive === true && !body.catchUp) {
    const current = (
      await db.execute<{
        isActive: boolean;
        nextRunOn: string;
        endsOn: string | null;
        cadence: string;
        cron: string | null;
        anchorDay: number | null;
        runCount: number;
        maxOccurrences: number | null;
        skippedRunOns: string[] | null;
      }>(
        sql`
          select rs.is_active as "isActive", rs.next_run_on::text as "nextRunOn",
                 rs.ends_on::text as "endsOn", rs.cadence, rs.cron,
                 rs.anchor_day as "anchorDay", rs.run_count as "runCount",
                 rs.max_occurrences as "maxOccurrences",
                 rs.skipped_run_ons::text[] as "skippedRunOns"
            from recurring_schedules rs
            join documents d on d.id = rs.template_document_id and d.org_id = rs.org_id
           where rs.id = ${id} and rs.org_id = ${authz.user.orgId} and not rs.is_active
             ${recurringTemplateScopeFilter(authz.user.orgId, sql`d.id`, sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
        `,
        "objects",
      )
    )[0];
    if (current) {
      const pending = pendingOccurrences(
        {
          cadence: current.cadence as Cadence,
          cron: current.cron,
          nextRunOn: current.nextRunOn,
          endsOn: current.endsOn,
          anchorDay: current.anchorDay,
          skippedRunOns: current.skippedRunOns ?? [],
          remaining: remainingOccurrences(
            current.maxOccurrences == null ? null : Number(current.maxOccurrences),
            Number(current.runCount),
          ),
        },
        today,
      );
      if (pending.occurrences.length >= CATCH_UP_CHOICE_THRESHOLD) {
        throw new RecurringScheduleActionRefusal(
          `${pending.occurrences.length} periods are already due — choose how to catch up instead of bulk-generating them`,
          409,
          "catch_up_choice_required",
          { occurrences: pending.occurrences, truncated: pending.truncated },
        );
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
    sets.push(
      sql`skipped_run_ons = ${toDateArrayLiteral([...new Set(body.skippedRunOns ?? [])].sort())}::date[]`,
    );
  }
  if ("name" in body) sets.push(sql`name = ${body.name ?? null}`);
  if (!sets.length) throw new RecurringScheduleActionRefusal("nothing to update", 400);

  const outcome = await db.transaction(async (tx) => {
    const before = await ownedRecurringSchedule(tx, authz, id);
    if (!before) return "not_found" as const;
    if (
      (body.autoPost ?? before.auto_post) &&
      !can(authz, "gl.post") &&
      (body.isActive === true || body.nextRunOn !== undefined || body.endsOn !== undefined)
    ) {
      throw new RecurringScheduleActionRefusal("missing permission: gl.post", 403);
    }
    const nextRunOn = body.nextRunOn ?? before.next_run_on;
    const endsOn = body.endsOn === undefined ? before.ends_on : body.endsOn;
    if (endsOn && endsOn < nextRunOn && (body.isActive ?? before.is_active)) {
      throw new RecurringScheduleActionRefusal("endsOn must not precede nextRunOn", 400);
    }
    const touchesConfig = [
      "autoPost",
      "nextRunOn",
      "endsOn",
      "maxOccurrences",
      "skippedRunOns",
      "name",
    ].some((key) => key in body);
    if (touchesConfig) {
      await assertTemplateTokensKnown(tx, authz.user.orgId, String(before.template_document_id));
    }
    const updated = await tx.execute<Record<string, unknown>>(
      sql`
        update recurring_schedules
           set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${authz.user.id}
         where id = ${id} and org_id = ${authz.user.orgId}
        returning *
      `,
      "objects",
    );
    if (updated.length !== 1) throw new Error("Recurring schedule update returned no row.");
    const audit = await tx.execute<{ row_id: string }>(
      sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${authz.user.orgId}, 'recurring_schedules', ${id}, 'update',
         ${JSON.stringify({ before, after: updated[0] })}::jsonb, ${authz.user.id})
      returning row_id
    `,
      "objects",
    );
    if (audit.length !== 1) throw new Error("Recurring schedule audit record was not saved.");
    return "updated" as const;
  });
  if (outcome === "not_found") return null;
  if (!body.catchUp) return {};
  return {
    catchUp: await runScheduleCatchUp(authz.user.orgId, id, {
      mode: body.catchUp.mode as CatchUpMode,
      selectedDates: body.catchUp.dates,
      postSelected: body.catchUp.post,
      asOf: today,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    }),
  };
}

/** Delete a schedule only while no generated documents depend on its lineage. */
export async function deleteRecurringSchedule(
  authz: Authz,
  id: string,
): Promise<"not_found" | "generated_documents_exist" | "deleted"> {
  return db.transaction(async (tx) => {
    const existing = await ownedRecurringSchedule(tx, authz, id);
    if (!existing) return "not_found";
    const lineage = await tx.execute<{ linked: boolean }>(
      sql`
      select true as linked from recurring_occurrence_documents
       where schedule_id = ${id} and org_id = ${authz.user.orgId}
       limit 1
    `,
      "objects",
    );
    if (lineage[0]) return "generated_documents_exist";
    const deleted = await tx.execute<{ id: string }>(
      sql`
      delete from recurring_schedules where id = ${id} and org_id = ${authz.user.orgId}
      returning id
    `,
      "objects",
    );
    if (deleted.length !== 1) throw new Error("Recurring schedule delete returned no row.");
    const audit = await tx.execute<{ row_id: string }>(
      sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${authz.user.orgId}, 'recurring_schedules', ${id}, 'delete',
         ${JSON.stringify({ before: existing, after: null })}::jsonb, ${authz.user.id})
      returning row_id
    `,
      "objects",
    );
    if (audit.length !== 1) throw new Error("Recurring schedule audit record was not saved.");
    return "deleted";
  });
}

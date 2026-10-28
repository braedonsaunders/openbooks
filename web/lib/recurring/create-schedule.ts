import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date";
import {
  advanceCadence,
  assertTemplateTokensKnown,
  CATCH_UP_CHOICE_THRESHOLD,
  pendingOccurrences,
  RecurringError,
  recurringTemplateScopeFilter,
  remainingOccurrences,
  runScheduleCatchUp,
  toDateArrayLiteral,
  type CatchUpMode,
} from "@openbooks/engine/billing/recurring";
import { isoDate, uuidId } from "../api/json";
import { can, type Authz } from "../authz";
import { isDocKindEnabled } from "../documents";

const CADENCES = ["weekly", "biweekly", "monthly", "quarterly", "annually", "custom_cron"] as const;
const catchUpSchema = z.object({
  mode: z
    .enum(["post_all", "drafts", "skip", "selected"])
    .describe("How to handle pending occurrences."),
  dates: z
    .array(isoDate())
    .max(1000)
    .optional()
    .describe("Occurrence dates when mode is selected."),
  post: z.boolean().optional().describe("Whether selected catch-up documents should be posted."),
});

export const recurringScheduleCreateSchema = z.object({
  templateDocumentId: uuidId.optional().describe("Template document UUID."),
  templateDocumentNumber: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("Template document number when unique."),
  cadence: z.enum(CADENCES).describe("Schedule cadence."),
  cron: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullable()
    .optional()
    .describe("Cron expression for custom_cron cadence."),
  nextRunOn: isoDate()
    .optional()
    .describe("First occurrence date; defaults to the organization business date."),
  endsOn: isoDate().nullable().optional().describe("Optional final occurrence date."),
  maxOccurrences: z
    .number()
    .int()
    .min(1)
    .nullable()
    .optional()
    .describe("Optional maximum number of generated occurrences."),
  skippedRunOns: z.array(isoDate()).max(1000).optional().describe("Occurrence dates to skip."),
  autoPost: z
    .boolean()
    .optional()
    .describe("Whether generated documents should post automatically."),
  name: z.string().trim().max(255).nullable().optional().describe("Optional schedule name."),
  catchUp: catchUpSchema
    .optional()
    .describe("Required choice when multiple periods are already due."),
});

export type RecurringScheduleCreateInput = z.infer<typeof recurringScheduleCreateSchema>;

export class RecurringScheduleCreateRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RecurringScheduleCreateRefusal";
  }
}

export type RecurringScheduleCreateResult =
  | { kind: "not_found" }
  | { kind: "ambiguous" }
  | {
      kind: "created";
      id: string;
      isActive: boolean;
      catchUp?: Awaited<ReturnType<typeof runScheduleCatchUp>>;
    };

/** Shared route and command path for validating and saving a schedule. */
export async function createRecurringSchedule(
  authz: Authz,
  body: RecurringScheduleCreateInput,
): Promise<RecurringScheduleCreateResult> {
  const autoPost = body.autoPost ?? false;
  if (autoPost && !can(authz, "gl.post")) {
    throw new RecurringScheduleCreateRefusal("missing permission: gl.post", 403);
  }
  if (!body.templateDocumentId && !body.templateDocumentNumber) {
    throw new RecurringScheduleCreateRefusal("a template document is required", 400);
  }
  if (body.cadence === "custom_cron" && !body.cron) {
    throw new RecurringScheduleCreateRefusal("cron is required for custom_cron", 400);
  }

  const orgId = authz.user.orgId;
  const today = await businessToday(orgId);
  const nextRunOn = body.nextRunOn ?? today;
  try {
    advanceCadence(nextRunOn, body.cadence, body.cron);
  } catch (error) {
    if (error instanceof RecurringError)
      throw new RecurringScheduleCreateRefusal(error.message, 400);
    throw error;
  }
  if (body.endsOn && body.endsOn < nextRunOn) {
    throw new RecurringScheduleCreateRefusal("endsOn must not precede nextRunOn", 400);
  }
  const skippedRunOns = [...new Set(body.skippedRunOns ?? [])].sort();
  const maxOccurrences = body.maxOccurrences ?? null;
  const pending = pendingOccurrences(
    {
      cadence: body.cadence,
      cron: body.cron ?? null,
      nextRunOn,
      endsOn: body.endsOn ?? null,
      anchorDay: Number(nextRunOn.slice(8, 10)),
      skippedRunOns,
      remaining: remainingOccurrences(maxOccurrences, 0),
    },
    today,
  );
  if (pending.occurrences.length >= CATCH_UP_CHOICE_THRESHOLD && !body.catchUp) {
    throw new RecurringScheduleCreateRefusal(
      `${pending.occurrences.length} periods are already due — choose how to catch up instead of bulk-generating them`,
      409,
      "catch_up_choice_required",
      { occurrences: pending.occurrences, truncated: pending.truncated },
    );
  }

  const created = await db.transaction(async (tx) => {
    const candidates = await tx.execute<{ id: string; kind: string }>(
      sql`
      select d.id, d.kind from documents d where d.org_id = ${orgId}
        and ${body.templateDocumentId ? sql`d.id = ${body.templateDocumentId}` : sql`d.document_number = ${body.templateDocumentNumber}`}
        ${recurringTemplateScopeFilter(orgId, sql`d.id`, sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
      order by d.id limit 2 for share of d
    `,
      "objects",
    );
    if (!candidates.length) return null;
    const templates = await tx.execute<{ id: string; kind: string }>(
      sql`
      select d.id, d.kind from documents d where d.org_id = ${orgId}
        and d.id = any(${`{${candidates.map((row) => row.id).join(",")}}`}::uuid[])
        ${recurringTemplateScopeFilter(orgId, sql`d.id`, sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
      order by d.id
    `,
      "objects",
    );
    if (!templates.length || !(await isDocKindEnabled(orgId, templates[0]!.kind))) return null;
    if (templates.length > 1) return "ambiguous" as const;
    const templateDocumentId = templates[0]!.id;
    await assertTemplateTokensKnown(tx, orgId, templateDocumentId);
    const anchorDay = Number(nextRunOn.slice(8, 10));
    const rows = await tx.execute<Record<string, unknown> & { id: string }>(
      sql`
      insert into recurring_schedules (org_id, template_document_id, cadence, cron, next_run_on, ends_on,
                                       max_occurrences, skipped_run_ons, auto_post, name, anchor_day,
                                       created_by, updated_by)
      values (${orgId}, ${templateDocumentId}, ${body.cadence}, ${body.cron ?? null},
              ${nextRunOn}, ${body.endsOn ?? null}, ${maxOccurrences}, ${toDateArrayLiteral(skippedRunOns)}::date[],
              ${autoPost}, ${body.name ?? null}, ${anchorDay}, ${authz.user.id}, ${authz.user.id})
      returning *
    `,
      "objects",
    );
    const row = rows[0];
    if (!row) throw new Error("Recurring schedule insert returned no row.");
    const audit = await tx.execute<{ id: string }>(
      sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'recurring_schedules', ${row.id}, 'insert',
              ${JSON.stringify({ after: row })}::jsonb, ${authz.user.id})
      returning row_id as id
    `,
      "objects",
    );
    if (audit.length !== 1) throw new Error("Recurring schedule audit record was not saved.");
    return row;
  });
  if (!created) return { kind: "not_found" };
  if (created === "ambiguous") return { kind: "ambiguous" };
  const catchUp = body.catchUp
    ? await runScheduleCatchUp(orgId, created.id, {
        mode: body.catchUp.mode as CatchUpMode,
        selectedDates: body.catchUp.dates,
        postSelected: body.catchUp.post,
        asOf: today,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      })
    : undefined;
  const current = await db.execute<{ isActive: boolean }>(
    sql`
    select is_active as "isActive" from recurring_schedules where id = ${created.id} and org_id = ${orgId}
  `,
    "objects",
  );
  if (!current[0]) throw new Error("Recurring schedule disappeared after creation.");
  return {
    kind: "created",
    id: created.id,
    isActive: current[0].isActive,
    ...(catchUp ? { catchUp } : {}),
  };
}

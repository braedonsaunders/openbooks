import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { UNRESTRICTED_SCOPE_REQUIRED } from "@openbooks/engine/organization/scope";
import { guardSubsidiaryScope, type Authz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { parseCycleDays } from "@/lib/work-schedule-days";
import { canonicalDecimal } from "@/lib/exact-decimal";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { notFound } from "@/lib/api/responses";

const MAX_CYCLE_DAYS = 366;

const cycleDaySchema = z.strictObject({
  // Placeability belongs to parseCycleDays, which refuses an unplaceable row
  // by name (a missing index must refuse, never land on day zero). The
  // boundary only enforces the numeric shape.
  dayIndex: z.number().optional().describe("Zero-based day index within the work cycle."),
  hours: z
    .string()
    .max(32)
    .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/)
    .describe("Scheduled hours as an exact decimal string.")
    .superRefine((value, ctx) => {
      if (canonicalDecimal(value, 4) === null)
        ctx.addIssue({ code: "custom", message: "hours must be a readable decimal amount" });
    }),
});
const scheduleScopeSchema = {
  employeePartyId: uuidString()
    .nullable()
    .optional()
    .describe("Employee party id for an employee-specific schedule."),
  jobTitle: z.string().trim().max(120).nullable().optional().describe("Job title scope."),
  tradeId: uuidString().nullable().optional().describe("Trade scope id."),
  departmentId: uuidString().nullable().optional().describe("Department scope id."),
  subsidiaryId: uuidString().nullable().optional().describe("Subsidiary scope id."),
};
export const deleteWorkScheduleBodySchema = z.strictObject({
  action: z.literal("delete").describe("Delete a work schedule."),
  id: uuidString().describe("Schedule id from list_work_schedules."),
});

export const saveWorkScheduleBodySchema = z
  .strictObject({
    action: z.literal("save").describe("Create or replace a work schedule."),
    id: uuidString().optional().describe("Existing schedule id to replace; omit to create."),
    ...scheduleScopeSchema,
    name: z.string().trim().max(120).nullable().optional().describe("Optional schedule name."),
    notes: z.string().trim().max(2000).nullable().optional().describe("Optional schedule notes."),
    isActive: z.boolean().optional().describe("Whether the schedule is active."),
    effectiveFrom: z
      .string()
      .max(10)
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isIsoCalendarDate, "a start date must be a real calendar date (YYYY-MM-DD)")
      .describe("First effective date, YYYY-MM-DD."),
    effectiveTo: z
      .string()
      .max(10)
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isIsoCalendarDate, "the end date must be a real calendar date (YYYY-MM-DD)")
      .nullable()
      .optional()
      .describe("Last effective date, or null for no end."),
    pattern: z
      .enum(["cycle", "varies"])
      .default("cycle")
      .describe("Repeating cycle or variable hours."),
    cycleDays: z
      .number()
      .int()
      .min(1)
      .max(MAX_CYCLE_DAYS)
      .optional()
      .describe("Cycle length in days."),
    cycleAnchor: z
      .string()
      .max(10)
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isIsoCalendarDate, "the cycle anchor must be a real calendar date (YYYY-MM-DD)")
      .optional()
      .describe("Date that begins cycle day zero."),
    days: z
      .array(cycleDaySchema)
      .max(MAX_CYCLE_DAYS)
      .optional()
      .describe("Working-day hours for each cycle day."),
  })
  .superRefine((body, ctx) => {
    if (body.effectiveTo && body.effectiveTo < body.effectiveFrom) {
      ctx.addIssue({
        code: "custom",
        message: "the end date cannot precede the start date",
        path: ["effectiveTo"],
      });
    }
    if (body.pattern === "cycle") {
      if (body.cycleDays === undefined)
        ctx.addIssue({
          code: "custom",
          message: "the cycle length is required",
          path: ["cycleDays"],
        });
      if (body.cycleAnchor === undefined)
        ctx.addIssue({
          code: "custom",
          message: "the cycle needs a first day to count from",
          path: ["cycleAnchor"],
        });
      if (body.days === undefined)
        ctx.addIssue({ code: "custom", message: "cycle day rows are required", path: ["days"] });
    }
  });

export const workScheduleBodySchema = z.discriminatedUnion("action", [
  deleteWorkScheduleBodySchema,
  saveWorkScheduleBodySchema,
]);

const bad = (error: string) => NextResponse.json({ error }, { status: 422 });

function readScope(body: {
  employeePartyId?: string | null;
  jobTitle?: string | null;
  tradeId?: string | null;
  departmentId?: string | null;
  subsidiaryId?: string | null;
}) {
  const employeePartyId = isUuid(String(body.employeePartyId ?? ""))
    ? String(body.employeePartyId)
    : null;
  const tradeId = isUuid(String(body.tradeId ?? "")) ? String(body.tradeId) : null;
  const departmentId = isUuid(String(body.departmentId ?? "")) ? String(body.departmentId) : null;
  const subsidiaryId = isUuid(String(body.subsidiaryId ?? "")) ? String(body.subsidiaryId) : null;
  const jobTitle =
    typeof body.jobTitle === "string" && body.jobTitle.trim()
      ? body.jobTitle.trim().slice(0, 120)
      : null;
  const set = [employeePartyId, jobTitle, tradeId, departmentId, subsidiaryId].filter(Boolean);
  return { employeePartyId, jobTitle, tradeId, departmentId, subsidiaryId, count: set.length };
}

function scopedGate(gate: Authz): Authz {
  if (gate.allowedSubsidiaryIds === undefined) {
    return { ...gate, allowedSubsidiaryIds: new Set<string>() };
  }
  return gate;
}

function hidden() {
  return notFound("record");
}

async function scheduleRowBucket(
  tx: Pick<typeof db, "execute">,
  authz: Authz,
  orgId: string,
  row: { employee_party_id: string | null; subsidiary_id: string | null },
): Promise<"ok" | "hidden" | "org-wide"> {
  if (row.employee_party_id) {
    const sub =
      (
        await tx.execute<{ subsidiaryId: string | null }>(
          sql`
      select subsidiary_id as "subsidiaryId" from parties
       where org_id = ${orgId} and id = ${row.employee_party_id} for share`,
          "objects",
        )
      )[0]?.subsidiaryId ?? null;
    return guardSubsidiaryScope(authz, sub) ? "hidden" : "ok";
  }
  if (row.subsidiary_id) {
    return guardSubsidiaryScope(authz, row.subsidiary_id) ? "hidden" : "ok";
  }
  return "org-wide";
}

export async function writeWorkSchedule({
  authz: gate,
  body,
}: {
  authz: Authz;
  body: z.output<typeof workScheduleBodySchema>;
}) {
  const authz = scopedGate(gate);
  const unrestricted = authz.allowedSubsidiaryIds === null;
  const orgId = authz.user.orgId;
  const actorId = authz.user.id;

  // Schema refusals (calendar dates, cycle shape) answer 422 like the named
  // refusals below; malformed JSON keeps the 400 default.
  const action = body.action;

  if (action === "delete") {
    const id = body.id;
    // Snapshot the pattern and its days first: they decide holiday pay, and a
    // bare delete leaves no trace of what an absent employee was owed. The
    // row is locked and its scope rechecked inside the transaction, so a
    // concurrent rehome cannot move the delete onto another subsidiary.
    const outcome = await db.transaction(async (tx) => {
      const existing = (
        await tx.execute(
          sql`
          select * from work_schedules where org_id = ${orgId} and id = ${id} for update`,
          "objects",
        )
      )[0] as Record<string, unknown> | undefined;
      if (!existing) return "unknown" as const;
      const bucket = await scheduleRowBucket(tx, authz, orgId, {
        employee_party_id: (existing.employee_party_id as string | null) ?? null,
        subsidiary_id: (existing.subsidiary_id as string | null) ?? null,
      });
      if (bucket !== "ok") return bucket;
      const days = await tx.execute(
        sql`
          select * from work_schedule_days where org_id = ${orgId} and schedule_id = ${id} order by day_index`,
        "objects",
      );
      // work_schedule_days cascades on the FK, so the pattern never outlives
      // the schedule it describes.
      await tx.execute(sql`
          delete from work_schedules where org_id = ${orgId} and id = ${id}`);
      await tx.execute(sql`
          insert into audit_log
            (org_id, table_name, row_id, action, changes, actor_id)
          values
            (${orgId}, 'work_schedules', ${id}, 'delete',
             ${JSON.stringify({ before: { ...existing, days } })}::jsonb,
             ${actorId})
        `);
      return "ok" as const;
    });
    if (outcome === "ok") return NextResponse.json({ ok: true });
    if (outcome === "hidden") return hidden();
    if (outcome === "org-wide") {
      // An org-wide pattern decides every subsidiary's holiday pay at once,
      // so only an unrestricted caller may retire it. Reachable only for
      // restricted callers, hence the named 403 rather than the uniform 404.
      return NextResponse.json({ error: UNRESTRICTED_SCOPE_REQUIRED }, { status: 403 });
    }
    // A delete matching zero rows is a failure, not a success — and a
    // restricted caller cannot distinguish it from a hidden row anyway.
    return unrestricted ? bad("that work schedule no longer exists") : hidden();
  }

  if (action !== "save") return bad(`unknown action "${action}"`);

  const scope = readScope(body);
  if (scope.count > 1) {
    return bad(
      "a work schedule applies to exactly one scope — an employee, a job title, a trade, " +
        "a department, a subsidiary, or the organization. Choose one",
    );
  }

  // All three dates land in date columns and the save maps any failure to a
  // conflict message, so a shape-valid non-day would surface the raw driver
  // failure. Refuse anything that is not a real calendar day up front.
  const effectiveFrom = body.effectiveFrom;
  const effectiveTo = body.effectiveTo ?? null;
  if (effectiveTo && effectiveTo < effectiveFrom) {
    return bad("the end date cannot precede the start date");
  }

  const pattern = body.pattern;
  let cycleDays: number | null = null;
  let cycleAnchor: string | null = null;
  const days: { dayIndex: number; hours: string }[] = [];

  if (pattern === "cycle") {
    cycleDays = body.cycleDays ?? Number.NaN;
    if (!Number.isInteger(cycleDays) || cycleDays < 1 || cycleDays > MAX_CYCLE_DAYS) {
      return bad(`the cycle must be between 1 and ${MAX_CYCLE_DAYS} days long`);
    }
    cycleAnchor = body.cycleAnchor ?? "";
    if (!isIsoCalendarDate(cycleAnchor)) return bad("the cycle needs a first day to count from");
    const supplied = body.days ?? [];
    // A row the server cannot place refuses the save: silently dropping a
    // day would store a pattern nobody wrote, and it would go on paying
    // somebody.
    try {
      days.push(...parseCycleDays(supplied, cycleDays).days);
    } catch (error) {
      return bad(error instanceof Error ? error.message : "invalid days");
    }
    if (days.length === 0) {
      return bad(
        "a work schedule must have at least one working day. If the employee has no " +
          "regular schedule, record that their hours vary instead — the two are different facts " +
          "and several jurisdictions pay them differently",
      );
    }
  }

  const id = body.id ?? null;
  const name = body.name?.trim() || null;
  const notes = body.notes?.trim() || null;
  const isActive = body.isActive !== false;

  // Parent and days in ONE transaction: a schedule whose day rows half-applied
  // would be a pattern nobody wrote, and it would go on paying somebody. The
  // audit row lands in the same transaction so it never describes a state that
  // did not commit. Both the stored row's scope and the requested scope are
  // rechecked under their locks inside this transaction.
  const saved = await db
    .transaction(async (tx) => {
      let scheduleId = id;
      let before: Record<string, unknown> | null = null;
      let afterRow: Record<string, unknown>;
      // The requested scope first: a restricted caller may only write a
      // pattern for an employee or subsidiary they can see — a missing
      // employee reads exactly like a hidden one. A pattern with no entity
      // key decides every subsidiary's holiday pay at once, so writing one
      // is an org-wide write.
      if (scope.employeePartyId) {
        const sub =
          (
            await tx.execute<{ subsidiaryId: string | null }>(
              sql`
          select subsidiary_id as "subsidiaryId" from parties
           where org_id = ${orgId} and id = ${scope.employeePartyId} for share`,
              "objects",
            )
          )[0]?.subsidiaryId ?? null;
        if (guardSubsidiaryScope(authz, sub)) return { hidden: true };
      } else if (scope.subsidiaryId) {
        if (guardSubsidiaryScope(authz, scope.subsidiaryId)) return { hidden: true };
      } else if (!unrestricted) {
        return { "org-wide": true };
      }
      if (scheduleId) {
        const existing = (
          await tx.execute(
            sql`
          select * from work_schedules where org_id = ${orgId} and id = ${scheduleId} for update`,
            "objects",
          )
        )[0] as Record<string, unknown> | undefined;
        if (!existing)
          return unrestricted
            ? { conflict: "that work schedule no longer exists" }
            : { hidden: true };
        const bucket = await scheduleRowBucket(tx, authz, orgId, {
          employee_party_id: (existing.employee_party_id as string | null) ?? null,
          subsidiary_id: (existing.subsidiary_id as string | null) ?? null,
        });
        if (bucket !== "ok") return { [bucket]: true };
        const beforeDays = await tx.execute(
          sql`
          select * from work_schedule_days where org_id = ${orgId} and schedule_id = ${scheduleId} order by day_index`,
          "objects",
        );
        const updated = await tx.execute<Record<string, unknown>>(
          sql`
          update work_schedules
             set name = ${name}, employee_party_id = ${scope.employeePartyId},
                 job_title = ${scope.jobTitle}, trade_id = ${scope.tradeId},
                 department_id = ${scope.departmentId}, subsidiary_id = ${scope.subsidiaryId},
                 pattern = ${pattern}, cycle_days = ${cycleDays}, cycle_anchor = ${cycleAnchor},
                 effective_from = ${effectiveFrom}, effective_to = ${effectiveTo},
                 notes = ${notes}, is_active = ${isActive},
                 updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${scheduleId}
           returning *`,
          "objects",
        );
        before = { ...existing, days: beforeDays };
        scheduleId = updated[0]!.id as string;
        afterRow = updated[0]!;
        await tx.execute(sql`
          delete from work_schedule_days where org_id = ${orgId} and schedule_id = ${scheduleId}`);
      } else {
        const inserted = await tx.execute<Record<string, unknown>>(
          sql`
          insert into work_schedules (org_id, name, employee_party_id, job_title, trade_id,
                                      department_id, subsidiary_id, pattern, cycle_days, cycle_anchor,
                                      effective_from, effective_to, notes, is_active,
                                      created_by, updated_by)
          values (${orgId}, ${name}, ${scope.employeePartyId}, ${scope.jobTitle}, ${scope.tradeId},
                  ${scope.departmentId}, ${scope.subsidiaryId}, ${pattern}, ${cycleDays},
                  ${cycleAnchor}, ${effectiveFrom}, ${effectiveTo}, ${notes}, ${isActive},
                  ${actorId}, ${actorId})
          returning *`,
          "objects",
        );
        scheduleId = inserted[0]!.id as string;
        afterRow = inserted[0]!;
      }
      const afterDays: Record<string, unknown>[] = [];
      for (const day of days) {
        const dayRow = await tx.execute<Record<string, unknown>>(
          sql`
          insert into work_schedule_days (org_id, schedule_id, day_index, hours, created_by, updated_by)
          values (${orgId}, ${scheduleId}, ${day.dayIndex}, ${day.hours}, ${actorId}, ${actorId})
          returning *`,
          "objects",
        );
        afterDays.push(dayRow[0]!);
      }
      const after = { ...afterRow, days: afterDays };
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${orgId}, 'work_schedules', ${scheduleId}, ${before ? "update" : "insert"},
           ${JSON.stringify(before ? { before, after } : { after })}::jsonb,
           ${actorId})
      `);
      return scheduleId;
    })
    .catch((error: unknown) => {
      const message = (error as Error).message;
      // The one-row-per-scope-per-start-date index, surfaced as the sentence an
      // operator can act on rather than a constraint name.
      if (/work_schedules_scope_from/.test(message)) {
        return { conflict: "a work schedule for this scope already starts on that date" };
      }
      return { conflict: message };
    });

  if (typeof saved === "object" && saved !== null && "conflict" in saved) {
    return bad(String(saved.conflict));
  }
  if (typeof saved === "object" && saved !== null && "hidden" in saved) {
    return hidden();
  }
  if (typeof saved === "object" && saved !== null && "org-wide" in saved) {
    return NextResponse.json({ error: UNRESTRICTED_SCOPE_REQUIRED }, { status: 403 });
  }
  return NextResponse.json({ ok: true, id: saved });
}

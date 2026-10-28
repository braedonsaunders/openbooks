import { apiErrorResponse } from "@/lib/api/error-response";
import { isoDate, uuidId } from "@/lib/api/json";
import { z } from "zod";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import {
  RecurringError,
  runScheduleCatchUp,
  runScheduleNow,
  type CatchUpMode,
} from "@openbooks/engine/billing/recurring";
import { can } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import {
  deleteRecurringSchedule,
  ownedRecurringSchedule,
  RecurringScheduleActionRefusal,
  recurringSchedulePatchSchema,
  updateRecurringSchedule,
} from "@/lib/recurring/schedule-actions";

export const runtime = "nodejs";

const runBodySchema = z
  .object({
    catchUp: z
      .object({
        mode: z.enum(["post_all", "drafts", "skip", "selected"]),
        dates: z.array(isoDate()).max(1000).optional(),
        post: z.boolean().optional(),
      })
      .optional(),
  })
  .default({});

/** Update schedule settings using the same scoped, locked service path as commands. */
export const PATCH = defineRoute({
  permission: "documents.manage",
  feature: {
    none: "Recurring schedules are governed by document permissions and template kind availability.",
  },
  params: z.object({ id: uuidId }),
  invalidParamsNotFound: "record",
  body: recurringSchedulePatchSchema,
  opaque: {
    isActive:
      "Patch fields are independently optional; the handler preserves its existing empty-patch refusal.",
    autoPost:
      "Patch fields are independently optional; the handler preserves its existing empty-patch refusal.",
    nextRunOn:
      "Patch fields are independently optional; the handler preserves its existing empty-patch refusal.",
    endsOn:
      "Patch fields are independently optional; the handler preserves its existing empty-patch refusal.",
    maxOccurrences:
      "Patch fields are independently optional; the handler preserves its existing empty-patch refusal.",
    skippedRunOns:
      "Patch fields are independently optional; the handler preserves its existing empty-patch refusal.",
    name: "Patch fields are independently optional; the handler preserves its existing empty-patch refusal.",
    catchUp:
      "Patch fields are independently optional; the handler preserves its existing empty-patch refusal.",
  },
  handler: async ({ authz, params: { id }, body }) => {
    try {
      const result = await updateRecurringSchedule(authz, id, body);
      if (!result) return notFound("record");
      return NextResponse.json({
        ok: true,
        ...(result.catchUp ? { catchUp: result.catchUp } : {}),
      });
    } catch (error) {
      if (error instanceof RecurringScheduleActionRefusal) {
        return NextResponse.json(
          {
            error: error.message,
            ...(error.code ? { code: error.code } : {}),
            ...(error.details ?? {}),
          },
          { status: error.status },
        );
      }
      return apiErrorResponse(error);
    }
  },
});

/** Delete a schedule only while no generated documents depend on its lineage. */
export const DELETE = defineRoute({
  permission: "documents.manage",
  feature: {
    none: "Recurring schedules are governed by document permissions and template kind availability.",
  },
  params: z.object({ id: uuidId }),
  invalidParamsNotFound: "record",
  handler: async ({ authz, params: { id } }) => {
    const outcome = await deleteRecurringSchedule(authz, id);
    if (outcome === "not_found") return notFound("record");
    if (outcome === "generated_documents_exist") {
      return NextResponse.json(
        {
          error:
            "This recurring schedule cannot be deleted because generated documents exist; their immutable lineage must be preserved.",
          code: "generated_documents_exist",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  },
});

/** Run now or execute an explicit choice for pending schedule occurrences. */
export const POST = defineRoute({
  permission: "documents.manage",
  feature: {
    none: "Recurring schedules are governed by document permissions and template kind availability.",
  },
  params: z.object({ id: uuidId }),
  invalidParamsNotFound: "record",
  body: runBodySchema,
  handler: async ({ authz, params: { id }, body }) => {
    try {
      const existing = await db.transaction((tx) => ownedRecurringSchedule(tx, authz, id));
      if (!existing) return notFound("record");
      if (body.catchUp) {
        const outcome = await runScheduleCatchUp(authz.user.orgId, id, {
          mode: body.catchUp.mode as CatchUpMode,
          selectedDates: body.catchUp.dates,
          postSelected: body.catchUp.post,
          actorId: authz.user.id,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        });
        return NextResponse.json({ ok: true, catchUp: outcome });
      }
      const generated = await runScheduleNow(authz.user.orgId, id, authz.user.id, undefined, {
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        canPost: can(authz, "gl.post"),
      });
      return NextResponse.json(generated);
    } catch (error) {
      if (error instanceof RecurringError) return apiErrorResponse(error);
      return apiErrorResponse(error);
    }
  },
});

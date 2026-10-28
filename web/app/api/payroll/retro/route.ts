import { uuidId } from "@/lib/api/json-schema";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { isIsoCalendarDate } from "@openbooks/engine/platform/iso-date";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { createRetroPayRun, proposeRetroPay } from "@openbooks/engine/payroll/retro-store";
import {
  assertRetroExcludedSourcesInScope,
  RetroScopeNotFound,
  scopedRetroEmployees,
} from "../../../../lib/payroll/retro-scope";
import { notFound } from "@/lib/api/responses";

const retroInput = z.object({
  payScheduleId: uuidId,
  payDate: z
    .string()
    .refine(isIsoCalendarDate, "payDate must be a real calendar date (YYYY-MM-DD)"),
  employeePartyIds: z.array(uuidId).optional(),
  excludeSourcePayRunDocumentIds: z.array(uuidId).optional(),
});
const requestBodySchema = z.discriminatedUnion("action", [
  retroInput.extend({ action: z.literal("propose") }),
  retroInput.extend({ action: z.literal("create") }),
]);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Retroactive pay: detect → quantify → review → pay.
 *
 * `POST` with `{ action: 'propose' }` writes NOTHING. It re-runs each affected
 * committed period through the pay run's own calculation
 * (engine/src/payroll/retro-store.ts) and differences the earnings, so it is
 * expensive and unsafe to cache — which is exactly why it is a POST and not a
 * GET. It requires `payroll.run` rather than `payroll.read` for the same
 * reason: it is real payroll computation, not a query.
 *
 * `POST` with `{ action: 'create' }` builds the retro pay run and files the
 * settlements that are its evidence — `payroll.run`.
 *
 * Every rule (what counts as a trigger, what a difference is, what is payable,
 * how "exactly once" is enforced) lives in the engine. This route only
 * translates HTTP, so no second caller can reach a different answer.
 */

export const POST = defineRoute({
  permission: "payroll.run",
  feature: "payroll",
  body: requestBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body }) => {
    // An explicitly empty list is the workspace's default state (no
    // exclusions checked, no employee filter applied) and means the same as
    // an absent key. uuidList already folds [] to undefined; the checks below
    // must not mistake that fold for a malformed value, or every UI propose
    // that excludes nothing is refused with 422.
    const requestedEmployees = body.employeePartyIds?.length ? body.employeePartyIds : undefined;
    let employeePartyIds: string[];
    try {
      employeePartyIds = await scopedRetroEmployees(gate, body.payScheduleId, requestedEmployees);
    } catch (error) {
      if (error instanceof RetroScopeNotFound) return notFound("record");
      throw error;
    }

    const excludedSourcePayRunDocumentIds = body.excludeSourcePayRunDocumentIds?.length
      ? body.excludeSourcePayRunDocumentIds
      : undefined;
    try {
      await assertRetroExcludedSourcesInScope(
        gate,
        body.payScheduleId,
        excludedSourcePayRunDocumentIds,
      );
    } catch (error) {
      if (error instanceof RetroScopeNotFound) return notFound("record");
      throw error;
    }

    const input = {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      payScheduleId: body.payScheduleId,
      payDate: body.payDate,
      employeePartyIds,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    };

    try {
      if (body.action === "create") {
        const result = await createRetroPayRun({
          ...input,
          excludeSourcePayRunDocumentIds: excludedSourcePayRunDocumentIds,
        });
        return NextResponse.json(result);
      }
      return NextResponse.json(await proposeRetroPay(input));
    } catch (error) {
      // A refusal is the product working: nothing to pay, a decrease that is an
      // overpayment recovery, a period in another statutory year. It reaches the
      // operator as its own sentence, never as a 500.
      if (error instanceof PayrollError) {
        return apiErrorResponse(error, { safeStatus: 422 });
      }
      throw error;
    }
  },
});

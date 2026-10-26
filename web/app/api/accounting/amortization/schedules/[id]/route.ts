import { NextResponse } from "next/server";
import { z } from "zod";
import {
  activateSchedule,
  cancelSchedule,
  changeScheduleDestination,
  changeScheduleTerm,
  holdSchedule,
  loadScheduleDetail,
  reduceSchedule,
  resumeSchedule,
} from "@openbooks/engine/amortization";
import { db } from "@openbooks/engine/platform/database";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { exactMoney, isoDate, uuidId } from "@/lib/api/json";

export const runtime = "nodejs";

const params = z.object({ id: uuidId });

const common = {
  reason: z.string().min(5).max(2000),
  expectedRevision: z.number().int().min(1).optional(),
};

const actionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("activate"), ...common }),
  z.object({ action: z.literal("hold"), ...common }),
  z.object({ action: z.literal("resume"), ...common }),
  z.object({
    action: z.literal("change_term"),
    effectivePeriod: isoDate(),
    newLastPeriod: isoDate(),
    ...common,
  }),
  z.object({
    action: z.literal("change_destination"),
    effectivePeriod: isoDate(),
    destinationAccountId: uuidId,
    ...common,
  }),
  z.object({
    action: z.literal("reduce"),
    amount: exactMoney(),
    effectiveDate: isoDate(),
    relatedDocumentId: uuidId.nullable().optional(),
    ...common,
  }),
  z.object({
    action: z.literal("cancel"),
    mode: z.enum(["write_off", "reverse"]),
    effectiveDate: isoDate(),
    ...common,
  }),
]);

/** One schedule: header, balances, plan against posted by period, and history. */
export const GET = defineRoute({
  permission: "amortization.read",
  feature: "expenseAmortization",
  params,
  handler: async ({ authz, params: { id } }) => {
    const detail = await loadScheduleDetail(db, authz.user.orgId, id);
    if (
      authz.allowedSubsidiaryIds &&
      !authz.allowedSubsidiaryIds.has(detail.schedule.subsidiaryId)
    ) {
      return notFound("record");
    }
    return NextResponse.json(detail);
  },
});

/**
 * A governed schedule change. Every action carries a reason and may carry
 * the revision the operator reviewed, so a concurrent change refuses rather
 * than applying over it.
 */
export const POST = defineRoute({
  permission: "amortization.manage",
  feature: "expenseAmortization",
  params,
  body: actionBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) => {
    const base = {
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      scheduleId: id,
      reason: body.reason,
      expectedRevision: body.expectedRevision,
    };
    switch (body.action) {
      case "activate":
        return NextResponse.json(await activateSchedule(base));
      case "hold":
        return NextResponse.json(await holdSchedule(base));
      case "resume":
        return NextResponse.json(await resumeSchedule(base));
      case "change_term":
        return NextResponse.json(
          await changeScheduleTerm({
            ...base,
            effectivePeriod: body.effectivePeriod,
            newLastPeriod: body.newLastPeriod,
          }),
        );
      case "change_destination":
        return NextResponse.json(
          await changeScheduleDestination({
            ...base,
            effectivePeriod: body.effectivePeriod,
            destinationAccountId: body.destinationAccountId,
          }),
        );
      case "reduce":
        return NextResponse.json(
          await reduceSchedule({
            ...base,
            amount: body.amount,
            effectiveDate: body.effectiveDate,
            relatedDocumentId: body.relatedDocumentId ?? null,
          }),
        );
      case "cancel":
        return NextResponse.json(
          await cancelSchedule({ ...base, mode: body.mode, effectiveDate: body.effectiveDate }),
        );
    }
  },
});

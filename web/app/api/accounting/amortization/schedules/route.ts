import { NextResponse } from "next/server";
import { z } from "zod";
import { createManualSchedule } from "@openbooks/engine/amortization";
import { defineRoute } from "@/lib/api/route";
import { exactMoney, isoDate, uuidId } from "@/lib/api/json";

export const runtime = "nodejs";

const createBody = z.object({
  templateId: uuidId,
  subsidiaryId: uuidId,
  bookId: uuidId.nullable().optional(),
  totalAmount: exactMoney(),
  openingAmortizedAmount: exactMoney().optional(),
  serviceStartOn: isoDate(),
  serviceEndOn: isoDate().nullable().optional(),
  amortizeFromPeriod: isoDate().nullable().optional(),
  destinationAccountId: uuidId.nullable().optional(),
  departmentId: uuidId.nullable().optional(),
  projectId: uuidId.nullable().optional(),
  locationId: uuidId.nullable().optional(),
  classId: uuidId.nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
  reason: z.string().min(5).max(2000),
});

/**
 * Record a manual schedule — typically a prepaid balance carried in from
 * another system — as a draft. It posts nothing; activation starts its
 * amortization.
 */
export const POST = defineRoute({
  permission: "amortization.manage",
  feature: "expenseAmortization",
  body: createBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const created = await createManualSchedule({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      templateId: body.templateId,
      subsidiaryId: body.subsidiaryId,
      bookId: body.bookId,
      totalAmount: body.totalAmount,
      openingAmortizedAmount: body.openingAmortizedAmount,
      serviceStartOn: body.serviceStartOn,
      serviceEndOn: body.serviceEndOn ?? null,
      amortizeFromPeriod: body.amortizeFromPeriod ?? null,
      destinationAccountId: body.destinationAccountId ?? null,
      dimensions: {
        departmentId: body.departmentId ?? null,
        projectId: body.projectId ?? null,
        locationId: body.locationId ?? null,
        classId: body.classId ?? null,
      },
      memo: body.memo ?? null,
      reason: body.reason,
    });
    return NextResponse.json(created, { status: 201 });
  },
});

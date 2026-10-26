import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import {
  loadProcessorReceiptConfiguration,
  saveProcessorReceiptPolicy,
} from "@openbooks/engine/payments/documents";
import { PaymentError } from "@openbooks/engine/payments-core/payment-errors";
import { isoDate, uuidId } from "@/lib/api/json";

export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: "banking",
  handler: async ({ authz }) =>
    NextResponse.json(
      await loadProcessorReceiptConfiguration(
        authz.user.orgId,
        authz.user.id,
        authz.allowedSubsidiaryIds,
      ),
    ),
});

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "banking",
  body: z.object({
    provider: z.string().min(1).max(40),
    reason: z.string().trim().min(5).max(500),
    policy: z.object({
      id: uuidId,
      accountId: uuidId,
      subsidiaryId: uuidId,
      currency: z.string().regex(/^[A-Z]{3}$/),
      effectiveFrom: isoDate(),
      effectiveTo: isoDate().nullable(),
    }),
  }),
  handler: async ({ authz, body }) => {
    try {
      return NextResponse.json({
        policy: await saveProcessorReceiptPolicy(
          authz.user.orgId,
          body.provider,
          body.policy,
          authz.user.id,
          body.reason,
          authz.allowedSubsidiaryIds,
        ),
      });
    } catch (error) {
      return apiErrorResponse(error, error instanceof PaymentError ? { safeStatus: 422 } : {});
    }
  },
});

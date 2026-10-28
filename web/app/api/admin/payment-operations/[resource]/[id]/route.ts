import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { paymentOperationPatchBodySchema } from "@/lib/payment-operation-schemas";
import {
  PaymentOperationManagementError,
  updatePaymentFormatRecord,
  updatePaymentMandateRecord,
  updatePaymentProfileRecord,
  updatePaymentScheduleRecord,
  type PaymentOperationInput,
} from "@/lib/payment-operations-management";

export const runtime = "nodejs";

export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "Payment operation setup is available across features; currency fields are checked against Multi-Currency.",
  },
  params: z.object({ resource: z.string(), id: z.string() }),
  body: paymentOperationPatchBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ request, body, params, authz }) => {
    const { resource, id } = params;
    if (!isUuid(id) || !["formats", "profiles", "schedules", "mandates"].includes(resource)) {
      return notFound("record");
    }
    const patchFieldsByResource: Record<string, readonly string[]> = {
      formats: [
        "name",
        "country",
        "currency",
        "fileExtension",
        "contentType",
        "formatterScript",
        "isActive",
      ],
      profiles: [
        "name",
        "bankAccountId",
        "paymentFormatId",
        "subsidiaryId",
        "country",
        "currency",
        "originatorSecrets",
        "settings",
        "sftpServerId",
        "sftpFolder",
        "autoRemittance",
        "isActive",
      ],
      schedules: [
        "name",
        "paymentBankProfileId",
        "cron",
        "timezone",
        "selectionCriteria",
        "action",
        "isActive",
      ],
      mandates: ["status", "signedOn", "validFrom", "expiresOn"],
    };
    const unsupportedFields = Object.keys(body).filter(
      (field) => !patchFieldsByResource[resource]?.includes(field),
    );
    if (unsupportedFields.length > 0) {
      return NextResponse.json(
        { error: `Unsupported ${resource} settings: ${unsupportedFields.join(", ")}` },
        { status: 400 },
      );
    }
    const context = { authz, requestId: request.headers.get("X-Request-Id") };
    const input = body as unknown as PaymentOperationInput;
    try {
      const result =
        resource === "formats"
          ? await updatePaymentFormatRecord(context, id, input)
          : resource === "profiles"
            ? await updatePaymentProfileRecord(context, id, input)
            : resource === "schedules"
              ? await updatePaymentScheduleRecord(context, id, input)
              : await updatePaymentMandateRecord(context, id, input);
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound("record");
      if (error instanceof PaymentOperationManagementError) {
        if (error.status === 404) return notFound("record");
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return apiErrorResponse(error);
    }
  },
});

import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { notFound } from "@/lib/api/responses";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { paymentOperationCreateBodySchema } from "@/lib/payment-operation-schemas";
import {
  createPaymentFormatRecord,
  createPaymentMandateRecord,
  createPaymentProfileRecord,
  createPaymentScheduleRecord,
  listPaymentOperationConfigs,
  settlePaymentOperationRouteError,
  type PaymentOperationInput,
  type PaymentOperationResource,
} from "@/lib/payment-operations-management";

export const runtime = "nodejs";

const RESOURCES = new Set(["formats", "profiles", "schedules", "mandates"]);

async function legacyGET(
  _req: Request,
  { params }: { params: Promise<{ resource: string }> },
  authz: import("@/lib/authz").Authz,
) {
  const { resource } = await params;
  if (!RESOURCES.has(resource)) return notFound("record");
  return NextResponse.json(
    await listPaymentOperationConfigs(resource as PaymentOperationResource, { authz }),
  );
}

export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "Payment operation setup is available across features; currency fields are checked against Multi-Currency.",
  },
  params: z.object({ resource: z.string() }),
  handler: async ({ request, params, authz }) =>
    legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "Payment operation setup is available across features; currency fields are checked against Multi-Currency.",
  },
  params: z.object({ resource: z.string() }),
  body: paymentOperationCreateBodySchema,
  handler: async ({ request, body, params, authz }) => {
    const { resource } = params;
    if (!RESOURCES.has(resource)) return notFound("record");
    const context = { authz, requestId: request.headers.get("X-Request-Id") };
    const input = body as unknown as PaymentOperationInput;
    try {
      const result =
        resource === "formats"
          ? await createPaymentFormatRecord(context, input)
          : resource === "profiles"
            ? await createPaymentProfileRecord(context, input)
            : resource === "schedules"
              ? await createPaymentScheduleRecord(context, input)
              : await createPaymentMandateRecord(context, input);
      return NextResponse.json(result, { status: 201 });
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound("record");
      const refusal = settlePaymentOperationRouteError(error);
      if (refusal.status === 404) return notFound("record");
      return NextResponse.json({ error: refusal.message }, { status: refusal.status });
    }
  },
});

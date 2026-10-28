import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { advancedSubscriptionWorkspace } from "@openbooks/engine/billing/advanced-subscriptions";
import {
  POSTBodySchema1,
  executeAdvancedSubscriptionAction,
} from "@/lib/subscriptions/advanced-actions";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "ar.read",
  feature: "advancedSubscriptions",
  handler: async ({ authz }) => {
    return NextResponse.json(
      await advancedSubscriptionWorkspace(authz.user.orgId, authz.allowedSubsidiaryIds),
    );
  },
});

export const POST = defineRoute({
  permission: "ar.create",
  feature: "advancedSubscriptions",
  body: POSTBodySchema1,
  opaque: {
    componentKey: "amendment keys are matched by name in the handler with an indexed 422",
    quantity: "quantities are parsed to exact decimals in the handler with an indexed 422",
    unitPrice:
      "an omitted price is refused in the handler with an indexed 422 naming the component",
    isOptional: "flags are type-checked in the handler with an indexed 422 naming the component",
  },
  handler: ({ authz, body }) => executeAdvancedSubscriptionAction(authz, body),
});

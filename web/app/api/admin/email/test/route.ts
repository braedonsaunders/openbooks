import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";

import { testEmailTransportAction } from "@/lib/delivery/email-admin-actions";

const requestBodySchema = z.object({ to: z.string().trim().min(1).max(320) });

export const runtime = "nodejs";

/**
 * Send a test email through the org's currently-saved transport (synchronous so
 * the admin sees the outcome immediately). Records an email_log row either way.
 */

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "Email delivery tests are available while administrators configure organization-wide transport.",
  },
  body: requestBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {
    // Sending through (and probing) the org transport is setup authority.
    const gate = routeAuthz;

    const result = await testEmailTransportAction({
      orgId: gate.user.orgId,
      userId: gate.user.id,
      to: body.to,
    });
    return NextResponse.json(result.body, { status: result.status });
  },
});

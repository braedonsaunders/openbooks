import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { applicationContextFromSession } from "@/lib/application/context";
import { transitionCustomRecordType } from "@/lib/application/custom-record-types";

const requestBodySchema = z
  .object({
    action: z.enum(["archive", "publish"]).optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided.",
  });

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "records.manage_types",
  feature: {
    none: "Custom record types are an administrative registry with no organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  body: requestBodySchema,
  handler: async ({ body, params, authz, request }) => {
    const result = await transitionCustomRecordType(
      applicationContextFromSession(
        authz,
        "api",
        request.headers.get("x-request-id") || randomUUID(),
      ),
      params.id,
      body.action ?? "publish",
      body.reason ?? "",
    );
    return NextResponse.json(result.body, { status: result.status });
  },
});

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { formSectionSchema } from "@openbooks/forms-core";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { applicationContextFromSession } from "@/lib/application/context";
import {
  createCustomRecordType,
  listCustomRecordTypeDefinitions,
} from "@/lib/application/custom-record-types";

const createTypeBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  pluralName: z.string().optional(),
  key: z.string().optional(),
  iconKey: z.string().optional(),
  description: z.string().nullable().optional(),
  fields: z.array(formSectionSchema).max(100).optional(),
  showInNav: z.boolean().optional(),
  allowedRoles: z.string().array().nullable().optional(),
  sortOrder: z.number().optional(),
});

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "records.manage_types",
  feature: {
    none: "Custom record types are an administrative registry with no organization feature switch.",
  },
  handler: async ({ authz, request }) =>
    NextResponse.json({
      types: await listCustomRecordTypeDefinitions(
        applicationContextFromSession(
          authz,
          "api",
          request.headers.get("x-request-id") || randomUUID(),
        ),
      ),
    }),
});

export const POST = defineRoute({
  permission: "records.manage_types",
  feature: {
    none: "Custom record types are an administrative registry with no organization feature switch.",
  },
  body: createTypeBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ request, body, authz }) => {
    const result = await createCustomRecordType(
      applicationContextFromSession(
        authz,
        "api",
        request.headers.get("x-request-id") || randomUUID(),
      ),
      body as Record<string, unknown>,
      request.headers.get("Idempotency-Key")?.trim() ?? "",
    );
    return NextResponse.json(result.body, { status: result.status });
  },
});

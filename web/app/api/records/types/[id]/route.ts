import { randomUUID } from "node:crypto";
import { z } from "zod";
import { formSectionSchema } from "@openbooks/forms-core";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { applicationContextFromSession } from "@/lib/application/context";
import {
  deleteCustomRecordType,
  getCustomRecordTypeDefinition,
  updateCustomRecordType,
} from "@/lib/application/custom-record-types";

const requestBodySchema = z
  .object({
    allowedRoles: z.array(z.string().min(1).max(100)).max(50).nullable().optional(),
    description: z.string().optional(),
    expectedUpdatedAt: z.string().optional(),
    fields: z.array(formSectionSchema).max(100).optional(),
    iconKey: z.string().optional(),
    key: z.string().optional(),
    name: z.string().optional(),
    pluralName: z.string().optional(),
    showInNav: z.boolean().optional(),
    sortOrder: z.number().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided.",
  });

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "records.manage_types",
  feature: {
    none: "Custom record types are an administrative registry with no organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  handler: async ({ params, authz, request }) => {
    const result = await getCustomRecordTypeDefinition(
      applicationContextFromSession(
        authz,
        "api",
        request.headers.get("x-request-id") || randomUUID(),
      ),
      params.id,
    );
    return NextResponse.json(result.body, { status: result.status });
  },
});

export const PATCH = defineRoute({
  permission: "records.manage_types",
  feature: {
    none: "Custom record types are an administrative registry with no organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  body: requestBodySchema,
  handler: async ({ body, params, authz, request }) => {
    const result = await updateCustomRecordType(
      applicationContextFromSession(
        authz,
        "api",
        request.headers.get("x-request-id") || randomUUID(),
      ),
      params.id,
      body as Record<string, unknown>,
    );
    return NextResponse.json(result.body, { status: result.status });
  },
});

export const DELETE = defineRoute({
  permission: "records.manage_types",
  feature: {
    none: "Custom record types are an administrative registry with no organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  handler: async ({ params, authz, request }) => {
    const result = await deleteCustomRecordType(
      applicationContextFromSession(
        authz,
        "api",
        request.headers.get("x-request-id") || randomUUID(),
      ),
      params.id,
    );
    return NextResponse.json(result.body, { status: result.status });
  },
});

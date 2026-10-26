import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { isDocumentRevisionToken } from "@openbooks/engine/records/revision";
import {
  createCustomFieldDefinition,
  updateCustomFieldDefinition,
} from "@openbooks/engine/records/custom-field-admin";
import { isUuid } from "@/lib/list-params";
import { normalizeCustomFieldConfig } from "@/lib/custom-field-config";
import { validateCustomFieldDefinition as validateDef } from "@/lib/custom-field-definition";

import { isCustomFieldTargetEnabled } from "@/lib/customization/gates";
import { notFound } from "@/lib/api/responses";

const customFieldConfigSchema = z.record(z.string(), z.json());
const createCustomFieldBodySchema = z.object({
  targetTable: z.string().min(1),
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  fieldType: z.enum([
    "text",
    "long_text",
    "number",
    "currency",
    "date",
    "boolean",
    "select",
    "multi_select",
    "reference",
  ]),
  config: customFieldConfigSchema.optional(),
  targetKind: z.string().nullable().optional(),
  isRequired: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
const updateCustomFieldBodySchema = z.object({
  // The handler hides malformed/foreign ids alike and returns a named
  // reload conflict for every absent or malformed revision.
  id: z.string(),
  expectedUpdatedAt: z.union([z.string(), z.null()]).optional(),
  targetTable: z.string().optional(),
  targetKind: z.string().nullable().optional(),
  key: z.string().optional(),
  config: customFieldConfigSchema.optional(),
  fieldType: z
    .enum([
      "text",
      "long_text",
      "number",
      "currency",
      "date",
      "boolean",
      "select",
      "multi_select",
      "reference",
    ])
    .optional(),
  isActive: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  label: z.string().trim().min(1).optional(),
  sortOrder: z.number().int().optional(),
});

export const runtime = "nodejs";

function revisionConflict() {
  return NextResponse.json(
    { error: "The field definition has changed. Reload it before saving." },
    { status: 409 },
  );
}

export const POST = defineRoute({
  permission: "admin.custom_fields.manage",
  feature: {
    none: "Custom field definitions are organization-wide customization and have no single module feature gate.",
  },
  // Definitions keep the established 400 contract for invalid bodies, and
  // creation accepts no undocumented fields: a supplied key outside the
  // create shape is refused instead of silently stripped.
  invalidBodyStatus: 400,
  body: createCustomFieldBodySchema.strict(),
  handler: async ({ request, body, authz: routeAuthz }) => {
    const gate = routeAuthz;

    const user = gate.user;

    const err = validateDef(body);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
    if (
      !(await isCustomFieldTargetEnabled(
        user.orgId,
        String(body.targetTable),
        body.targetKind ? String(body.targetKind) : null,
      ))
    ) {
      return notFound("record");
    }

    const result = await createCustomFieldDefinition({
      orgId: user.orgId,
      actorId: user.id,
      requestId: request.headers.get("X-Request-Id"),
      input: {
        ...body,
        config: normalizeCustomFieldConfig(body.config),
      },
    });
    if (result.kind === "duplicate") {
      return NextResponse.json(
        { error: "a field with that key already exists on that target" },
        { status: 409 },
      );
    }
    return NextResponse.json({ id: result.id, updatedAt: result.updatedAt });
  },
});

export const PATCH = defineRoute({
  permission: "admin.custom_fields.manage",
  feature: {
    none: "Custom field definitions are organization-wide customization and have no single module feature gate.",
  },
  // Same 400 contract as creation. The update shape stays non-strict: patch
  // callers resend stable identity fields the update ignores.
  invalidBodyStatus: 400,
  body: updateCustomFieldBodySchema,
  handler: async ({ request, body, authz: routeAuthz }) => {
    const gate = routeAuthz;

    const user = gate.user;

    if (typeof body.id !== "string" || !isUuid(body.id)) {
      return notFound("record");
    }
    if (!isDocumentRevisionToken(body.expectedUpdatedAt)) return revisionConflict();

    const result = await updateCustomFieldDefinition({
      orgId: user.orgId,
      actorId: user.id,
      requestId: request.headers.get("X-Request-Id"),
      id: body.id,
      expectedUpdatedAt: body.expectedUpdatedAt,
      body,
      isTargetEnabled: isCustomFieldTargetEnabled,
      validate: validateDef,
      normalizeConfig: normalizeCustomFieldConfig,
    });
    if (result.kind === "missing" || result.kind === "target_disabled") return notFound("record");
    if (result.kind === "revision_conflict") return revisionConflict();
    if (result.kind === "invalid")
      return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true, updatedAt: result.updatedAt });
  },
});

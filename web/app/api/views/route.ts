import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";

import { NextResponse } from "next/server";
import { z } from "zod";
import { REPORT_ENTITY_MAP, defaultRowsQuery, validateReportLayout } from "@openbooks/reports";
import { validateOrgReportQuery } from "@/lib/custom-record-report-catalog";
import type { Authz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { canRunReportEntity, guardReportEntity } from "@/lib/report-authz";
import { createView, loadViews, type ViewScope } from "@/lib/views";

const createViewBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().nullable().optional(),
  query: z.json().optional(),
  layout: z.json().optional(),
  scope: z.enum(["private", "shared"], { error: "Invalid scope" }).optional(),
  allowedRoles: z.array(z.string().trim().min(1).max(100)).max(50).nullable().optional(),
});

export const runtime = "nodejs";

/**
 * List the views visible to the caller (own private + shared).
 *
 * Filtered by the same entity gate the runner applies. Listing a payroll plan
 * to a reader who cannot run it leaks the catalog (names, descriptions and the
 * stored plan itself) and hands out the id that every execution path keys on.
 */
async function listViews(gate: Authz) {
  const { user, permissions } = gate;
  const rows = await loadViews(user.orgId, user.id, permissions);
  const visible = [];
  for (const row of rows) {
    if (!(await canRunReportEntity(gate, row.query))) continue;
    visible.push(row);
  }
  return NextResponse.json({ views: visible });
}

/**
 * Explicit create for a saved view. The New button opens an UNSAVED studio
 * (`?view=new`) and this endpoint runs only on Save: the caller supplies a
 * UUID idempotency key, which becomes the view id, so retrying the same
 * request returns the same view without a duplicate insert or duplicate
 * audit event. Cancel/close writes nothing.
 */

export const GET = defineRoute({
  permission: "reports.read",
  feature: {
    none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks.",
  },
  handler: async ({ authz }) => listViews(authz),
});

export const POST = defineRoute({
  permission: "reports.create",
  feature: {
    none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks.",
  },
  body: createViewBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ request, body, authz: gate }) => {
    const { user } = gate;

    const requestId = request.headers.get("Idempotency-Key")?.trim() ?? "";
    if (!isUuid(requestId)) {
      return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
    }

    const name = body.name?.trim() || "Untitled view";
    const description = body.description?.trim() || null;

    let query = defaultRowsQuery(REPORT_ENTITY_MAP.ledger_lines!);
    if (body.query !== undefined) {
      try {
        query = await validateOrgReportQuery(gate, body.query);
      } catch (err) {
        return apiErrorResponse(err);
      }
      const denied = await guardReportEntity(gate, query);
      if (denied) return denied;
    }
    const layout = (validateReportLayout(body.layout) as Record<string, unknown> | null) ?? null;

    const scopeValue: unknown = body.scope ?? "private";
    if (scopeValue !== "private" && scopeValue !== "shared") {
      return NextResponse.json({ error: "Invalid scope" }, { status: 422 });
    }
    const scope: ViewScope = scopeValue;
    let allowedRoles: string[] | null = null;
    if (body.allowedRoles !== undefined && body.allowedRoles !== null) {
      if (
        !Array.isArray(body.allowedRoles) ||
        body.allowedRoles.some((r) => typeof r !== "string" || r.trim() === "")
      ) {
        return NextResponse.json({ error: "Invalid allowedRoles" }, { status: 422 });
      }
      const roles = [...new Set((body.allowedRoles as string[]).map((r) => r.trim()))];
      allowedRoles = roles.length ? roles : null;
    }

    try {
      const created = await createView({
        orgId: user.orgId,
        userId: user.id,
        idempotencyKey: requestId,
        name,
        description,
        query,
        layout,
        scope,
        allowedRoles,
      });
      return NextResponse.json(
        { id: created.id, slug: created.slug },
        { status: created.replayed ? 200 : 201 },
      );
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_idempotency_key") {
        return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 409 });
      }
      throw error;
    }
  },
});

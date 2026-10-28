import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import { canSeeReportDefinition } from "../../../../lib/report-authz";
import { ensureReportDefinitions } from "@openbooks/engine/reports/ensure-report-definitions";
import { isUuid } from "../../../../lib/list-params";
import { createReportDefinition } from "../../../../lib/report-definition-write";
import { reportDefinitionRouteError } from "../../../../lib/report-definition-route-error";

const reportLayoutSchema = z
  .object({
    paperSize: z.enum(["letter", "legal", "a4"]).optional(),
    orientation: z.enum(["portrait", "landscape"]).optional(),
    marginMm: z.number().finite().optional(),
    showSummary: z.boolean().optional(),
    density: z.enum(["compact", "standard"]).optional(),
  })
  .nullable()
  .optional();
const createReportBodySchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  query: z.json(),
  layout: reportLayoutSchema,
});

export const runtime = "nodejs";

/**
 * List report definitions for the org (built-in + custom).
 *
 * Filtered by the same entity gate the runner applies. Listing a payroll plan
 * to a reader who cannot run it leaks the catalog (names, descriptions and the
 * stored plan itself) and hands out the id that every execution path keys on.
 */
export const GET = defineRoute({
  permission: "reports.read",
  feature: {
    none: "The list filters each definition by its statement or query entity feature access.",
  },
  handler: async ({ authz: routeAuthz }) => {
    const gate = routeAuthz;
    const { user } = gate;
    await ensureReportDefinitions(user.orgId);
    const rows = await db.execute<{
      report_type: string | null;
      query: unknown;
      statement: { kind?: string } | null;
    }>(
      sql`
        select id, kind, report_type, slug, name, description, query, statement, updated_at
          from report_definitions
         where org_id = ${user.orgId} and archived_at is null
         order by kind, name
      `,
      "objects",
    );
    const visible = [];
    for (const row of rows) {
      // Statements answer the statement feature gate and query plans the
      // entity gate; the entity gate alone hides every built-in statement.
      if (!(await canSeeReportDefinition(gate, row))) continue;
      visible.push(row);
    }
    return NextResponse.json({
      definitions: visible,
    });
  },
});

/**
 * Explicit create for the unsaved report builder. The caller's UUID
 * Idempotency-Key becomes the definition id, so Save retries replay the same
 * tenant-scoped row and audit event. Opening/cancelling `builder/new` never
 * calls this endpoint and therefore allocates nothing.
 */
export const POST = defineRoute({
  permission: "reports.create",
  feature: {
    none: "The submitted query is checked for its entity feature access before the definition is saved.",
  },
  body: createReportBodySchema,
  handler: async ({ request: req, authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;
    const requestId = req.headers.get("Idempotency-Key")?.trim() ?? "";
    if (!isUuid(requestId)) {
      return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
    }

    try {
      const result = await createReportDefinition(gate, routeBody, requestId);
      return NextResponse.json(
        { definition: result.definition },
        { status: result.replayed ? 200 : 201 },
      );
    } catch (error) {
      return reportDefinitionRouteError(error, {
        idempotencyConflict: true,
      });
    }
  },
});

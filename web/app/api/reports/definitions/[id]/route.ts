import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { isUuid } from "../../../../../lib/list-params";
import { canSeeReportDefinition } from "../../../../../lib/report-authz";
import { loadReportDefinition } from "../../../../../lib/custom-reports";
import {
  archiveReportDefinition,
  loadReportDefinitionRevision,
  updateReportDefinition,
} from "../../../../../lib/report-definition-write";
import { notFound } from "@/lib/api/responses";
import { reportDefinitionRouteError } from "../../../../../lib/report-definition-route-error";
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
const PATCHBodySchema1 = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: z.string().nullable().optional(),
    query: z.json().optional(),
    layout: reportLayoutSchema,
    expectedUpdatedAt: z.string().min(1).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided.",
  });

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "reports.read",
  feature: {
    none: "The loaded definition is filtered by its effective statement or query entity feature access.",
  },
  handler: async ({ authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const def = await loadReportDefinition(gate.user.orgId, id);
    if (!def) return notFound("record");
    if (!(await canSeeReportDefinition(gate, def))) return notFound("record");
    const updatedAt = await loadReportDefinitionRevision(gate.user.orgId, id);
    return NextResponse.json({ definition: { ...def, updated_at: updatedAt ?? def.updated_at } });
  },
});

/**
 * Autosave/save for a definition. Built-ins are name/query-editable in place
 * too (an org may tune a seeded plan), but the kind is never changed here.
 */
export const PATCH = defineRoute({
  permission: "reports.create",
  feature: {
    none: "Updated query plans are checked for their entity feature access before they are saved.",
  },
  body: PATCHBodySchema1,
  handler: async ({ authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params;
    try {
      const definition = await updateReportDefinition(
        gate,
        id,
        routeBody as {
          name?: string;
          description?: string | null;
          query?: unknown;
          layout?: unknown;
          expectedUpdatedAt?: string;
        },
      );
      return NextResponse.json({ definition });
    } catch (error) {
      return reportDefinitionRouteError(error);
    }
  },
});

export const DELETE = defineRoute({
  permission: "reports.create",
  feature: {
    none: "Deletion checks access to the selected definition before changing its lifecycle state.",
  },
  handler: async ({ authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params;
    try {
      await archiveReportDefinition(gate, id);
      return NextResponse.json({ ok: true });
    } catch (error) {
      return reportDefinitionRouteError(error);
    }
  },
});

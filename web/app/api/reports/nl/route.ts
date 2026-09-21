import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import { REPORT_ENTITY_MAP } from "@openbooks/reports";
import { draftNlReport, validateNlDefinition } from "@openbooks/engine/src/hrm/ai/nl-reports.ts";
import { logDecision } from "@openbooks/engine/src/hrm/ai/governance.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { executeReport } from "../../../../lib/custom-reports";
import { aiRailsErrorResponse, requireAnyPerm } from "../../../../lib/ai-rails";
import { isFeatureEnabled } from "../../../../lib/features";
import { canRunReportEntity, hiddenReportEntityKeys } from "../../../../lib/report-authz";

export const runtime = "nodejs";

const nlBody = z.object({
  action: z.enum(["preview", "save"]),
  question: z.string().min(1).max(1000),
  definition: z.unknown(),
});

/**
 * Natural-language reports. POST validates the candidate definition
 * strictly against the caller's visible catalog (unknown or ungated
 * entities refuse by name, never repaired), runs it once as a preview
 * under the caller's report gates, and on save stores the draft for
 * save-as-view. The output is a report-engine definition, never SQL.
 */
export async function POST(req: Request) {
  const authz = await requireAnyPerm(["reports.read"]);
  if (authz instanceof NextResponse) return authz;
  if (!(await isFeatureEnabled(authz.user.orgId, "hrmNlReports"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, nlBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const hidden = new Set(await hiddenReportEntityKeys(authz));
    const catalog = Object.values(REPORT_ENTITY_MAP)
      .filter((e) => !hidden.has(e.key))
      .map((e) => ({
        key: e.key,
        columns: e.columns.map((c) => c.key),
        requiredPermission: e.requiredPermission ?? null,
      }));
    const callerPermissions = [...authz.permissions];
    // Validate before preview so an unexecutable definition refuses
    // before it ever runs.
    const definition = validateNlDefinition(body.definition, catalog, callerPermissions);
    if (!(await canRunReportEntity(authz, { entity: definition.entity }))) {
      return NextResponse.json({ error: "you do not have access to this data" }, { status: 403 });
    }
    const preview = await executeReport(authz.user.orgId, {
      entity: definition.entity,
      mode: definition.mode,
      columns: definition.columns,
      breakouts: definition.breakouts,
      measures: definition.measures,
      filters: definition.filters as { combinator: "and" | "or"; rules: never[] } | null,
      sorts: definition.sorts,
      limit: definition.limit,
    }, 5);
    const previewRows = preview.groups.flatMap((g) => g.rows.slice(0, 5)).slice(0, 5);
    if (body.action === "preview") {
      await logDecision(db, {
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        capabilityKey: "hrmNlReports",
        subjectKind: "nl_report_preview",
        subjectId: null,
        input: body.question,
        output: `entity=${definition.entity} mode=${definition.mode}`,
        outputSummary: `report preview from question (${definition.entity}, ${definition.mode})`,
        sources: [{ kind: "report_entity", id: definition.entity }],
        outcome: "shown",
        model: "nl-report-route",
      });
      return NextResponse.json({ definition, previewRows });
    }
    const saved = await draftNlReport({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      question: body.question,
      candidate: body.definition,
      catalog,
      callerPermissions,
    });
    return NextResponse.json({ draftId: saved.draftId, definition: saved.definition, previewRows });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}

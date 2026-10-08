import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { guardCsvCell } from "@openbooks/office";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { listDecisionsPage } from "@openbooks/engine/src/hrm/ai/governance.ts";
import { aiRailsErrorResponse } from "../../../../lib/ai-rails";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

// Summaries and model names are free text, so every cell passes the shared
// formula-injection guard before it is quoted for CSV.
function csvCell(value: unknown): string {
  const text = String(guardCsvCell(value === null || value === undefined ? "" : String(value)));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * AI decision ledger. GET lists rows with capability/outcome filters;
 * ?format=csv exports the same authorized page (digests never selected, on either
 * path — they are tamper-evidence, not UI content). Ledger under the
 * setup grant, fenced per row in the service: employment-linked rows
 * need the reader's own payroll/HR grant plus the subject's employer
 * scope, so a restricted setup admin never sees out-of-scope pay.
 */
async function legacyGET(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "aiGovernanceLedger"))) {
    return notFound("record");
  }
  const url = new URL(req.url);
  const capabilityKey = url.searchParams.get("capabilityKey") ?? undefined;
  const outcome = url.searchParams.get("outcome") ?? undefined;
  const format = url.searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "csv") {
    return NextResponse.json({ error: "format must be json or csv" }, { status: 400 });
  }
  try {
    const parsed = z.object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      perPage: z.coerce.number().int().min(1).max(200).default(200),
    }).safeParse(Object.fromEntries(['page', 'perPage'].flatMap((key) => url.searchParams.has(key) ? [[key, url.searchParams.get(key)]] : [])));
    if (!parsed.success) return NextResponse.json({ error: 'Choose a valid activity page and page size (1–200).' }, { status: 400 });
    const { page, perPage } = parsed.data;
    const { decisions, total } = await listDecisionsPage(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      capabilityKey,
      outcome,
      limit: perPage,
      offset: (page - 1) * perPage,
    });
    if (format === "csv") {
      const header = ["id", "recorded_at", "capability", "actor", "subject_kind", "subject_id", "summary", "outcome", "reviewer", "model"];
      const lines = [header.join(",")];
      for (const d of decisions) {
        lines.push([
          d.id, d.recordedAt, d.capabilityKey, d.actorUserId, d.subjectKind,
          d.subjectId ?? "", d.outputSummary, d.outcome, d.humanReviewer ?? "", d.model,
        ].map(csvCell).join(","));
      }
      return new NextResponse(lines.join("\n"), {
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="assistant-activity.csv"', "cache-control": "private, no-store" },
      });
    }
    return NextResponse.json({ decisions, total, page, perPage }, { headers: { "cache-control": "private, no-store" } });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}

export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  handler: async ({ request }) => legacyGET(request as never),
});

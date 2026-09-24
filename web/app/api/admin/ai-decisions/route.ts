import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { listDecisions } from "@openbooks/engine/src/hrm/ai/governance.ts";
import { aiRailsErrorResponse } from "../../../../lib/ai-rails";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";

export const runtime = "nodejs";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * AI decision ledger. GET lists rows with capability/outcome filters;
 * ?format=csv exports the same rows (digests never selected, on either
 * path — they are tamper-evidence, not UI content). Ledger under the
 * setup grant, fenced per row in the service: employment-linked rows
 * need the reader's own payroll/HR grant plus the subject's employer
 * scope, so a restricted setup admin never sees out-of-scope pay.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "aiGovernanceLedger"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const capabilityKey = url.searchParams.get("capabilityKey") ?? undefined;
  const outcome = url.searchParams.get("outcome") ?? undefined;
  const format = url.searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "csv") {
    return NextResponse.json({ error: "format must be json or csv" }, { status: 400 });
  }
  try {
    const decisions = await listDecisions(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      capabilityKey,
      outcome,
      limit: 200,
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
        headers: { "content-type": "text/csv; charset=utf-8" },
      });
    }
    return NextResponse.json({ decisions });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}

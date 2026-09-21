import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import { listFlags, runAnomalyScan } from "@openbooks/engine/src/hrm/ai/anomalies.ts";
import { aiRailsErrorResponse, requireAnyPerm } from "../../../../lib/ai-rails";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";

export const runtime = "nodejs";

const scanBody = z.object({
  action: z.enum(["scan", "compute_baselines"]).default("scan"),
  periodFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  periodTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  timeOnly: z.boolean().optional(),
  windowPeriods: z.number().int().min(2).max(24).optional(),
});

/**
 * Payroll anomaly flags. GET lists with severity/kind/status filters;
 * POST scans a period (payroll manager only — the scan writes flags).
 * Block severity refuses the pay-run finalize while open; warn never
 * blocks. The client checks res.ok before parsing.
 */
export async function GET(req: Request) {
  const gate = await requireAnyPerm(["payroll.manage", "time.approve", "hrm.employment.read"]);
  if (gate instanceof NextResponse) return gate;
  if (
    !(await isFeatureEnabled(gate.user.orgId, "hrmPayrollAnomalies")) &&
    !(await isFeatureEnabled(gate.user.orgId, "hrmTimeAnomalies"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const oneOf = (name: string, values: readonly string[]): string | undefined => {
    const value = url.searchParams.get(name);
    return value !== null && (values as readonly string[]).includes(value) ? value : undefined;
  };
  try {
    const { db } = await import("@openbooks/engine/src/platform/db.ts");
    const flags = await listFlags(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      periodFrom: url.searchParams.get("periodFrom") ?? undefined,
      periodTo: url.searchParams.get("periodTo") ?? undefined,
      severity: oneOf("severity", ["info", "warn", "block"]),
      kind: url.searchParams.get("kind") ?? undefined,
      status: oneOf("status", ["open", "acknowledged", "resolved", "false_positive"]) ?? "open",
      employmentId: url.searchParams.get("employmentId") ?? undefined,
    });
    return NextResponse.json({ flags });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("payroll.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmPayrollAnomalies"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, scanBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    if (body.action === "compute_baselines") {
      const { computeAnomalyBaselines } = await import("@openbooks/engine/src/hrm/ai/anomalies.ts");
      const result = await computeAnomalyBaselines({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        windowPeriods: body.windowPeriods,
      });
      return NextResponse.json({ baselines: result });
    }
    const summary = await runAnomalyScan({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      periodFrom: body.periodFrom,
      periodTo: body.periodTo,
      options: body.timeOnly === true ? { timeOnly: true } : undefined,
    });
    return NextResponse.json({ summary });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}

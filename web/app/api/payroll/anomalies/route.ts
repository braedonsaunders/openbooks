import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { listFlags, runAnomalyScan } from "@openbooks/engine/hrm/ai/anomalies";
import { aiRailsErrorResponse } from "../../../../lib/ai-rails";
import { can, getAuthz } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { notFound } from "@/lib/api/responses";
import { isCivilDate } from "@openbooks/engine/hrm/temporal";

export const runtime = "nodejs";

const scanBody = z
  .object({
    action: z.enum(["scan", "compute_baselines"]).default("scan"),
    periodFrom: z
      .string()
      .refine(isCivilDate, "must be a valid calendar date in YYYY-MM-DD format")
      .optional(),
    periodTo: z
      .string()
      .refine(isCivilDate, "must be a valid calendar date in YYYY-MM-DD format")
      .optional(),
    timeOnly: z.boolean().optional(),
    windowPeriods: z.number().int().min(2).max(24).optional(),
  })
  .superRefine((body, context) => {
    if (body.action !== "scan") return;
    if (body.periodFrom === undefined) {
      context.addIssue({ code: "custom", path: ["periodFrom"], message: "required for a scan" });
    }
    if (body.periodTo === undefined) {
      context.addIssue({ code: "custom", path: ["periodTo"], message: "required for a scan" });
    }
    if (
      body.periodFrom !== undefined &&
      body.periodTo !== undefined &&
      body.periodTo < body.periodFrom
    ) {
      context.addIssue({
        code: "custom",
        path: ["periodTo"],
        message: "must be on or after periodFrom",
      });
    }
  });

/**
 * Payroll anomaly flags. GET lists with severity/kind/status filters;
 * POST scans a period (payroll manager only — the scan writes flags).
 * Block severity refuses the pay-run finalize while open; warn never
 * blocks. The client checks res.ok before parsing.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request: req, authz: gate }) => {
    if (
      !(["payroll.manage", "time.approve", "hrm.employment.read"] as const).some((permission) =>
        can(gate, permission),
      )
    ) {
      return NextResponse.json(
        { error: "missing permission: one of payroll.manage, time.approve, hrm.employment.read" },
        { status: 403 },
      );
    }
    if (
      !(await isFeatureEnabled(gate.user.orgId, "payroll")) &&
      !(await isFeatureEnabled(gate.user.orgId, "timeTracking"))
    ) {
      return notFound("record");
    }
    const url = new URL(req.url);
    const oneOf = (name: string, values: readonly string[]): string | undefined => {
      const value = url.searchParams.get(name);
      return value !== null && (values as readonly string[]).includes(value) ? value : undefined;
    };
    try {
      const { db } = await import("@openbooks/engine/platform/db");
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
  },
});

export const POST = defineRoute({
  authorize: async ({ request }) => {
    const gate = await getAuthz();
    if (!gate) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    let requestBody: unknown;
    try {
      requestBody = await request.clone().json();
    } catch {
      requestBody = undefined;
    }
    const body =
      typeof requestBody === "object" && requestBody !== null
        ? (requestBody as { action?: unknown; timeOnly?: unknown })
        : undefined;
    const timeOnly =
      (body?.action === undefined || body.action === "scan") && body?.timeOnly === true;
    const payrollManager = can(gate, "payroll.manage");
    const timeApprover = can(gate, "time.approve");
    if (timeOnly ? !(payrollManager || timeApprover) : !payrollManager) {
      return NextResponse.json(
        {
          error: `missing permission: ${timeOnly ? "time.approve or payroll.manage" : "payroll.manage"}`,
        },
        { status: 403 },
      );
    }
    const feature = timeOnly ? "timeTracking" : "payroll";
    if (!(await isFeatureEnabled(gate.user.orgId, feature))) return notFound("route");
    return gate;
  },
  feature: {
    none: "Payroll or time anomaly scans select permissions and feature gates from the validated action.",
  },
  body: scanBody,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body }) => {
    try {
      if (body.action === "compute_baselines") {
        const { computeAnomalyBaselines } = await import("@openbooks/engine/hrm/ai/anomalies");
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
        periodFrom: body.periodFrom!,
        periodTo: body.periodTo!,
        options: body.timeOnly === true ? { timeOnly: true } : undefined,
      });
      return NextResponse.json({ summary });
    } catch (e) {
      return aiRailsErrorResponse(e);
    }
  },
});

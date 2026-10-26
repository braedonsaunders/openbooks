import { apiErrorResponse } from "@/lib/api/error-response";
import { randomUUID } from "node:crypto";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  SampleCompanyError,
  SampleCompanyProvisioningError,
  createSampleCompany,
  sampleCompanyProvisioningBody,
  sampleCompanyStatuses,
  sampleCompanyFeatures,
} from "@openbooks/engine/sample-companies";
import { can, getAuthz } from "@/lib/authz";
import { INDUSTRY_BY_KEY } from "@/lib/industries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sampleCompanyBody = z.object({ industry: z.string().min(1) }).strict();

function canManageSampleCompanies(authz: Parameters<typeof can>[0]): boolean {
  return can(authz, "data.import") || can(authz, "admin.setup.manage");
}

export const GET = defineRoute({
  public: "session",
  handler: async ({ authz }) => {
    if (!canManageSampleCompanies(authz))
      return NextResponse.json({ error: "missing permission: data.import" }, { status: 403 });
    return NextResponse.json({ profiles: await sampleCompanyStatuses(authz.user.homeUserId) });
  },
});

export const POST = defineRoute({
  authorize: async () => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!canManageSampleCompanies(authz)) {
      return NextResponse.json({ error: "missing permission: data.import" }, { status: 403 });
    }
    return authz;
  },
  feature: { none: "Sample companies are governed by organization setup permissions." },
  body: sampleCompanyBody,
  handler: async ({ request: req, authz: gate, body }) => {
    if (!INDUSTRY_BY_KEY.has(body.industry)) {
      return NextResponse.json({ error: "unknown-industry" }, { status: 422 });
    }
    try {
      const result = await createSampleCompany({
        industryKey: body.industry,
        memberUserId: gate.user.homeUserId,
        sourceOrgId: gate.user.orgId,
        memberName: gate.user.name,
        features: sampleCompanyFeatures(body.industry),
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      // A staged provisioning failure is a named, actionable refusal —
      // the fixed per-stage code and message reach the operator while the full
      // cause stays in the server log. Anything else keeps the previous shape:
      // known validation refusals stay 409, unknown failures stay a generic
      // 500 with no internal detail in the body.
      if (error instanceof SampleCompanyProvisioningError) {
        const requestId = randomUUID();
        console.error("[sample-company] provisioning failed", {
          requestId,
          stage: error.stage,
          error: error.cause ?? error,
        });
        return NextResponse.json(
          { ...sampleCompanyProvisioningBody(error), requestId },
          { status: 500, headers: { "x-request-id": requestId } },
        );
      }
      if (error instanceof SampleCompanyError) {
        return apiErrorResponse(error, { safeStatus: 409 });
      }
      console.error("[sample-company] provisioning failed", error);
      return apiErrorResponse(error, { request: req });
    }
  },
});

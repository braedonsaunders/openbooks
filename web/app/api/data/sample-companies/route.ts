import { apiErrorResponse } from "@/lib/api/error-response";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  SampleCompanyError,
  assertSampleRequestAccess,
  readySampleCompany,
  sampleCompanyStatuses,
} from "@openbooks/engine/sample-companies";
import {
  getWorkerHeartbeat,
  readSampleCompanyJob,
  startSampleCompanyJob,
  type SampleCompanyJobStatus,
} from "@openbooks/jobs";
import { can, getAuthz } from "@/lib/authz";
import { INDUSTRY_BY_KEY } from "@/lib/industries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sampleCompanyBody = z.object({ industry: z.string().min(1) }).strict();
const statusQuery = z.object({ industry: z.string().min(1).optional() }).strict();

function canManageSampleCompanies(authz: Parameters<typeof can>[0]): boolean {
  return can(authz, "data.import") || can(authz, "admin.setup.manage");
}

/**
 * The provisioning run as the reader sees it. A completed run is not
 * repeated here: readiness is read from the company itself, so a finished
 * run without a ready company is reported as no run.
 */
function visibleRun(status: SampleCompanyJobStatus | null): SampleCompanyJobStatus | null {
  return status && status.state !== "completed" ? status : null;
}

/**
 * A run's status is read from the job queue. When the queue cannot be read,
 * the company facts still answer from the database and the run is reported
 * as unknown (`null`) rather than failing the whole read.
 */
async function runStatus(memberUserId: string, industryKey: string) {
  try {
    return visibleRun(await readSampleCompanyJob(memberUserId, industryKey));
  } catch (error) {
    console.error("[sample-company] provisioning status could not be read", error);
    return null;
  }
}

export const GET = defineRoute({
  public: "session",
  handler: async ({ request, authz }) => {
    if (!canManageSampleCompanies(authz))
      return NextResponse.json({ error: "missing permission: data.import" }, { status: 403 });
    const query = statusQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return NextResponse.json({ error: "invalid-query" }, { status: 400 });
    const memberUserId = authz.user.homeUserId;
    const industry = query.data.industry;
    if (industry !== undefined) {
      // One industry's readiness and run progress, cheap enough to poll.
      if (!INDUSTRY_BY_KEY.has(industry))
        return NextResponse.json({ error: "unknown-industry" }, { status: 422 });
      const ready = await readySampleCompany(memberUserId, industry);
      return NextResponse.json(
        {
          industryKey: industry,
          existingOrgId: ready?.id ?? null,
          provisioning: ready ? null : await runStatus(memberUserId, industry),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const profiles = await sampleCompanyStatuses(memberUserId);
    return NextResponse.json({
      profiles: await Promise.all(
        profiles.map(async (profile) => ({
          ...profile,
          provisioning: profile.existingOrgId
            ? null
            : await runStatus(memberUserId, profile.industryKey),
        })),
      ),
    });
  },
});

/**
 * Start preparing a sample company. Preparation runs in the background
 * worker and takes minutes, so this answers at once: 200 with the company
 * when it is already ready, otherwise 202 with the run's status, which the
 * caller polls through GET with `?industry=`. Known refusals (unknown
 * industry, no access to the requesting organization, no worker to run it)
 * are answered before any work is queued.
 */
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
    const request = {
      industryKey: body.industry,
      memberUserId: gate.user.homeUserId,
      sourceOrgId: gate.user.orgId,
      memberName: gate.user.name,
    };
    try {
      await assertSampleRequestAccess(request);
      const ready = await readySampleCompany(request.memberUserId, request.industryKey);
      if (ready) return NextResponse.json({ ok: true, orgId: ready.id, created: false });
    } catch (error) {
      if (error instanceof SampleCompanyError) {
        return apiErrorResponse(error, { safeStatus: 409 });
      }
      return apiErrorResponse(error, { request: req });
    }
    let provisioning: SampleCompanyJobStatus;
    try {
      // A queued run with no live worker would wait without any operator
      // signal, so refuse while nothing is queued instead.
      if (!(await getWorkerHeartbeat())) {
        return NextResponse.json({ error: "sample-company-worker-unavailable" }, { status: 503 });
      }
      provisioning = await startSampleCompanyJob(request);
    } catch (error) {
      console.error("[sample-company] provisioning could not be queued", error);
      return NextResponse.json({ error: "sample-company-queue-unavailable" }, { status: 503 });
    }
    if (provisioning.state === "completed" && provisioning.orgId) {
      return NextResponse.json({ ok: true, orgId: provisioning.orgId, created: false });
    }
    return NextResponse.json(
      { ok: true, provisioning },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  },
});

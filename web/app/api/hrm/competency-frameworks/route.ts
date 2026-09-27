import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  createFramework,
  getFramework,
  listFrameworks,
  setFrameworkActive,
} from "@openbooks/engine/src/hrm/performance/competencies.ts";

import { isFeatureEnabled } from "../../../../lib/features";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { createFrameworkBody, patchFrameworkBody } from "./bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance"))
  );
}

/**
 * Competency frameworks (Setup-owned vocabulary). GET lists with
 * competencies and levels, POST creates, PATCH deactivates (history is
 * preserved, never deleted). The client checks res.ok before parsing.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request: req, authz: authz }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }
    const id = new URL(req.url).searchParams.get("id");
    try {
      if (id) {
        const framework = await getFramework({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          id,
        });
        if (!framework)
          return NextResponse.json(
            { error: "competency framework was not found" },
            { status: 404 },
          );
        return NextResponse.json({ framework });
      }
      const frameworks = await listFrameworks({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
      });
      return NextResponse.json({ frameworks });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  public: "session",
  body: createFrameworkBody,
  handler: async ({ authz: authz, body: body }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }

    try {
      const framework = await createFramework({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        name: body.name,
        appliesTo: body.appliesTo ?? null,
      });
      return NextResponse.json({ framework }, { status: 201 });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const PATCH = defineRoute({
  public: "session",
  body: patchFrameworkBody,
  handler: async ({ request: req, authz: authz, body: body }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }
    const id = new URL(req.url).searchParams.get("id");
    if (!id)
      return NextResponse.json({ error: "id is required" }, { status: 400 });

    try {
      await setFrameworkActive({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        id,
        isActive: body.isActive,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import {
  approveEntry,
  computeForWeek,
  computeTravelForWeek,
  createPolicy,
  listEntries,
  listPolicies,
  voidEntry,
} from "@openbooks/engine/hrm/construction/per-diem";
import { constructionErrorResponse } from "../_lib";
import { computeWeekBody, createPerDiemPolicyBody, entryActionBody } from "../bodies";
/** Per-diem policies: org-declared computation rules per basis. */
export const GET = defineRoute({
  permission: "hrm.construction.read",
  feature: "hrmConstructionCompliance",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    try {
      if (url.searchParams.get("entries") === "1") {
        const entries = await listEntries(
          db,
          gate.user.orgId,
          gate.user.id,
          url.searchParams.get("status"),
        );
        return NextResponse.json({ entries });
      }
      const policies = await listPolicies(db, gate.user.orgId, gate.user.id);
      return NextResponse.json({ policies });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.construction.manage",
  feature: "hrmConstructionCompliance",
  body: ({ request }) => {
    const action = new URL(request.url).searchParams.get("action");
    return action === "compute"
      ? computeWeekBody
      : action === "entry"
        ? entryActionBody
        : createPerDiemPolicyBody;
  },
  handler: async ({ request: req, authz: gate, body }) => {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    if (action === "compute") {
      const parsedBody = body as z.output<typeof computeWeekBody>;
      try {
        const entries =
          parsedBody.kind === "travel"
            ? await computeTravelForWeek(db, {
                orgId: gate.user.orgId,
                actorId: gate.user.id,
                employmentId: parsedBody.employmentId,
                weekStart: parsedBody.weekStart,
                mode: parsedBody.travelMode ?? "hourly",
              })
            : await computeForWeek(db, {
                orgId: gate.user.orgId,
                actorId: gate.user.id,
                employmentId: parsedBody.employmentId,
                weekStart: parsedBody.weekStart,
              });
        return NextResponse.json({ entries }, { status: 201 });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    if (action === "entry") {
      const parsedBody = body as z.output<typeof entryActionBody>;
      try {
        const entry =
          parsedBody.action === "approve"
            ? await approveEntry(db, {
                orgId: gate.user.orgId,
                actorId: gate.user.id,
                entryId: parsedBody.entryId,
                kind: parsedBody.kind,
              })
            : await voidEntry(db, {
                orgId: gate.user.orgId,
                actorId: gate.user.id,
                entryId: parsedBody.entryId,
                kind: parsedBody.kind,
                reason: parsedBody.reason ?? "voided from the Compliance page",
              });
        return NextResponse.json({ entry });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    const parsedBody = body as z.output<typeof createPerDiemPolicyBody>;
    try {
      const policy = await createPolicy(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...parsedBody,
      });
      return NextResponse.json({ policy }, { status: 201 });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});

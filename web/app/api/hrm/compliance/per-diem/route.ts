import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  approveEntry,
  computeForWeek,
  computeTravelForWeek,
  createPolicy,
  listEntries,
  listPolicies,
  voidEntry,
} from "@openbooks/engine/src/hrm/construction/per-diem.ts";
import { constructionErrorResponse } from "../_lib";
import {
  computeWeekBody,
  createPerDiemPolicyBody,
  entryActionBody,
} from "../bodies";
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
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    if (action === "compute") {
      const parsedBody = await parseJsonBody(req, computeWeekBody);
      if (!parsedBody.ok) return parsedBody.response;
      try {
        const entries =
          parsedBody.data.kind === "travel"
            ? await computeTravelForWeek(db, {
                orgId: gate.user.orgId,
                actorId: gate.user.id,
                employmentId: parsedBody.data.employmentId,
                weekStart: parsedBody.data.weekStart,
                mode: parsedBody.data.travelMode ?? "hourly",
              })
            : await computeForWeek(db, {
                orgId: gate.user.orgId,
                actorId: gate.user.id,
                employmentId: parsedBody.data.employmentId,
                weekStart: parsedBody.data.weekStart,
              });
        return NextResponse.json({ entries }, { status: 201 });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    if (action === "entry") {
      const parsedBody = await parseJsonBody(req, entryActionBody);
      if (!parsedBody.ok) return parsedBody.response;
      try {
        const entry =
          parsedBody.data.action === "approve"
            ? await approveEntry(db, {
                orgId: gate.user.orgId,
                actorId: gate.user.id,
                entryId: parsedBody.data.entryId,
                kind: parsedBody.data.kind,
              })
            : await voidEntry(db, {
                orgId: gate.user.orgId,
                actorId: gate.user.id,
                entryId: parsedBody.data.entryId,
                kind: parsedBody.data.kind,
                reason:
                  parsedBody.data.reason ?? "voided from the Compliance page",
              });
        return NextResponse.json({ entry });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    const parsedBody = await parseJsonBody(req, createPerDiemPolicyBody);
    if (!parsedBody.ok) return parsedBody.response;
    try {
      const policy = await createPolicy(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...parsedBody.data,
      });
      return NextResponse.json({ policy }, { status: 201 });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});

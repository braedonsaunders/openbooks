import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  electEnrollment,
  waiveEnrollment,
} from "@openbooks/engine/src/hrm/benefits/enrollments.ts";
import {
  listEnrollments,
  myEnrollments,
} from "@openbooks/engine/src/hrm/benefits/benefits-read.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { benefitsErrorResponse } from "../benefits/_lib";
import { enrollmentPostBody } from "./bodies";

export const runtime = "nodejs";

const ENROLLMENT_STATUSES = ["elected", "waived", "pending_approval", "active", "ended", "cancelled"];

/**
 * Enrollments: GET lists (one employment, one window, or the caller's own
 * when employmentId is "mine"), POST elects or waives. Self-service elects
 * only against the caller's own employment — the engine scopes the
 * subject, and "mine" never accepts a caller-supplied worker. Amounts are
 * never caller-supplied: the service copies them from the plan basis.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.benefits.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const employmentId = url.searchParams.get("employmentId");
  const windowId = url.searchParams.get("windowId");
  const status = url.searchParams.get("status");
  if (status !== null && !ENROLLMENT_STATUSES.includes(status)) {
    return NextResponse.json({ error: "unknown status" }, { status: 400 });
  }
  if (windowId !== null && !isUuid(windowId)) {
    return NextResponse.json({ error: "window id must be a uuid" }, { status: 400 });
  }
  try {
    if (employmentId === "mine" || employmentId === null) {
      if (status !== null || windowId !== null) {
        return NextResponse.json(
          { error: "status and window filtering on the self-service inbox is not supported" },
          { status: 400 },
        );
      }
      const enrollments = await myEnrollments(db, gate.user.orgId, gate.user.id);
      return NextResponse.json({ enrollments });
    }
    if (!isUuid(employmentId)) return NextResponse.json({ error: "employment id must be a uuid" }, { status: 400 });
    const enrollments = await listEnrollments(db, gate.user.orgId, gate.user.id, {
      employmentId,
      ...(windowId ? { windowId } : {}),
      ...(status ? { status } : {}),
    });
    return NextResponse.json({ enrollments });
  } catch (e) {
    return benefitsErrorResponse(e);
  }
}

export async function POST(req: Request) {
  // The body decides the grant: self-service elects with the read grant,
  // on-behalf filing needs hrm.benefits.manage (enforced again inside the
  // engine per employment). Parsing first is safe — nothing is written
  // before the gate below.
  const parsedBody = await parseJsonBody(req, enrollmentPostBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const gate = await guardPermission(body.selfService ? "hrm.benefits.read" : "hrm.benefits.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    if (body.action === "waive") {
      const enrollment = await waiveEnrollment({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        employmentId: body.employmentId,
        planId: body.planId,
        windowId: body.windowId ?? null,
        effectiveFrom: body.effectiveFrom,
        reason: body.reason,
        selfService: body.selfService ?? false,
      });
      return NextResponse.json({ enrollment });
    }
    const enrollment = await electEnrollment({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId: body.employmentId,
      planId: body.planId,
      windowId: body.windowId ?? null,
      coverageLevelKey: body.coverageLevelKey ?? null,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo ?? null,
      lifeEventReason: body.lifeEventReason ?? null,
      selfService: body.selfService ?? false,
    });
    return NextResponse.json({ enrollment });
  } catch (e) {
    return benefitsErrorResponse(e);
  }
}

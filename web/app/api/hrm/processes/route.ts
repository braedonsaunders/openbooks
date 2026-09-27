import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  listProcesses,
  type ProcessSegment,
} from "@openbooks/engine/src/hrm/processes-read.ts";
import { openProcess } from "@openbooks/engine/src/hrm/processes.ts";

import { isUuid } from "../../../../lib/list-params";
import { processErrorResponse } from "./_lib";
import { openProcessBody } from "./bodies";

export const runtime = "nodejs";

const SEGMENTS = ["open", "overdue", "completed", "cancelled"] as const;

/**
 * Process checklists collection. GET lists this org's processes behind the
 * HRM feature switch and the process read grant (subsidiary scope applied
 * per row in the service); POST opens a checklist for an employment
 * (process manage gate in the service, with its no-live-version and
 * duplicate-open refusals intact).
 */
export const GET = defineRoute({
  permission: "hrm.process.read",
  feature: "hrm",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const segment = url.searchParams.get("segment") ?? "open";
    if (!(SEGMENTS as readonly string[]).includes(segment)) {
      return NextResponse.json(
        { error: "segment must be one of open, overdue, completed, cancelled" },
        { status: 400 },
      );
    }
    const employmentId = url.searchParams.get("employment");
    if (employmentId !== null && !isUuid(employmentId)) {
      return NextResponse.json(
        { error: "employment must be a uuid" },
        { status: 400 },
      );
    }
    try {
      const processes = await listProcesses({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        segment: segment as ProcessSegment,
      });
      return NextResponse.json({
        processes:
          employmentId === null
            ? processes
            : processes.filter((p) => p.employmentId === employmentId),
      });
    } catch (e) {
      return processErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.process.manage",
  feature: "hrm",
  body: openProcessBody,
  handler: async ({ authz: gate, body: body }) => {
    try {
      const process = await openProcess({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        employmentId: body.employmentId,
        kind: body.kind,
        effectiveDate: body.effectiveDate,
        ...(body.templateId === undefined
          ? {}
          : { templateId: body.templateId }),
      });
      return NextResponse.json({ process }, { status: 201 });
    } catch (e) {
      return processErrorResponse(e);
    }
  },
});

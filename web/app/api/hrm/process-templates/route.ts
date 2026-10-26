import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createProcessTemplate,
  listProcessTemplates,
  type ProcessKind,
} from "@openbooks/engine/hrm/processes/operations";
import { isUuid } from "@/lib/list-params";
import { processErrorResponse } from "../processes/_lib";
import { createProcessTemplateBody } from "./bodies";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "hrm.process.manage",
  feature: "hrm",
  handler: async ({ request: req, authz }) => {
    const url = new URL(req.url);
    const kind = url.searchParams.get("kind");
    if (kind !== null && kind !== "onboarding" && kind !== "offboarding" && kind !== "transfer") {
      return NextResponse.json(
        { error: "kind must be onboarding, offboarding, or transfer" },
        { status: 400 },
      );
    }
    const employmentId = url.searchParams.get("employment");
    const effectiveDate = url.searchParams.get("effectiveDate");
    if (employmentId !== null && !isUuid(employmentId)) {
      return NextResponse.json({ error: "employment must be a uuid" }, { status: 400 });
    }
    if ((employmentId === null) !== (effectiveDate === null)) {
      return NextResponse.json(
        { error: "employment and effectiveDate must be supplied together" },
        { status: 400 },
      );
    }
    try {
      const templates = await listProcessTemplates({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        activeOnly: url.searchParams.get("active") === "true",
        ...(kind === null ? {} : { kind: kind as ProcessKind }),
        ...(employmentId === null ? {} : { employmentId, effectiveDate: effectiveDate! }),
      });
      return NextResponse.json({ templates });
    } catch (error) {
      return processErrorResponse(error);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.process.manage",
  feature: "hrm",
  body: createProcessTemplateBody,
  handler: async ({ authz, body: body }) => {
    try {
      const template = await createProcessTemplate({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        ...body,
      });
      return NextResponse.json({ template }, { status: 201 });
    } catch (error) {
      return processErrorResponse(error);
    }
  },
});

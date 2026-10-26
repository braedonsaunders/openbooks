import { z } from "zod";
import { NextResponse } from "next/server";
import { loadApprovalRequestDetail } from "@openbooks/engine/flows";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { canReadSubjectRecord } from "@/lib/flow-subject-authz";
import { requireFlowsRecordReader } from "../../../_lib";
export type { ApprovalRequestDetail } from "@openbooks/engine/flows";

export const runtime = "nodejs";

export const GET = defineRoute({
  public: "session",
  params: z.strictObject({ subjectKind: z.string().min(1).max(100), id: uuidString() }),
  handler: async ({ params }) => {
    const session = await requireFlowsRecordReader();
    if (session instanceof NextResponse) return session;
    const { authz } = session;
    if (!(await canReadSubjectRecord(authz, params.subjectKind, params.id)))
      return notFound("record");
    const detail = await loadApprovalRequestDetail({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      subjectKind: params.subjectKind,
      subjectId: params.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    return detail ? Response.json(detail) : notFound("record");
  },
});

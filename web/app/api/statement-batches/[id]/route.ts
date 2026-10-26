import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getStatementBatchRun,
  listStatementBatchItems,
} from "@openbooks/engine/receivables/statement-batches";
import { can } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * Batch run detail: the audited run (who, when, period, filters,
 * recipient count) with every per-customer item — queued, sent, failed
 * with its delivery error, or skipped for no email. Each send also stands
 * on the customer's email history like a single send, through the same
 * statement email log.
 */
export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = params;
    if (!can(gate, "ar.read"))
      return NextResponse.json({ error: "missing permission: ar.read" }, { status: 403 });
    if (!isUuid(id)) return notFound("record");
    const run = await getStatementBatchRun(gate.user.orgId, id, gate.allowedSubsidiaryIds);
    if (!run) return notFound("record");
    const items = await listStatementBatchItems(gate.user.orgId, id, gate.allowedSubsidiaryIds);
    const counts = {
      queued: items.filter((item) => item.status === "queued" || item.status === "sending").length,
      sent: items.filter((item) => item.status === "sent").length,
      failed: items.filter((item) => item.status === "failed").length,
      skipped: items.filter((item) => item.status === "skipped").length,
    };
    return NextResponse.json({
      run: {
        id: run.id,
        periodFrom: run.periodFrom,
        periodTo: run.periodTo,
        filters: run.filters,
        recipientCount: run.recipientCount,
        status: run.status,
        createdAt: run.createdAt,
        createdBy: run.createdBy,
        counts,
      },
      items: items.map((item) => ({
        partyId: item.partyId,
        partyName: item.partyName,
        toEmail: item.toEmail,
        balance: item.balance,
        overdue: item.overdue,
        currency: item.currency,
        status: item.status,
        error: item.error,
        sentAt: item.sentAt,
      })),
    });
  },
});

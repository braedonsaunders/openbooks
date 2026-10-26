import { emailDeliveryBlockedMessage } from "@openbooks/emails";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { enqueueStatementBatchJobs } from "@openbooks/jobs";
import { resolveOrgEmailTransportDetailed } from "@openbooks/engine/delivery/email-config/module";
import {
  createStatementBatchRun,
  listStatementBatchRuns,
} from "@openbooks/engine/receivables/statement-batches";
import { ReportCurrencyBasisError } from "@/lib/reports/currency-basis";
import { buildStatementBatchPreview } from "@/lib/statement-batch";
import { can, getAuthz, type Authz } from "@/lib/authz";

export const runtime = "nodejs";

/**
 * Batched customer statements: preview the recipients (GET) or create a
 * run and enqueue one job per customer (POST). Creating needs the
 * statement send grant plus the read pair its preview renders through;
 * the run is scoped to the creator's subsidiaries, and an org without
 * outbound email configured is refused up front with the setup remedy —
 * no run is recorded and nothing is enqueued.
 */

const batchBody = z
  .object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    toDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    overdueOnly: z.boolean().optional(),
    subsidiaryId: uuidString().nullable().optional(),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .nullable()
      .optional(),
  })
  .strict();

function sendGrants(gate: Authz): NextResponse | null {
  if (!can(gate, "ar.create"))
    return NextResponse.json({ error: "missing permission: ar.create" }, { status: 403 });
  if (!can(gate, "ar.read"))
    return NextResponse.json({ error: "missing permission: ar.read" }, { status: 403 });
  if (!can(gate, "reports.read")) {
    return NextResponse.json({ error: "missing permission: reports.read" }, { status: 403 });
  }
  return null;
}

/** GET — audited run history, newest first. */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request: req, authz: gate }) => {
    if (!can(gate, "ar.read"))
      return NextResponse.json({ error: "missing permission: ar.read" }, { status: 403 });
    const params = new URL(req.url).searchParams;
    const limit = Math.min(Math.max(Number(params.get("limit") || 25), 1), 100);
    const runs = await listStatementBatchRuns(gate.user.orgId, {
      limit,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return NextResponse.json({ runs });
  },
});

/** POST — create a run from the current preview and enqueue one job per customer. */
export const POST = defineRoute({
  authorize: async () => {
    const gate = await getAuthz();
    if (!gate) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return sendGrants(gate) ?? gate;
  },
  feature: {
    none: "Statement batches are governed by receivables, reporting, and email configuration.",
  },
  body: batchBody,
  opaque: {
    from: "Statement filters are optional; omission preserves the route's existing default period.",
    toDate:
      "Statement filters are optional; omission preserves the route's existing default period.",
    overdueOnly:
      "Statement filters are optional; omission preserves the route's existing recipient selection.",
    subsidiaryId:
      "Statement filters are optional; omission preserves the caller's existing subsidiary scope.",
    currency:
      "Statement filters are optional; omission preserves the route's existing currency selection.",
  },
  handler: async ({ authz: gate, body }) => {
    const delivery = await resolveOrgEmailTransportDetailed(gate.user.orgId);
    if (delivery.state !== "ready") {
      return NextResponse.json({ error: emailDeliveryBlockedMessage(delivery) }, { status: 422 });
    }
    let preview;
    try {
      preview = await buildStatementBatchPreview(
        gate.user.orgId,
        gate.allowedSubsidiaryIds,
        can(gate, "payroll.read"),
        {
          from: body.from ?? null,
          to: body.toDate ?? null,
          overdueOnly: body.overdueOnly,
          subsidiaryId: body.subsidiaryId ?? null,
          currency: body.currency ?? null,
        },
      );
    } catch (e) {
      // The basis refusal carries a fixed message but no status: it answers
      // 422 here. Period refusals are already typed 400 at their origin; the
      // shared mapping carries both, and logs anything unexpected.
      if (e instanceof ReportCurrencyBasisError) return apiErrorResponse(e, { safeStatus: 422 });
      return apiErrorResponse(e);
    }
    if (preview.recipients.length === 0) {
      return NextResponse.json(
        { error: "statement batch has no recipients — adjust the period or filters" },
        { status: 422 },
      );
    }
    try {
      const run = await createStatementBatchRun({
        orgId: gate.user.orgId,
        senderId: gate.user.id,
        periodFrom: preview.from,
        periodTo: preview.to,
        filters: {
          ...(body.overdueOnly ? { overdueOnly: true } : {}),
          ...(body.subsidiaryId ? { subsidiaryId: body.subsidiaryId } : {}),
          ...(body.currency ? { currency: body.currency.toUpperCase() } : {}),
        },
        recipients: preview.recipients.map((recipient) => ({
          partyId: recipient.partyId,
          balance: recipient.balance,
          overdue: recipient.overdue,
          currency: recipient.currency,
          toEmail: recipient.toEmail,
        })),
        excluded: preview.excluded.map((exclusion) => ({
          partyId: exclusion.partyId,
          balance: exclusion.balance,
          overdue: exclusion.overdue,
        })),
        allowedSubsidiaryIds:
          gate.allowedSubsidiaryIds === null ? null : [...gate.allowedSubsidiaryIds].sort(),
        enqueue: (jobs) => enqueueStatementBatchJobs(jobs),
      });
      return NextResponse.json({
        ok: true,
        runId: run.runId,
        queued: run.queued,
        skipped: run.skipped,
      });
    } catch (e) {
      // Filing refusals are typed 422 at their origin with identifier-free
      // messages; the shared mapping carries them and logs the rest.
      return apiErrorResponse(e);
    }
  },
});

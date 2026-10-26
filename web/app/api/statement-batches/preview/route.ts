import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { ReportCurrencyBasisError } from "../../../../lib/reports/currency-basis";
import {
  buildStatementBatchPreview,
  type StatementBatchPreviewQuery,
} from "../../../../lib/statement-batch";
import { can } from "../../../../lib/authz";

export const runtime = "nodejs";

/**
 * Batch statement preview: the customers a batch run would send to for the
 * requested period and filters — one row per customer with its balance,
 * overdue figure, and resolved statement mailbox, plus the no-email
 * exclusions with a link to fix them. Reading balances runs the report
 * engine, so this needs the same read pair as the statements picker.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request: req, authz: gate }) => {
    if (!can(gate, "ar.read"))
      return NextResponse.json({ error: "missing permission: ar.read" }, { status: 403 });
    if (!can(gate, "reports.read")) {
      return NextResponse.json({ error: "missing permission: reports.read" }, { status: 403 });
    }
    const params = new URL(req.url).searchParams;
    const query: StatementBatchPreviewQuery = {
      from: params.get("from"),
      to: params.get("to"),
      overdueOnly: params.get("overdueOnly") === "1" || params.get("overdueOnly") === "true",
      subsidiaryId: params.get("sub"),
      currency: params.get("currency"),
    };
    try {
      const preview = await buildStatementBatchPreview(
        gate.user.orgId,
        gate.allowedSubsidiaryIds,
        can(gate, "payroll.read"),
        query,
      );
      return NextResponse.json(preview);
    } catch (e) {
      // The basis refusal carries a fixed message but no status: it answers
      // 422 here. Period refusals are already typed 400 at their origin; the
      // shared mapping carries both, and logs anything unexpected.
      if (e instanceof ReportCurrencyBasisError) return apiErrorResponse(e, { safeStatus: 422 });
      return apiErrorResponse(e);
    }
  },
});

import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { withOrg } from "@openbooks/engine/platform/db";
import { parseReportQuery } from "../../../../../lib/report-filters";
import { resolvePeriod } from "../../../../../lib/periods";
import { resolveReport, type ReportKind } from "../../../../../lib/report-run";
import {
  exportDataToPdf,
  orgBranding,
  resolveLayout,
  type Translator,
} from "../../../../../lib/report-pdf";
import {
  statementBatchReportAuthz,
  withReportAuthz,
} from "../../../../../lib/report-execution-context";
import { apiErrorResponse } from "../../../../../lib/api/error-response";
import { internalTokenMatches, parseInternalOrgId } from "../../../../../lib/internal-token";
import { safeName } from "../../../../../lib/export";
import { isUuid } from "../../../../../lib/list-params";
import {
  readStatementBatchItemEmail,
  readStatementBatchRunForRender,
  readStatementParty,
} from "../../../../../lib/statement-batch";

export const runtime = "nodejs";

/**
 * Internal batched-statement render — the statement-batch worker calls this
 * once per customer (rendering lives in web/lib; the worker can't import
 * it). Authenticated by the shared internal token and authorized against
 * the batch run's durable principal: the creator must still hold the send
 * grants, and the customer must still sit inside their pinned subsidiary
 * scope. Renders the same partner-statement PDF the single send emails.
 *
 *   GET /api/internal/statements/render?orgId=&runId=&partyId=
 */
export async function GET(req: Request) {
  if (
    !internalTokenMatches(req.headers.get("x-internal-token"), process.env.OPENBOOKS_INTERNAL_TOKEN)
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const p = new URL(req.url).searchParams;
  const orgId = parseInternalOrgId(p.get("orgId"));
  const runId = p.get("runId")?.trim() ?? "";
  const partyId = p.get("partyId")?.trim() ?? "";
  if (!orgId || !isUuid(runId) || !isUuid(partyId)) {
    return NextResponse.json({ error: "orgId, runId, and partyId are required" }, { status: 422 });
  }

  try {
    return await withOrg(orgId, async () => {
      const run = await readStatementBatchRunForRender(orgId, runId);
      if (!run)
        return NextResponse.json(
          { error: "statement batch run was not found — re-create the run" },
          { status: 404 },
        );
      const snapshot = run.authorization_snapshot ?? {};
      if (snapshot.version !== 1 || !snapshot.userId) {
        return NextResponse.json(
          { error: "statement batch run requires reauthorization — create a new batch run" },
          { status: 403 },
        );
      }
      const item = await readStatementBatchItemEmail(orgId, runId, partyId);
      if (!item)
        return NextResponse.json(
          { error: "customer is not part of this batch run" },
          { status: 404 },
        );
      if (!item.to_email?.trim()) {
        return NextResponse.json(
          { error: "customer has no statement email — add an email address to the party first" },
          { status: 422 },
        );
      }
      const party = await readStatementParty(orgId, partyId);
      if (!party)
        return NextResponse.json(
          { error: "customer is not part of this batch run" },
          { status: 404 },
        );
      const allowed = snapshot.allowedSubsidiaryIds ?? null;
      if (
        allowed !== null &&
        party.subsidiary_id !== null &&
        !allowed.includes(party.subsidiary_id)
      ) {
        return NextResponse.json(
          { error: "customer left the sender\u2019s subsidiary scope — create a new batch run" },
          { status: 403 },
        );
      }

      let authz;
      try {
        authz = await statementBatchReportAuthz(orgId, {
          version: 1,
          userId: snapshot.userId,
          allowedSubsidiaryIds: allowed,
        });
      } catch (e) {
        // The revoked-sender refusal is typed 403 at its origin; principal
        // or driver failures answer through the shared mapping instead of
        // echoing internals with a 403.
        return apiErrorResponse(e);
      }

      const t = (await getTranslations("reports")) as unknown as Translator;
      const reportParams = new URLSearchParams({ party: partyId, side: "ar", period: "custom" });
      reportParams.set("from", run.period_from ?? run.period_to);
      reportParams.set("to", run.period_to);
      const query = parseReportQuery(reportParams);
      const period = await resolvePeriod(query.period, {
        customFrom: query.from,
        customTo: query.to,
        orgId,
      });
      const resolved = await withReportAuthz(authz, () =>
        resolveReport("partner-statement" as ReportKind, reportParams, {
          orgId,
          t,
          period,
          query,
        }),
      );
      if (resolved.render !== "data") throw new Error("statement failed");
      const branding = await orgBranding(orgId);
      const { page, showSummary } = resolveLayout(null);
      const stamp = await businessToday(orgId);
      const pdf = await exportDataToPdf(resolved.data, branding, page, {
        showSummary,
        generatedAt: new Date(`${stamp}T00:00:00Z`),
      });
      const attachmentName = `${safeName(`statement-${party.display_name}-${period.to}`)}.pdf`;
      const headers = new Headers({
        "content-type": "application/pdf",
        "cache-control": "no-store",
        "x-statement-filename": encodeURIComponent(attachmentName),
        "x-statement-org": encodeURIComponent(branding.orgName || "OpenBooks"),
        "x-statement-reference": encodeURIComponent(`as of ${period.to}`),
      });
      return new NextResponse(new Uint8Array(pdf), { status: 200, headers });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "render failed";
    if (message.endsWith("feature is disabled")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

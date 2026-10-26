import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { notFound } from "@/lib/api/responses";
import { db } from "@openbooks/engine/platform/db";
import { isIso4217CurrencyCode } from "@openbooks/engine/fx/currencies";
import { isIsoCalendarDate } from "@openbooks/engine/platform/iso-date";
import { resolveDraftSubsidiary } from "@openbooks/engine/organization/scope";
import { currencyMinorUnits } from "@openbooks/engine/payables/expense-line-currency";
import {
  ExpenseFxRefusal,
  expenseFxPolicy,
  quoteExpenseFxRate,
} from "@openbooks/engine/payables/expense-line-currency-service";
import { expenseReportCurrency, loadExpenseReport } from "../../../../lib/expenses";
import { authorizeExpenses, expenseAccess } from "../../../../lib/expense-access";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

const query = z.object({
  currency: z.string().refine(isIso4217CurrencyCode, "Choose an ISO 4217 currency"),
  date: z.string().refine(isIsoCalendarDate, "Enter the expense date as YYYY-MM-DD"),
  reportId: z.string().refine(isUuid).optional(),
});

/**
 * The dated exchange rate a foreign-currency expense line would convert at,
 * for the drawer's preview: the report's entity rate type on the expense
 * date, and whether the expense FX policy then allows an explicit rate. A
 * missing or stale rate is answered as the refusal the save would meet, with
 * its remedy. The save converts again authoritatively.
 */
export const GET = defineRoute({
  authorize: authorizeExpenses("edit"),
  feature: "expenses",
  handler: async ({ request, authz: gate }) => {
    const url = new URL(request.url);
    const parsed = query.safeParse({
      currency: url.searchParams.get("currency") ?? "",
      date: url.searchParams.get("date") ?? "",
      reportId: url.searchParams.get("reportId") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: parsed.error.issues[0]?.message ?? "Choose a currency and expense date",
          code: "invalid_query",
        },
        { status: 400 },
      );
    }
    const { currency, date, reportId } = parsed.data;
    const access = await expenseAccess(gate, "edit");
    if (!access) return notFound("record");
    let reportCurrency: string;
    let subsidiaryId: string | null;
    if (reportId) {
      const report = await loadExpenseReport(
        reportId,
        gate.user.orgId,
        gate.allowedSubsidiaryIds,
        access,
      );
      if (!report) return notFound("record");
      reportCurrency = String(report.doc.currency);
      subsidiaryId = (report.doc.subsidiary_id as string | null) ?? null;
    } else {
      const resolved = resolveDraftSubsidiary(gate.allowedSubsidiaryIds);
      if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 422 });
      subsidiaryId = resolved.subsidiaryId;
      const base = await expenseReportCurrency(gate.user.orgId);
      if (!base) {
        return NextResponse.json(
          {
            error: "The organization has no base currency for its expense reports",
            code: "expense_report_currency_missing",
            remedy:
              "Set the organization base currency under Company Settings before creating expense reports.",
          },
          { status: 422 },
        );
      }
      reportCurrency = base;
    }
    const policy = await expenseFxPolicy(db, gate.user.orgId, date);
    const minorUnits = currencyMinorUnits(reportCurrency);
    if (currency === reportCurrency) {
      return NextResponse.json({
        reportCurrency,
        minorUnits,
        allowRateOverride: policy.allowRateOverride,
        quote: null,
        refusal: null,
      });
    }
    try {
      const quote = await quoteExpenseFxRate(db, {
        orgId: gate.user.orgId,
        subsidiaryId,
        from: currency,
        to: reportCurrency,
        rateDate: date,
      });
      return NextResponse.json({
        reportCurrency,
        minorUnits,
        allowRateOverride: policy.allowRateOverride,
        quote,
        refusal: null,
      });
    } catch (error) {
      if (error instanceof ExpenseFxRefusal) {
        return NextResponse.json({
          reportCurrency,
          minorUnits,
          allowRateOverride: policy.allowRateOverride,
          quote: null,
          refusal: { error: error.message, code: error.code, remedy: error.remedy },
        });
      }
      return apiErrorResponse(error);
    }
  },
});

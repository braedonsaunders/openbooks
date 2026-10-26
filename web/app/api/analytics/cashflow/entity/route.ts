import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  loadCashflowEntityPartyScope,
  loadCashflowEntityRows,
} from "@openbooks/engine/reports/cashflow-entity";
import { add, mulDecimal, normalizeMoney, sum } from "@openbooks/engine/money/money";
import { guardSubsidiaryScope } from "@/lib/authz";
import { statementBookExpr } from "@/lib/gl-summary";
import { flowRates, presentationCurrency } from "@/lib/fx-presentation";
import { toISO } from "@/lib/cash/core";
import { openItems } from "@/lib/cash/open-items";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/**
 * Cash Flow entity drill for customer and vendor history.
 * For a customer (AR) or vendor (AP): average days-to-pay, total paid over 12
 * months, open balance, a reliability score (0–100), open items and recent
 * payments. Reliability starts at 70, with ±20/±10 adjustments by average-day
 * tiers at 30/45/60,
 * +10 no overdue / −15 if >50% of open items overdue.
 */
export const GET = defineRoute({
  permission: "reports.read",
  feature: { none: "No optional feature applies to this permission-governed endpoint." },
  handler: async ({ request: req, authz: gate }) => {
    const user = gate.user;
    const url = new URL(req.url);
    const party = url.searchParams.get("party");
    const side = url.searchParams.get("side") === "ap" ? "ap" : "ar";
    if (!party) return NextResponse.json({ error: "party required" }, { status: 400 });
    if (!isUuid(party)) return notFound("record");

    // The party is the record boundary.  A null-subsidiary party is an
    // org-wide identity, but every transaction leg below still has to be
    // narrowed to the caller's visible subsidiaries.
    const partyRow = await loadCashflowEntityPartyScope(user.orgId, party);
    if (!partyRow) return notFound("record");
    const scopeDenied = guardSubsidiaryScope(gate, partyRow.subsidiaryId, { orgWideNull: true });
    if (scopeDenied) return scopeDenied;

    const today = await businessToday(user.orgId);
    const [{ payments: legs, recent }, partyOpen] = await Promise.all([
      loadCashflowEntityRows({
        orgId: user.orgId,
        partyId: party,
        side,
        today,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        statementBook: statementBookExpr(user.orgId),
      }),
      openItems(
        user.orgId,
        side,
        today,
        gate.allowedSubsidiaryIds === null ? undefined : [...gate.allowedSubsidiaryIds],
      ).then((items) => items.filter((item) => item.partyId === party)),
    ]);

    // Payment legs aggregate in JS over the grouped rows: distinct source
    // documents count, days average like SQL avg (nulls ignored), and the paid
    // total translates per group — never summed across functional frames raw.
    const paymentCount = new Set(legs.map((l) => String(l.pid))).size;
    const dayValues = legs
      .map((l) => l.days)
      .filter((d): d is string | number => d !== null && d !== undefined)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    const avgDays =
      dayValues.length > 0
        ? Math.round(dayValues.reduce((a, b) => a + b, 0) / dayValues.length)
        : null;

    // Recent amounts AND the paid total translate to presentation at each
    // source date through the one flow context — a USD 100 payment in a CAD
    // org reads CAD 135, never CAD 100, in both the payment list and the
    // 12-month total. Missing coverage refuses 422 by name for either.
    const fxResult = await flowRates(user.orgId, [
      ...recent.map((r) => ({
        func: typeof r.func === "string" ? r.func : null,
        date: String(r.date ?? today).slice(0, 10),
      })),
      ...legs.map((l) => ({
        func: typeof l.func === "string" ? l.func : null,
        date: String(l.date ?? today).slice(0, 10),
      })),
    ]).then(
      (rates) => ({ ok: true as const, rates }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!fxResult.ok) {
      return apiErrorResponse(fxResult.error);
    }
    const fx = fxResult.rates;
    let recentAmounts: string[];
    let totalPaid: string;
    try {
      recentAmounts = recent.map((r) =>
        mulDecimal(
          String(r.func_amount ?? "0"),
          fx.rateAt(
            typeof r.func === "string" ? r.func : null,
            String(r.date ?? today).slice(0, 10),
          ),
        ),
      );
      totalPaid = normalizeMoney(
        legs.reduce(
          (total, l) =>
            add(
              total,
              mulDecimal(
                String(l.paid ?? "0"),
                fx.rateAt(
                  typeof l.func === "string" ? l.func : null,
                  String(l.date ?? today).slice(0, 10),
                ),
              ),
            ),
          "0",
        ),
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
    const currency = fx.base || (await presentationCurrency(user.orgId));
    const rows = partyOpen.map((item) => {
      const due = item.dueDate ? toISO(item.dueDate) : null;
      const overdue = due !== null && due < today;
      return {
        docId: item.docId,
        docKind: item.docKind,
        entryId: item.entryId,
        docNumber: item.docNumber ?? "",
        tranDate: toISO(item.tranDate),
        dueDate: due,
        remaining: item.remaining,
        overdue,
      };
    });
    const openBalance = sum(rows.map((item) => item.remaining));
    const overdueCount = rows.filter((i) => i.overdue).length;
    const overdueRatio = rows.length ? overdueCount / rows.length : 0;

    // Reliability score.
    let reliability = 70;
    if (avgDays !== null) {
      if (avgDays <= 30) reliability += 20;
      else if (avgDays <= 45) reliability += 10;
      else if (avgDays > 60) reliability -= 20;
    }
    if (overdueCount === 0) reliability += 10;
    else if (overdueRatio > 0.5) reliability -= 15;
    reliability = Math.max(0, Math.min(100, reliability));

    return NextResponse.json({
      avgDays,
      totalPaid,
      paymentCount,
      openBalance,
      overdueCount,
      reliability,
      currency,
      openItems: rows,
      recentPayments: recent.map((r, i) => ({
        docId: r.doc_id,
        docKind: r.doc_kind,
        entryId: r.entry_id,
        docNumber: r.document_number ?? "",
        date: r.date,
        amount: normalizeMoney(recentAmounts[i] ?? "0"),
      })),
    });
  },
});

import { NextResponse } from "next/server";
import { guardFeaturePermission } from "../../../../lib/feature-gates";
import { cashPosition } from "../../../../lib/cash/cash-position";
import { normalizeMoneyValue } from "../../../../lib/cash/core";
import { analyticsConfig } from "../../../../lib/analytics/config";

export const runtime = "nodejs";

/**
 * One forecast week's transactions, at full detail.
 *
 * The cockpits deliberately do not ship these with the page: a real ledger has
 * tens of thousands of open items, every one of which lands in some week of the
 * horizon, and a reader opens one week at a time. The week's totals and counts
 * travel with the page so every summary renders immediately; this route
 * supplies the rows behind whichever week is actually opened.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission("reports.read", "banking");
  if (gate instanceof NextResponse) return gate;
  const user = gate.user;

  const url = new URL(req.url);
  const weekStart = url.searchParams.get("week");
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return NextResponse.json({ error: "week must be an ISO date" }, { status: 400 });
  }
  const horizonWeeks = Math.min(Math.max(Number(url.searchParams.get("horizon")) || 13, 1), 52);
  const asOf = url.searchParams.get("asOf") ?? undefined;
  // The cockpit's subsidiary view must be reproduced or the drill would show
  // transactions the page's own totals excluded.
  const subParam = url.searchParams.get("sub");
  const requestedSubIds = subParam ? subParam.split(",").filter(Boolean) : undefined;
  if (gate.allowedSubsidiaryIds) {
    // A restricted caller's drill must never widen the page's subsidiary
    // scope. An explicit out-of-scope (or empty) selection is indistinguishable
    // from a missing view, while an omitted selection inherits every visible
    // subsidiary instead of falling through to cashPosition's whole-company
    // default.
    if (
      gate.allowedSubsidiaryIds.size === 0 ||
      (requestedSubIds !== undefined &&
        (requestedSubIds.length === 0 ||
          requestedSubIds.some((id) => !gate.allowedSubsidiaryIds!.has(id))))
    ) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }
  const subIds = gate.allowedSubsidiaryIds
    ? requestedSubIds ?? [...gate.allowedSubsidiaryIds]
    : requestedSubIds;

  try {
    const cfg = await analyticsConfig(user.orgId, "cashflow");
    const apSettings = {
      weeklyCap: normalizeMoneyValue(String(cfg.weeklyApCap ?? 0)),
      restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1,
    };
    const position = await cashPosition(user.orgId, horizonWeeks, apSettings, asOf, subIds, gate.allowedSubsidiaryIds);
    const week = position.weeks.find((w) => w.weekStart === weekStart);
    if (!week) return NextResponse.json({ error: "week not in horizon" }, { status: 404 });
    return NextResponse.json({
      weekStart: week.weekStart,
      arEntries: week.arEntries,
      apEntries: week.apEntries,
    });
  } catch (error) {
    console.error("[cash/week-entries] failed", error);
    return NextResponse.json({ error: "could not load week" }, { status: 500 });
  }
}

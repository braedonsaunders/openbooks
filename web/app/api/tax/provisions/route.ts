import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  IncomeTaxProvisionError,
  computeProvisionRun,
  listProvisionRuns,
  orgTaxFramework,
  type DifferenceInput,
  type PermanentDifference,
} from "@openbooks/engine/src/income-tax-provision.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { guardPermission } from "../../../../lib/authz";
import { canonicalDecimal } from "../../../../lib/exact-decimal";

export const runtime = "nodejs";

const DIFF_CATEGORIES = new Set(["fixed_assets", "revenue_recognition", "provisions", "loss_carryforward", "other"]);

export async function GET() {
  const gate = await guardPermission("reports.read");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;
  const [runs, years, rates, framework] = await Promise.all([
    listProvisionRuns(orgId),
    db.execute<{ fiscal_year: number }>(sql`
      select distinct fiscal_year from accounting_periods where org_id = ${orgId} order by fiscal_year desc
    `),
    db.execute(sql`
      select jurisdiction, rate_percent as "ratePercent", effective_from::text as "effectiveFrom",
             effective_to::text as "effectiveTo", subsidiary_id as "subsidiaryId"
        from income_tax_rates where org_id = ${orgId} and is_active
       order by effective_from desc
    `),
    orgTaxFramework(orgId),
  ]);
  return NextResponse.json({
    runs,
    fiscalYears: years.rows.map((r) => r.fiscal_year),
    rates: rates.rows,
    framework,
  });
}

export async function POST(req: Request) {
  const gate = await guardPermission("reports.create");
  if (gate instanceof NextResponse) return gate;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const fiscalYear = Number(body.fiscalYear);
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200) {
    return NextResponse.json({ error: "fiscalYear is required" }, { status: 400 });
  }
  const money = (raw: unknown): string | null => {
    const exact = canonicalDecimal(raw, 4);
    return exact === null ? null : normalizeMoney(exact);
  };
  const permanentDifferences: PermanentDifference[] = [];
  if (Array.isArray(body.permanentDifferences)) {
    for (const p of body.permanentDifferences as { description?: unknown; amount?: unknown }[]) {
      if (typeof p?.description !== "string" || !p.description.trim()) continue;
      const amount = money(p.amount);
      if (amount === null) return NextResponse.json({ error: "invalid permanent-difference amount" }, { status: 400 });
      permanentDifferences.push({ description: p.description.trim(), amount });
    }
  }
  const additionalDifferences: DifferenceInput[] = [];
  if (Array.isArray(body.additionalDifferences)) {
    for (const d of body.additionalDifferences as { category?: unknown; description?: unknown; difference?: unknown }[]) {
      if (typeof d?.description !== "string" || !d.description.trim() || !DIFF_CATEGORIES.has(String(d.category))) continue;
      const difference = money(d.difference);
      if (difference === null) return NextResponse.json({ error: "invalid temporary-difference amount" }, { status: 400 });
      additionalDifferences.push({
        category: String(d.category) as DifferenceInput["category"],
        description: d.description.trim(),
        difference,
        source: "manual",
      });
    }
  }
  const lossCarryforwardUsed = money(body.lossCarryforwardUsed ?? "0");
  const valuationAllowance = money(body.valuationAllowance ?? "0");
  if (lossCarryforwardUsed === null || valuationAllowance === null) {
    return NextResponse.json({ error: "invalid provision amount" }, { status: 400 });
  }
  try {
    const runId = await computeProvisionRun(
      gate.user.orgId,
      fiscalYear,
      {
        permanentDifferences,
        additionalDifferences,
        lossCarryforwardUsed,
        valuationAllowance,
      },
      gate.user.id,
    );
    return NextResponse.json({ runId }, { status: 201 });
  } catch (e) {
    const status = e instanceof IncomeTaxProvisionError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}

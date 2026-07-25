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
import { guardPermission } from "../../../../lib/authz";

export const runtime = "nodejs";

const DIFF_CATEGORIES = new Set(["fixed_assets", "revenue_recognition", "provisions", "loss_carryforward", "other"]);

export async function GET() {
  const gate = await guardPermission("reports.read");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;
  const [runs, years, rates, framework] = await Promise.all([
    listProvisionRuns(orgId),
    db.execute(sql`
      select distinct fiscal_year from accounting_periods where org_id = ${orgId} order by fiscal_year desc
    `) as unknown as Promise<{ rows: { fiscal_year: number }[] }>,
    db.execute(sql`
      select jurisdiction, rate_percent as "ratePercent", effective_from::text as "effectiveFrom",
             effective_to::text as "effectiveTo", subsidiary_id as "subsidiaryId"
        from income_tax_rates where org_id = ${orgId} and is_active
       order by effective_from desc
    `) as unknown as Promise<{ rows: unknown[] }>,
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
  const permanentDifferences = Array.isArray(body.permanentDifferences)
    ? (body.permanentDifferences as { description?: unknown; amount?: unknown }[])
        .filter((p) => typeof p?.description === "string" && typeof p?.amount === "string" && p.description.trim())
        .map((p) => ({ description: String(p.description).trim(), amount: String(p.amount) }) satisfies PermanentDifference)
    : [];
  const additionalDifferences = Array.isArray(body.additionalDifferences)
    ? (body.additionalDifferences as { category?: unknown; description?: unknown; difference?: unknown }[])
        .filter(
          (d) =>
            typeof d?.description === "string" &&
            d.description.trim() &&
            typeof d?.difference === "string" &&
            DIFF_CATEGORIES.has(String(d.category)),
        )
        .map(
          (d) =>
            ({
              category: String(d.category) as DifferenceInput["category"],
              description: String(d.description).trim(),
              difference: String(d.difference),
              source: "manual",
            }) satisfies DifferenceInput,
        )
    : [];
  try {
    const runId = await computeProvisionRun(
      gate.user.orgId,
      fiscalYear,
      {
        permanentDifferences,
        additionalDifferences,
        lossCarryforwardUsed: typeof body.lossCarryforwardUsed === "string" ? body.lossCarryforwardUsed : "0",
        valuationAllowance: typeof body.valuationAllowance === "string" ? body.valuationAllowance : "0",
      },
      gate.user.id,
    );
    return NextResponse.json({ runId }, { status: 201 });
  } catch (e) {
    const status = e instanceof IncomeTaxProvisionError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}

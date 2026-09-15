import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  IncomeTaxProvisionError,
  computeProvisionRun,
  listProvisionRuns,
  orgTaxFramework,
  type DifferenceInput,
  type EntityProvisionInputs,
  type PermanentDifference,
} from "@openbooks/engine/src/income-tax-provision.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { guardPermission, guardSubsidiaryScope } from "../../../../lib/authz";
import { canonicalDecimal } from "../../../../lib/exact-decimal";

export const runtime = "nodejs";

const DIFF_CATEGORIES = new Set(["fixed_assets", "revenue_recognition", "provisions", "loss_carryforward", "other"]);

export async function GET() {
  const gate = await guardPermission("reports.read");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;
  const [runs, years, rates, framework] = await Promise.all([
    listProvisionRuns(orgId, gate.allowedSubsidiaryIds),
    db.execute<{ fiscal_year: number }>(sql`
      select distinct fiscal_year from accounting_periods where org_id = ${orgId} order by fiscal_year desc
    `),
    db.execute(sql`
      select jurisdiction, rate_percent as "ratePercent", effective_from::text as "effectiveFrom",
             effective_to::text as "effectiveTo", subsidiary_id as "subsidiaryId"
        from income_tax_rates where org_id = ${orgId} and is_active
        ${gate.allowedSubsidiaryIds === null ? sql`` : gate.allowedSubsidiaryIds.size === 0 ? sql`and false` : sql`and (subsidiary_id is null or subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(",")}}`}::uuid[]))`}
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
  const scopeDenied = guardSubsidiaryScope(gate, null);
  if (scopeDenied) return scopeDenied;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>;
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
      // An undescribed row is an empty grid line, not data — skip it exactly
      // as permanent differences do. A described row with an unknown category
      // is a caller error: dropping it would silently understate the run.
      if (typeof d?.description !== "string" || !d.description.trim()) continue;
      if (!DIFF_CATEGORIES.has(String(d.category))) {
        return NextResponse.json({ error: "invalid temporary-difference category" }, { status: 400 });
      }
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
  // Per-entity inputs the engine already measures (each legal entity in its
  // functional currency): the same shapes as the root-level inputs, keyed by
  // subsidiary id. The route validates shapes (400 on garbage); the engine
  // owns semantic validation (unknown subsidiaries fail the run loudly).
  const parseDifferences = (
    raw: unknown,
  ): { permanent: PermanentDifference[]; additional: DifferenceInput[] } | null => {
    const permanent: PermanentDifference[] = [];
    const additional: DifferenceInput[] = [];
    if (Array.isArray((raw as { permanentDifferences?: unknown })?.permanentDifferences)) {
      for (const p of (raw as { permanentDifferences: { description?: unknown; amount?: unknown }[] }).permanentDifferences) {
        if (typeof p?.description !== "string" || !p.description.trim()) continue;
        const amount = money(p.amount);
        if (amount === null) return null;
        permanent.push({ description: p.description.trim(), amount });
      }
    } else if ((raw as { permanentDifferences?: unknown })?.permanentDifferences !== undefined) {
      return null;
    }
    if (Array.isArray((raw as { additionalDifferences?: unknown })?.additionalDifferences)) {
      for (const d of (raw as { additionalDifferences: { category?: unknown; description?: unknown; difference?: unknown }[] }).additionalDifferences) {
        if (typeof d?.description !== "string" || !d.description.trim()) continue;
        if (!DIFF_CATEGORIES.has(String(d.category))) return null;
        const difference = money(d.difference);
        if (difference === null) return null;
        additional.push({
          category: String(d.category) as DifferenceInput["category"],
          description: d.description.trim(),
          difference,
          source: "manual",
        });
      }
    } else if ((raw as { additionalDifferences?: unknown })?.additionalDifferences !== undefined) {
      return null;
    }
    return { permanent, additional };
  };
  let entities: Record<string, EntityProvisionInputs> | undefined;
  if (body.entities !== undefined) {
    if (!body.entities || typeof body.entities !== "object" || Array.isArray(body.entities)) {
      return NextResponse.json({ error: "invalid provision entities" }, { status: 400 });
    }
    entities = {};
    for (const [subsidiaryId, raw] of Object.entries(body.entities as Record<string, unknown>)) {
      if (!subsidiaryId || !raw || typeof raw !== "object" || Array.isArray(raw)) {
        return NextResponse.json({ error: "invalid provision entities" }, { status: 400 });
      }
      const parsed = parseDifferences(raw);
      if (!parsed) return NextResponse.json({ error: "invalid provision entities" }, { status: 400 });
      const entry: EntityProvisionInputs = {};
      if (parsed.permanent.length > 0) entry.permanentDifferences = parsed.permanent;
      if (parsed.additional.length > 0) entry.additionalDifferences = parsed.additional;
      const loss = (raw as { lossCarryforwardUsed?: unknown }).lossCarryforwardUsed;
      if (loss !== undefined) {
        const amount = money(loss);
        if (amount === null) return NextResponse.json({ error: "invalid provision entities" }, { status: 400 });
        entry.lossCarryforwardUsed = amount;
      }
      const allowance = (raw as { valuationAllowance?: unknown }).valuationAllowance;
      if (allowance !== undefined) {
        const amount = money(allowance);
        if (amount === null) return NextResponse.json({ error: "invalid provision entities" }, { status: 400 });
        entry.valuationAllowance = amount;
      }
      entities[subsidiaryId] = entry;
    }
  }
  let presentationCurrency: string | undefined;
  if (body.presentationCurrency !== undefined) {
    if (typeof body.presentationCurrency !== "string" || !/^[A-Z]{3}$/.test(body.presentationCurrency)) {
      return NextResponse.json({ error: "invalid presentation currency" }, { status: 400 });
    }
    presentationCurrency = body.presentationCurrency;
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
        ...(entities !== undefined ? { entities } : {}),
        ...(presentationCurrency !== undefined ? { presentationCurrency } : {}),
      },
      gate.user.id,
    );
    return NextResponse.json({ runId }, { status: 201 });
  } catch (e) {
    const status = e instanceof IncomeTaxProvisionError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}

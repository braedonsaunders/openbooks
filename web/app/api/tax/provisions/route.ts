import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  IncomeTaxProvisionError,
  computeProvisionRun,
  listProvisionRuns,
  orgTaxFramework,
  type DifferenceInput,
  type EntityProvisionInputs,
  type PermanentDifference,
} from "@openbooks/engine/src/tax-returns/income-tax-provision.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
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
    if (exact === null) return null;
    // Provision results persist to numeric(19,4) columns and the engine
    // measures in unbounded bigint units, so a wider figure would die in
    // Postgres as a raw storage failure (HTTP 500). Refuse it here.
    if (exact.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length > 15) return null;
    return normalizeMoney(exact);
  };
  // A grid row with no description is an empty line ONLY when it carries no
  // data — no amount and (for temporary differences) no chosen category. A
  // populated row without a description refuses by row, naming the required
  // description, instead of silently shrinking the provision.
  //
  // The compute grid always carries a category: a pristine trailing row
  // arrives as description "", difference "" with the grid default "other".
  // That default is not user data — it must read as blank, never refuse —
  // while a deliberately CHOSEN category with no description still refuses.
  const PRISTINE_GRID_CATEGORY = "other";
  const isBlank = (v: unknown): boolean =>
    v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  const isBlankCategory = (v: unknown): boolean =>
    isBlank(v) || (typeof v === "string" && v.trim() === PRISTINE_GRID_CATEGORY);
  const described = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  // Grid rows arrive unfiltered so server indexes match the preparer's grid.
  // Anything that is not a plain row object (a string, null, a number, a
  // nested array) reads as "blank" through optional chaining and would be
  // SKIPPED as an empty line, silently understating the provision — refuse it
  // by indexed path BEFORE the blank-row test runs. Only a genuine object
  // with empty description/amount (and the pristine "other" category) stays
  // blank.
  const isRowObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (body.permanentDifferences !== undefined && !Array.isArray(body.permanentDifferences)) {
    return NextResponse.json({ error: "invalid permanent differences" }, { status: 400 });
  }
  if (body.additionalDifferences !== undefined && !Array.isArray(body.additionalDifferences)) {
    return NextResponse.json({ error: "invalid temporary differences" }, { status: 400 });
  }
  const permanentDifferences: PermanentDifference[] = [];
  for (const [i, p] of (body.permanentDifferences as { description?: unknown; amount?: unknown }[] | undefined ?? []).entries()) {
    if (!isRowObject(p)) {
      return NextResponse.json(
        { error: `permanentDifferences[${i}]: each row must be an object with description and amount` },
        { status: 400 },
      );
    }
    const description = described(p?.description);
    if (!description) {
      if (isBlank(p?.amount)) continue;
      return NextResponse.json(
        { error: `permanentDifferences[${i}]: description is required when an amount is provided` },
        { status: 400 },
      );
    }
    if (isBlank(p!.amount)) {
      return NextResponse.json(
        { error: `permanentDifferences[${i}]: amount is required when a description is provided` },
        { status: 400 },
      );
    }
    const amount = money(p!.amount);
    if (amount === null) return NextResponse.json({ error: "invalid permanent-difference amount" }, { status: 400 });
    permanentDifferences.push({ description, amount });
  }
  const additionalDifferences: DifferenceInput[] = [];
  for (const [i, d] of (body.additionalDifferences as { category?: unknown; description?: unknown; difference?: unknown }[] | undefined ?? []).entries()) {
    if (!isRowObject(d)) {
      return NextResponse.json(
        { error: `additionalDifferences[${i}]: each row must be an object with description, category and difference` },
        { status: 400 },
      );
    }
    // An undescribed row is an empty grid line, not data — skip it exactly
    // as permanent differences do. A described row with an unknown category
    // is a caller error: dropping it would silently understate the run.
    const description = described(d?.description);
    if (!description) {
      if (isBlank(d?.difference) && isBlankCategory(d?.category)) continue;
      return NextResponse.json(
        { error: `additionalDifferences[${i}]: description is required when an amount or category is provided` },
        { status: 400 },
      );
    }
    if (!DIFF_CATEGORIES.has(String(d!.category))) {
      return NextResponse.json({ error: "invalid temporary-difference category" }, { status: 400 });
    }
    if (isBlank(d!.difference)) {
      return NextResponse.json(
        { error: `additionalDifferences[${i}]: difference is required when a description is provided` },
        { status: 400 },
      );
    }
    const difference = money(d!.difference);
    if (difference === null) return NextResponse.json({ error: "invalid temporary-difference amount" }, { status: 400 });
    additionalDifferences.push({
      category: String(d!.category) as DifferenceInput["category"],
      description,
      difference,
      source: "manual",
    });
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
    path: string,
  ): { permanent: PermanentDifference[]; additional: DifferenceInput[] } | { error: string } => {
    const permanent: PermanentDifference[] = [];
    const additional: DifferenceInput[] = [];
    const rejectNonArray = (v: unknown): { error: string } | null =>
      v === undefined || Array.isArray(v) ? null : { error: "invalid provision entities" };
    const fail = (message: string): { error: string } => ({ error: message });
    const permanentRaw = (raw as { permanentDifferences?: unknown })?.permanentDifferences;
    {
      const bad = rejectNonArray(permanentRaw);
      if (bad) return bad;
    }
    for (const [i, p] of ((permanentRaw ?? []) as { description?: unknown; amount?: unknown }[]).entries()) {
      if (!isRowObject(p)) {
        return fail(`${path}.permanentDifferences[${i}]: each row must be an object with description and amount`);
      }
      const description = described(p?.description);
      if (!description) {
        if (isBlank(p?.amount)) continue;
        return fail(`${path}.permanentDifferences[${i}]: description is required when an amount is provided`);
      }
      if (isBlank(p!.amount)) {
        return fail(`${path}.permanentDifferences[${i}]: amount is required when a description is provided`);
      }
      const amount = money(p!.amount);
      if (amount === null) return fail("invalid provision entities");
      permanent.push({ description, amount });
    }
    const additionalRaw = (raw as { additionalDifferences?: unknown })?.additionalDifferences;
    {
      const bad = rejectNonArray(additionalRaw);
      if (bad) return bad;
    }
    for (const [i, d] of ((additionalRaw ?? []) as { category?: unknown; description?: unknown; difference?: unknown }[]).entries()) {
      if (!isRowObject(d)) {
        return fail(`${path}.additionalDifferences[${i}]: each row must be an object with description, category and difference`);
      }
      const description = described(d?.description);
      if (!description) {
        if (isBlank(d?.difference) && isBlankCategory(d?.category)) continue;
        return fail(`${path}.additionalDifferences[${i}]: description is required when an amount or category is provided`);
      }
      if (!DIFF_CATEGORIES.has(String(d!.category))) return fail("invalid provision entities");
      if (isBlank(d!.difference)) {
        return fail(`${path}.additionalDifferences[${i}]: difference is required when a description is provided`);
      }
      const difference = money(d!.difference);
      if (difference === null) return fail("invalid provision entities");
      additional.push({
        category: String(d!.category) as DifferenceInput["category"],
        description,
        difference,
        source: "manual",
      });
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
      const parsed = parseDifferences(raw, `entities[${JSON.stringify(subsidiaryId)}]`);
      if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
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
      gate.allowedSubsidiaryIds,
    );
    return NextResponse.json({ runId }, { status: 201 });
  } catch (e) {
    const status = e instanceof IncomeTaxProvisionError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}

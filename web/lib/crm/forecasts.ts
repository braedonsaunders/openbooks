import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { can, type Authz } from "../authz";
import { calculateForecast } from "../crm.ts";
import { canonicalDecimal, compareDecimal } from "../exact-decimal";
import { moneyRefusal } from "../payroll-decimal-refusal";
import { civilDateInput } from "../api/civil-date";
import { validateJsonBody } from "../api/json";

export type CrmForecastMessages = {
  invalidOwnerTarget: string;
  invalidTeamTarget: string;
  ownerOutsideOrganization: string;
  teamOutsideOrganization: string;
};

const DEFAULT_MESSAGES: CrmForecastMessages = {
  invalidOwnerTarget: "ownerUserId must be a valid organization user UUID",
  invalidTeamTarget: "salesTeamId must be a valid organization team UUID",
  ownerOutsideOrganization: "Forecast owner must belong to this organization",
  teamOutsideOrganization: "Forecast sales team must belong to this organization",
};

function forecastAmount() {
  return z
    .string()
    .max(40)
    .superRefine((value, ctx) => {
      const parsed = canonicalDecimal(value, 4);
      if (parsed === null)
        ctx.addIssue({ code: "custom", message: moneyRefusal("Override amount", value) });
      else if (compareDecimal(parsed, "0") < 0)
        ctx.addIssue({ code: "custom", message: "Override amount must be non-negative" });
      else if (parsed.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
        ctx.addIssue({
          code: "custom",
          message: "Override amount is out of range; at most 15 whole digits fit the ledger",
        });
      }
    });
}

export function crmForecastSnapshotSchema(
  messages = DEFAULT_MESSAGES,
  idempotencyKey?: z.ZodType<string>,
) {
  const fields = {
    periodStart: civilDateInput().describe("Forecast period start date in YYYY-MM-DD format."),
    periodEnd: civilDateInput().describe("Forecast period end date in YYYY-MM-DD format."),
    ownerUserId: uuidString({ error: messages.invalidOwnerTarget })
      .nullable()
      .optional()
      .describe("Optional owner UUID; null targets a team or the organization."),
    salesTeamId: uuidString({ error: messages.invalidTeamTarget })
      .nullable()
      .optional()
      .describe("Optional sales team UUID; null targets an owner or the organization."),
    overrideAmount: forecastAmount()
      .nullable()
      .optional()
      .describe("Exact non-negative decimal override amount, or null for a calculated snapshot."),
    snapshotKind: z
      .enum(["calculated", "rep_override", "manager_override"])
      .optional()
      .describe("Forecast snapshot kind; defaults from whether an override amount is supplied."),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .nullable()
      .optional()
      .describe("Optional three-letter currency code for an override."),
    note: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .describe("Optional audit note stored with the forecast snapshot."),
  };
  const bodySchema = idempotencyKey
    ? z.strictObject({ ...fields, idempotencyKey })
    : z.strictObject(fields);
  return bodySchema
    .refine((body) => body.periodEnd >= body.periodStart, {
      message: "periodEnd must be on or after periodStart",
      path: ["periodEnd"],
    })
    .refine((body) => !(body.ownerUserId && body.salesTeamId), {
      message: "choose at most one owner or team",
      path: ["salesTeamId"],
    });
}

/** Save the same forecast snapshot used by the CRM route. */
export async function createCrmForecastSnapshot(
  authz: Authz,
  rawBody: unknown,
  messages = DEFAULT_MESSAGES,
): Promise<NextResponse | { ids: string[] }> {
  if (authz.allowedSubsidiaryIds !== null)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  const nativeBody =
    rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
      ? Object.fromEntries(Object.entries(rawBody).filter(([key]) => key !== "idempotencyKey"))
      : rawBody;
  const parsedBody = validateJsonBody(nativeBody, crmForecastSnapshotSchema(messages), {
    status: 422,
  });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const { periodStart, periodEnd } = body;
  const ownerUserId = body.ownerUserId === undefined ? authz.user.id : body.ownerUserId;
  const salesTeamId = body.salesTeamId ?? null;
  const overrideRaw =
    body.overrideAmount == null || body.overrideAmount === ""
      ? null
      : canonicalDecimal(body.overrideAmount, 4);
  const overrideAmount = overrideRaw === null ? null : normalizeMoney(overrideRaw);
  const kind = body.snapshotKind ?? (overrideAmount === null ? "calculated" : "rep_override");
  if ((kind === "calculated") !== (overrideAmount === null)) {
    return NextResponse.json(
      { error: "snapshot kind must match the presence of an override amount" },
      { status: 422 },
    );
  }
  const requestedCurrency = body.currency?.toUpperCase() ?? null;
  if (kind === "manager_override" || (ownerUserId !== authz.user.id && overrideAmount !== null)) {
    if (!can(authz, "crm.forecasts.override"))
      return NextResponse.json(
        { error: "missing permission: crm.forecasts.override" },
        { status: 403 },
      );
  }
  const forecast = await calculateForecast({
    orgId: authz.user.orgId,
    periodStart,
    periodEnd,
    ownerUserId: typeof ownerUserId === "string" || ownerUserId == null ? ownerUserId : undefined,
    salesTeamId: typeof salesTeamId === "string" || salesTeamId == null ? salesTeamId : undefined,
  });
  if (overrideAmount !== null && !requestedCurrency && forecast.length !== 1) {
    return NextResponse.json(
      { error: "choose one currency for the override amount" },
      { status: 422 },
    );
  }
  const created = await db.transaction(async (tx) => {
    if (ownerUserId) {
      const owner = await tx.execute(
        sql`select id from users where id = ${ownerUserId} and org_id = ${authz.user.orgId}`,
        "objects",
      );
      if (!owner.length)
        return NextResponse.json({ error: messages.ownerOutsideOrganization }, { status: 422 });
    }
    if (salesTeamId) {
      const team = await tx.execute(
        sql`select id from crm_sales_teams where id = ${salesTeamId} and org_id = ${authz.user.orgId}`,
        "objects",
      );
      if (!team.length)
        return NextResponse.json({ error: messages.teamOutsideOrganization }, { status: 422 });
    }
    if (
      requestedCurrency &&
      !(
        await tx.execute(
          sql`select code from currencies where code=${requestedCurrency}`,
          "objects",
        )
      ).length
    ) {
      return NextResponse.json({ error: "invalid forecast currency" }, { status: 422 });
    }
    let rows = requestedCurrency
      ? forecast.filter((row) => row.currency === requestedCurrency)
      : forecast;
    const emptyPipeline = rows.length === 0;
    if (emptyPipeline) {
      const currency =
        requestedCurrency ??
        (
          await tx.execute<{ base_currency: string }>(
            sql`select base_currency from orgs where id=${authz.user.orgId}`,
            "objects",
          )
        )[0]?.base_currency;
      if (!currency)
        return NextResponse.json(
          { error: "organization reporting currency is required" },
          { status: 422 },
        );
      rows = [
        {
          currency,
          pipeline_amount: "0.0000",
          weighted_amount: "0.0000",
          worst_case_amount: "0.0000",
          most_likely_amount: "0.0000",
          upside_amount: "0.0000",
          closed_amount: "0.0000",
        },
      ];
    }
    const detail = {
      calculatedAt: new Date().toISOString(),
      emptyPipeline,
      currencySource: requestedCurrency
        ? "selected"
        : emptyPipeline
          ? "organization_base_currency"
          : "forecast",
    };
    const ids: string[] = [];
    for (const row of rows) {
      const result = await tx.execute<{ id: string }>(
        sql`
          insert into crm_forecast_snapshots
            (org_id, owner_user_id, sales_team_id, period_start, period_end, snapshot_kind, currency,
             pipeline_amount, weighted_amount, worst_case_amount, most_likely_amount, upside_amount,
             closed_amount, override_amount, note, detail, created_by, updated_by)
          values (${authz.user.orgId}, ${ownerUserId}, ${salesTeamId}, ${periodStart}, ${periodEnd}, ${kind}, ${row.currency},
                  ${row.pipeline_amount}, ${row.weighted_amount}, ${row.worst_case_amount}, ${row.most_likely_amount},
                  ${row.upside_amount}, ${row.closed_amount}, ${overrideAmount}, ${body.note ?? null},
                  ${JSON.stringify(detail)}::jsonb, ${authz.user.id}, ${authz.user.id}) returning id`,
        "objects",
      );
      const id = result[0]?.id;
      if (!id) throw new Error("Forecast snapshot was not saved.");
      ids.push(id);
    }
    return ids;
  });
  return created instanceof NextResponse ? created : { ids: created };
}

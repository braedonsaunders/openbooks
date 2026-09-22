import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import { clamp } from "../list-params";
import type { ApplicationContext } from "./context";
import { ApplicationError, forbidden, invalidInput } from "./errors";

const ISO = /^[A-Z]{3}$/;

function featureOff(name: string): never {
  throw new ApplicationError(
    "not_found",
    `${name} is off; enable it from GET /api/v1/settings/features`,
    404,
  );
}

/** ISO currency registry plus this org's base currency. */
export async function listApplicationCurrencies(context: ApplicationContext) {
  const [currencies, org] = await Promise.all([
    db.execute<{ code: string; name: string; minor_units: number }>(
      sql`select code, name, minor_units from currencies order by code`,
    ),
    db.execute<{ base_currency: string }>(
      sql`select base_currency from orgs where id = ${context.authz.user.orgId}`,
    ),
  ]);
  return {
    baseCurrency: org.rows[0]?.base_currency ?? null,
    total: currencies.rows.length,
    currencies: currencies.rows.map((row) => ({
      code: row.code,
      name: row.name,
      minorUnits: row.minor_units,
    })),
  };
}

/** Dated FX rates for one pair — exact decimal strings, never floats. */
export async function listApplicationFxRates(
  context: ApplicationContext,
  input: { fromCurrency: string; toCurrency: string; asOf?: string; rateType?: string; limit?: number },
) {
  if (!can(context.authz, "gl.read") && !can(context.authz, "close.read")) {
    throw forbidden("gl.read");
  }
  if (!(await isFeatureEnabled(context.authz.user.orgId, "multiCurrency"))) {
    featureOff("multiCurrency");
  }
  if (!ISO.test(input.fromCurrency) || !ISO.test(input.toCurrency)) {
    throw invalidInput("fromCurrency and toCurrency must be ISO 4217 codes, e.g. USD and CAD");
  }
  if (input.asOf && !/^\d{4}-\d{2}-\d{2}$/.test(input.asOf)) {
    throw invalidInput("asOf must be YYYY-MM-DD");
  }
  const limit = clamp(input.limit ?? 20, 1, 100);
  let where = sql`org_id = ${context.authz.user.orgId}
    and from_currency = ${input.fromCurrency}
    and to_currency = ${input.toCurrency}`;
  if (input.asOf) where = sql`${where} and as_of <= ${input.asOf}`;
  if (input.rateType) where = sql`${where} and rate_type = ${input.rateType}`;
  const rows = await db.execute<{
    as_of: string;
    rate_type: string;
    rate: string;
    source: string | null;
    imported_at: Date | null;
  }>(sql`
    select from_currency, to_currency, as_of, rate_type, rate::text as rate, source, imported_at
      from fx_rates
     where ${where}
     order by as_of desc, created_at desc
     limit ${limit}`);
  return {
    fromCurrency: input.fromCurrency,
    toCurrency: input.toCurrency,
    total: rows.rows.length,
    rates: rows.rows.map((row) => ({
      asOf: row.as_of,
      rateType: row.rate_type,
      rate: row.rate,
      source: row.source,
      importedAt: row.imported_at,
    })),
  };
}

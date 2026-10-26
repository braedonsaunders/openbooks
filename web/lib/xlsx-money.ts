import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import type { XlsxMoneyContext } from "@openbooks/office";
import { orgInfo } from "./data";

/**
 * The money context of a spreadsheet export: the currency its money is in
 * (the organization's base currency, the one report viewers format money
 * in, unless the export states its own, such as a filing's frozen
 * functional currency) and the minor units of every registered currency.
 * An organization with no base currency refuses rather than guessing one.
 */
export async function xlsxMoneyContext(
  orgId: string,
  currency?: string | null,
): Promise<XlsxMoneyContext> {
  const resolved = currency?.trim() || (await orgInfo(orgId))?.base_currency?.trim();
  if (!resolved) throw new Error("A spreadsheet export needs the organization base currency");
  const rows = await db.execute<{ code: string; minor_units: number | string }>(
    sql`
    select code, minor_units from currencies`,
    "objects",
  );
  return {
    currency: resolved.toUpperCase(),
    minorUnits: Object.fromEntries(
      rows.map((row) => [row.code.toUpperCase(), Number(row.minor_units)]),
    ),
  };
}

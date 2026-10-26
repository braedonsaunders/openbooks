import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

export const openingSourceYearFenceKey = (orgId: string, taxYear: number): string =>
  `payroll-opening-source:${orgId}:${taxYear}`;

/** Issuance and source replacement serialize before either reads a certificate head. */
export async function takeOpeningSourceYearFence(
  tx: Pick<SqlExecutor, "execute">,
  orgId: string,
  taxYear: number,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${openingSourceYearFenceKey(orgId, taxYear)},0))`,
  );
}

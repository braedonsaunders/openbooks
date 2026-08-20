import { sql } from "drizzle-orm";
import { db } from "./db.ts";

/**
 * The organisation's financial reporting framework. It decides the questions
 * where US GAAP and IFRS give DIFFERENT answers to the same facts:
 *
 *  - inventory NRV write-down reversal: required under IAS 2.33, prohibited
 *    under ASC 330-10-35-14;
 *  - lessee lease model: single model under IFRS 16.22, finance/operating
 *    classification under ASC 842-10-25-2.
 *
 * Resolution: `orgs.settings.reportingFramework` ('us_gaap' | 'ifrs') when the
 * administrator has set it, else inferred from the income-tax framework the
 * org already carries (`settings.taxFramework`: 'ias12' → IFRS), else US GAAP.
 * A setting, never a hardcode — the same facts must produce each framework's
 * answer on demand.
 */
export type ReportingFramework = "us_gaap" | "ifrs";

export async function orgReportingFramework(orgId: string): Promise<ReportingFramework> {
  const r = (await db.execute<{ rf: string | null; tf: string | null }>(sql`
    select settings->>'reportingFramework' as rf, settings->>'taxFramework' as tf
      from orgs where id = ${orgId}
  `));
  const row = r.rows[0];
  if (row?.rf === "ifrs" || row?.rf === "us_gaap") return row.rf;
  return row?.tf === "ias12" ? "ifrs" : "us_gaap";
}

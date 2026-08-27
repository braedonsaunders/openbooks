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
 * Resolution: `orgs.settings.reportingFramework` ('us_gaap' | 'ifrs') is the
 * authoritative policy. Income-tax presentation is deliberately independent
 * and is never consulted here. Every organization
 * reaches this reader with an explicit value: the 0033 upgrade backfills
 * existing rows and the setup wizard seeds new organizations.
 */
export type ReportingFramework = "us_gaap" | "ifrs";

export async function orgReportingFramework(orgId: string): Promise<ReportingFramework> {
  const r = (await db.execute<{ rf: string | null }>(sql`
    select settings->>'reportingFramework' as rf
      from orgs where id = ${orgId}
  `));
  const row = r.rows[0];
  // 0033 backfills every persisted organization and setup writes the policy
  // for new ones. Keep the historical defensive default for isolated callers
  // that construct an unconfigured scratch organization; importantly, this
  // branch never consults income-tax presentation.
  return row?.rf === "ifrs" ? "ifrs" : "us_gaap";
}

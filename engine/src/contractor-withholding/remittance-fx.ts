import { sql } from "drizzle-orm";
import { lookupSpotRateWithEvidence, type FxAsOfEvidence } from "../fx/spot-rate.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { ContractorWithholdingError } from "./scheme.ts";

/** Price a statutory-currency authority document using the native stored spot evidence. */
export async function withholdingRemittanceFx(
  executor: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  currency: string,
  documentDate: string,
): Promise<FxAsOfEvidence & { rate: string }> {
  const entity = (await executor.execute<{ base_currency: string }>(sql`
    select base_currency from subsidiaries
     where org_id=${orgId} and id=${subsidiaryId} and is_active for share`)).rows[0];
  if (!entity?.base_currency) throw new ContractorWithholdingError(
    "The enrolled legal entity must remain active with a configured functional currency.",
    "Review the legal entity in Setup before preparing the authority document.",
  );
  const evidence = await lookupSpotRateWithEvidence(executor, orgId, currency, entity.base_currency, documentDate);
  if (evidence.rate === null) throw new ContractorWithholdingError(
    `No stored ${currency} → ${entity.base_currency} spot rate is available on or before ${documentDate}.`,
    `Enter or refresh the ${currency} → ${entity.base_currency} quote in Setup → Exchange Rates, then prepare the authority document again.`,
  );
  return { ...evidence, rate: evidence.rate };
}

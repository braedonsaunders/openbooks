import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import {
  HistoricalTranslationEvidenceError,
  readHistoricalTranslationContribution,
  sumHistoricalTranslationExactAmounts,
} from "../journal/historical-translation-evidence.ts";

/** Resolve only the physical sources selected by the caller's authorized
 * report scope. Current entity and book currencies are not documentary basis. */
export async function historicalTranslationAmounts(
  tx: SqlExecutor,
  args: { orgId: string; presentationCurrency?: string; sources: SQL },
): Promise<SQL> {
  const sources = await tx.execute<{ sourceLineId: string }>(args.sources, "objects");
  if (!sources.length) return sql`null::numeric`;
  if (!args.presentationCurrency || !/^[A-Z]{3}$/.test(args.presentationCurrency))
    throw new HistoricalTranslationEvidenceError(
      "Select the report's explicit presentation currency before reading historical equity contributions.",
    );
  const amounts: Array<{ line_id: string; amount: string }> = [];
  for (const sourceLineId of [...new Set(sources.map((source) => source.sourceLineId))].sort()) {
    const contribution = await readHistoricalTranslationContribution(tx, {
      orgId: args.orgId,
      sourceLineId,
      presentationCurrency: args.presentationCurrency,
    });
    amounts.push({
      line_id: sourceLineId,
      amount: sumHistoricalTranslationExactAmounts(
        "identity" in contribution
          ? [contribution.translatedAmount]
          : contribution.layers.map((layer) => layer.translatedAmount),
      ),
    });
  }
  // Unrounded products enter the account/column aggregate as numeric. A
  // source absent from the validated snapshot yields NULL, which the caller
  // must refuse rather than permit SUM to omit a concurrent new source.
  return sql`(select historical.amount from jsonb_to_recordset(${JSON.stringify(amounts)}::jsonb)
    as historical(line_id uuid, amount numeric) where historical.line_id=l.id)`;
}

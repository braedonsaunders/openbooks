import type { SqlExecutor } from "../platform/db.ts";
import { sql } from "drizzle-orm";
import { uuidArray } from "../organization/subsidiaries.ts";
import { DepreciationRefusalError } from "./depreciation-errors.ts";

/** A mirrored asset has one depreciation authority: its owning source. */
export function assertLocalDepreciation(custom: unknown, assetNumber: string): void {
  if (
    custom &&
    typeof custom === "object" &&
    "sourceManaged" in custom &&
    custom.sourceManaged === true
  ) {
    throw new DepreciationRefusalError(
      `Asset ${assetNumber} is source-managed. Update depreciation in its source system and synchronize the connection; local schedule rebuilding, inputs and posting are unavailable.`,
    );
  }
}

export async function assertLocalDepreciationSelection(
  runner: SqlExecutor,
  orgId: string,
  assetIds: readonly string[] | undefined,
  allowedSubsidiaryIds?: readonly string[] | null,
): Promise<void> {
  if (!assetIds?.length) return;
  const rows = await runner.execute<{ custom: unknown; asset_number: string }>(
    sql`
    select custom, asset_number from fixed_assets where org_id=${orgId}
      and id=any(${uuidArray([...assetIds])}::uuid[])
      ${allowedSubsidiaryIds ? sql`and subsidiary_id=any(${uuidArray([...allowedSubsidiaryIds])}::uuid[])` : sql``}`,
    "objects",
  );
  for (const row of rows) assertLocalDepreciation(row.custom, row.asset_number);
}

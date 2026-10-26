import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

export async function hasActiveDepreciationBook(orgId: string, bookId: string): Promise<boolean> {
  const rows = await db.execute(
    sql`
      select 1 from accounting_books
       where id = ${bookId} and org_id = ${orgId} and is_active
    `,
    "objects",
  );
  return Boolean(rows[0]);
}

export async function loadDepreciationPeriodStart(
  orgId: string,
  periodId: string,
): Promise<{ starts_on: string } | null> {
  const rows = await db.execute<{ starts_on: string }>(
    sql`
      select starts_on::text as starts_on from accounting_periods
       where id = ${periodId} and org_id = ${orgId} and not is_adjustment
    `,
    "objects",
  );
  return rows[0] ?? null;
}

export async function hasDepreciationPeriod(orgId: string, periodId: string): Promise<boolean> {
  const rows = await db.execute(
    sql`
      select 1 from accounting_periods
       where id = ${periodId} and org_id = ${orgId} and not is_adjustment
    `,
    "objects",
  );
  return Boolean(rows[0]);
}

export async function listVisibleDepreciationAssetIds(input: {
  orgId: string;
  ids: string[];
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ id: string }[]> {
  return db.execute<{ id: string }>(
    sql`
        select a.id from fixed_assets a
         where a.org_id = ${input.orgId} and a.id = any(${`{${input.ids.join(",")}}`}::uuid[])
           ${input.allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${`{${[...input.allowedSubsidiaryIds].join(",")}}`}::uuid[])` : sql``}
      `,
    "objects",
  );
}

export async function listVisibleDepreciationAssetNumbers(input: {
  orgId: string;
  ids: string[];
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ id: string; asset_number: string }[]> {
  return db.execute<{ id: string; asset_number: string }>(
    sql`
    select a.id, a.asset_number from fixed_assets a
     where a.org_id = ${input.orgId} and a.id = any(${`{${input.ids.join(",")}}`}::uuid[])
       ${input.allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${`{${[...input.allowedSubsidiaryIds].join(",")}}`}::uuid[])` : sql``}
  `,
    "objects",
  );
}

export async function isVisibleDepreciationAsset(input: {
  orgId: string;
  assetId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<boolean> {
  const rows = await db.execute(
    sql`
    select 1 from fixed_assets where id = ${input.assetId} and org_id = ${input.orgId}
      ${input.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${[...input.allowedSubsidiaryIds].join(",")}}`}::uuid[])` : sql``}
  `,
    "objects",
  );
  return Boolean(rows[0]);
}

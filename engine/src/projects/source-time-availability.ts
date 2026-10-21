import { sql, type SQL } from "drizzle-orm";

/** A source deletion retires availability from its source calendar date, retaining prior evidence. */
export function sourceTimeAvailableSql(custom: SQL, asOf?: SQL): SQL {
  return asOf
    ? sql`(${custom}->'sourceRetirement' is null or ${custom}->'sourceRetirement'->>'deletedOn' > ${asOf}::text)`
    : sql`${custom}->'sourceRetirement' is null`;
}

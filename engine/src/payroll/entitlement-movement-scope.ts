import { sql, type SQL } from "drizzle-orm";

/** Bank balances include posted payroll and independent movements, never editable calculations. */
export function committedEntitlementMovementSql(movementRunId: SQL, runStatus: SQL): SQL {
  return sql`(${movementRunId} is null or ${runStatus} = 'committed')`;
}

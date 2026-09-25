import { sql } from "drizzle-orm";
import { FieldTimeError } from "./errors.ts";
import type { SqlExecutor } from "../../platform/db.ts";

export type FieldTimeSource = "clock_pair" | "crew_batch";

/**
 * Serialize every source that can create payable field-time rows for one
 * employee. Clock events already used this lock; crew posting joins the same
 * lock so the two writers cannot both pass a source-collision check.
 */
export async function lockEmployeeTimeSources(
  exec: SqlExecutor,
  orgId: string,
  employeePartyIds: readonly string[],
): Promise<void> {
  for (const employeePartyId of [...new Set(employeePartyIds)].sort()) {
    await exec.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`field-clock:${orgId}:${employeePartyId}`}, 0)
      )`);
  }
}

/** Refuse a second independent clock/crew source for an employee's work day. */
export async function assertNoFieldTimeSourceCollision(
  exec: SqlExecutor,
  input: {
    orgId: string;
    employeePartyId: string;
    workedOn: string;
    source: FieldTimeSource;
    sourceId: string;
  },
): Promise<void> {
  const currentClockPair = input.source === "clock_pair" ? input.sourceId : null;
  const currentCrewBatch = input.source === "crew_batch" ? input.sourceId : null;
  const collision = (await exec.execute<{ source: FieldTimeSource; sourceId: string }>(sql`
    select case when te.clock_pair_id is not null then 'clock_pair' else 'crew_batch' end as source,
           coalesce(te.clock_pair_id::text, batch_lines.batch_id::text) as "sourceId"
      from time_entries te
      left join crew_time_batch_lines batch_lines
        on batch_lines.org_id = te.org_id and batch_lines.id = te.crew_batch_line_id
     where te.org_id = ${input.orgId}::uuid
       and te.employee_party_id = ${input.employeePartyId}::uuid
       and te.worked_on = ${input.workedOn}::date
       and ((te.clock_pair_id is not null and te.clock_pair_id is distinct from ${currentClockPair}::uuid)
         or (te.crew_batch_line_id is not null and batch_lines.batch_id is distinct from ${currentCrewBatch}::uuid))
     order by te.id
     limit 1
  `)).rows[0];
  if (collision) {
    const sourceName = collision.source === "clock_pair" ? "clock pairing" : "crew batch";
    throw new FieldTimeError(
      "source_collision",
      `Worker ${input.employeePartyId} already has ${sourceName} time for ${input.workedOn} — reconcile the existing source in Timesheets before posting this day from another field-time source`,
    );
  }
}

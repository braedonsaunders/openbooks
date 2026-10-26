import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";

type DeletedInput = { id: string; sourceRef: string; deletedAt: string };

/** Preserve source-deleted inputs and their financial evidence; retire only their availability. */
export async function retireSourceProjectInputs(options: {
  orgId: string;
  connectionId: string;
  runId: string;
  actorId: string | null;
  source: string;
  refKey: string;
  apply: boolean;
  projects: DeletedInput[];
  timeEntries: DeletedInput[];
}): Promise<{ projects: number; timeEntries: number }> {
  const preserved = { projects: 0, timeEntries: 0 };
  await db.transaction(async (tx) => {
    for (const [kind, table] of [
      ["projects", sql`projects`],
      ["timeEntries", sql`time_entries`],
    ] as const) {
      for (const input of options[kind]) {
        const before = (
          await tx.execute<{ record: Record<string, unknown>; custom: Record<string, unknown> }>(
            sql`
          select to_jsonb(r) as record,coalesce(r.custom,'{}'::jsonb) as custom
          from ${table} r where r.org_id=${options.orgId} and r.id=${input.id}
            and r.custom->>${options.refKey}=${input.sourceRef} for update
        `,
            "objects",
          )
        )[0];
        if (!before)
          throw new Error(
            "The source-deleted project input changed before retirement; retry the sync",
          );
        const existing = before.custom.sourceRetirement as Record<string, unknown> | undefined;
        if (existing) {
          if (
            existing.system !== options.source ||
            existing.connectionId !== options.connectionId ||
            existing.sourceRef !== input.sourceRef
          ) {
            throw new Error("The project input has conflicting source-retirement evidence");
          }
          preserved[kind]++;
          continue;
        }
        if (!options.apply) continue;
        const sourceDay = /^(\d{2})\/(\d{2})\/(\d{4})\b/.exec(input.deletedAt);
        const deletedOn = sourceDay
          ? `${sourceDay[3]}-${sourceDay[1]}-${sourceDay[2]}`
          : input.deletedAt.slice(0, 10);
        if (!isIsoCalendarDate(deletedOn))
          throw new Error("The source deletion lacks a valid source calendar date");
        const evidence = {
          system: options.source,
          connectionId: options.connectionId,
          sourceRef: input.sourceRef,
          refKey: options.refKey,
          deletedAt: input.deletedAt,
          deletedOn,
          syncRunId: options.runId,
        };
        const lifecycle = kind === "projects" ? sql`is_active=false,` : sql``;
        const after = (
          await tx.execute<{ record: Record<string, unknown> }>(
            sql`
          update ${table} r set ${lifecycle}
            custom=jsonb_set(coalesce(custom,'{}'::jsonb),'{sourceRetirement}',${JSON.stringify(evidence)}::jsonb),
            updated_at=now(),updated_by=${options.actorId}
          where r.org_id=${options.orgId} and r.id=${input.id}
            and r.custom->>${options.refKey}=${input.sourceRef}
          returning to_jsonb(r) as record
        `,
            "objects",
          )
        )[0];
        if (!after) throw new Error("The source-deleted project input was not retired");
        await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id,request_id)
          values(${options.orgId},${kind === "projects" ? "projects" : "time_entries"},${input.id},'update',
            ${JSON.stringify({
              before: before.record,
              after: after.record,
              reason:
                "The authoritative source records this input as deleted; preserve its history and retire availability",
              source: evidence,
            })}::jsonb,
            ${options.actorId},${options.runId})`);
        preserved[kind]++;
      }
    }
  });
  return preserved;
}

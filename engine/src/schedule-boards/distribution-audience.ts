/** Delivery membership is a current native role/contact read, separate from historical schedule evidence. */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { boardScopeFilter, type BoardWindow } from "./window.ts";
import type { ScheduleActor, ScheduleBoard } from "./boards.ts";
import { ScheduleError } from "./errors.ts";
export type ScheduleCohort = "scheduled" | "scope" | "supervisors" | "self";
export async function resolvePeopleAudience(
  actor: ScheduleActor,
  board: ScheduleBoard,
  window: BoardWindow,
  allowed: ReadonlySet<string> | null,
  cohort: ScheduleCohort,
  selected: readonly string[] | null,
) {
  const evidence = [
    ...new Set([
      ...window.entries
        .filter((e) => e.boardId === board.id && e.status === "published")
        .map((e) => e.subjectId),
      ...(window.sourceRecords ?? []).map((r) => r.workerPartyId),
    ]),
  ];
  const currentDate = (
    await db.execute<{ date: string }>(
      sql`select to_char(now() at time zone ${board.timeZone},'YYYY-MM-DD') as date`,
    )
  ).rows[0]!.date;
  const members = (
    await db.execute<{
      id: string;
      name: string;
      supervisorId: string | null;
      inScope: boolean;
    }>(
      sql`select p.id,p.display_name as name,er.supervisor_id as "supervisorId",(${boardScopeFilter(board, actor.orgId, currentDate)}) as "inScope" from parties p join employee_roles er on er.org_id=p.org_id and er.party_id=p.id where p.org_id=${actor.orgId} and p.kind='person' and p.is_active and er.is_active and (er.hired_on is null or er.hired_on <= (now() at time zone ${board.timeZone})::date) and (er.terminated_on is null or er.terminated_on >= (now() at time zone ${board.timeZone})::date) ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowed)} order by p.id for share of p,er`,
    )
  ).rows;
  const eligible = members.filter((p) => p.inScope || evidence.includes(p.id));
  let ids =
    cohort === "scheduled"
      ? eligible.filter((p) => evidence.includes(p.id)).map((p) => p.id)
      : eligible.map((p) => p.id);
  if (cohort === "supervisors")
    ids = [
      ...new Set(
        eligible.flatMap((p) => (p.supervisorId ? [p.supervisorId] : [])),
      ),
    ].filter((id) => members.some((p) => p.id === id));
  if (cohort === "self") {
    const self = (
      await db.execute<{ id: string }>(
        sql`select party_id as id from users where org_id=${actor.orgId} and id=${actor.actorId} and is_active`,
      )
    ).rows[0]?.id;
    ids = self && eligible.some((p) => p.id === self) ? [self] : [];
  }
  if (selected) {
    if (selected.some((id) => !eligible.some((p) => p.id === id)))
      throw new ScheduleError(
        "A selected employee is not a current, visible member of this board.",
        {
          remedy:
            "Choose current native employees in the board scope or current borrowed workers.",
        },
      );
    ids = [...selected];
  }
  const excluded = evidence.filter((id) => !members.some((p) => p.id === id));
  return { ids: [...new Set(ids)].sort(), excluded };
}

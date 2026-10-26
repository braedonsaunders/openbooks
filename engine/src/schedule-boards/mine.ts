/**
 * A person's own published schedule. Self-service needs no scheduling
 * permission: the caller sees only bookings that name the person their
 * login is linked to, and only once they are published.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { ScheduleError, scheduleDatabaseRefusal } from "./errors.ts";
import { requireDate } from "./spans.ts";
import { boardHasCapability } from "./board-types.ts";
import { ENTRY_COLUMNS, ENTRY_JOINS, shapeEntry, type BoardEntry } from "./window.ts";

export interface MySchedule {
  readonly personName: string;
  readonly personPartyId: string;
  readonly from: string;
  readonly through: string;
  readonly entries: readonly BoardEntry[];
  /** Bookings the person may ask to release, change or swap: future, open, on a board whose type takes shift requests. */
  readonly requestableEntryIds: readonly string[];
}

export async function loadMySchedule(input: {
  orgId: string;
  actorId: string;
  from: string;
  through: string;
}): Promise<MySchedule> {
  try {
    return await readMySchedule(input);
  } catch (error) {
    throw scheduleDatabaseRefusal(error);
  }
}

function readMySchedule(input: {
  orgId: string;
  actorId: string;
  from: string;
  through: string;
}): Promise<MySchedule> {
  return withOrgTransaction(input.orgId, async () => {
    const from = requireDate(input.from, "From");
    const through = requireDate(input.through, "Through");
    if (
      !(await lockAndCheckOrgFeature(db, input.orgId, "hrm")) ||
      !(await lockAndCheckOrgFeature(db, input.orgId, "hrmShiftPlanning"))
    )
      throw new ScopeNotFoundError();
    const person = (
      await db.execute<{ partyId: string | null; name: string | null }>(
        sql`select u.party_id as "partyId", p.display_name as name
      from users u left join parties p on p.org_id = u.org_id and p.id = u.party_id
      where u.org_id = ${input.orgId} and u.id = ${input.actorId} and u.is_active`,
        "objects",
      )
    )[0];
    if (!person?.partyId) {
      throw new ScheduleError(
        "Your login is not linked to a person, so there is no schedule to show.",
        {
          code: "schedule_no_person",
          remedy: "Ask an administrator to link your user to your employee record.",
        },
      );
    }
    const rows = await db.execute<Parameters<typeof shapeEntry>[0]>(
      sql`select ${ENTRY_COLUMNS} ${ENTRY_JOINS}
      where e.org_id = ${input.orgId} and e.worker_party_id = ${person.partyId} and e.status = 'published'
        and e.starts_on between ${from} and ${through}
      order by e.starts_at, e.id`,
      "objects",
    );
    const entries = rows.map(shapeEntry);
    const boardIds = [...new Set(entries.map((entry) => entry.boardId))];
    const types = boardIds.length
      ? new Map(
          (
            await db.execute<{ id: string; boardType: string }>(
              sql`select id, board_type as "boardType" from schedule_boards
      where org_id = ${input.orgId} and id = any(${`{${boardIds.join(",")}}`}::uuid[])`,
              "objects",
            )
          ).map((row) => [row.id, row.boardType]),
        )
      : new Map<string, string>();
    const now = Date.now();
    const requestableEntryIds = entries
      .filter(
        (entry) =>
          boardHasCapability({ boardType: types.get(entry.boardId) ?? "" }, "shift_requests") &&
          !entry.closedAt &&
          !entry.openRequest &&
          !entry.removesPredecessor &&
          Date.parse(entry.startsAt) > now,
      )
      .map((entry) => entry.id);
    return {
      personName: person.name ?? "",
      personPartyId: person.partyId,
      from,
      through,
      entries,
      requestableEntryIds,
    };
  });
}

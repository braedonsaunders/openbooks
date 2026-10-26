import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  seedApprovalFlow,
} from "../testing/fixtures.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { installEngineSeams } from "../composition/install.ts";
import { decideGate } from "../flows/gates.ts";
import { applyBoardChanges } from "./entries.ts";
import type { ScheduleNotice } from "./entries.ts";
import { publishScheduleBoard } from "./publications.ts";
import { ScheduleError } from "./errors.ts";
import { registerScheduleNoticeDelivery } from "./distribution-hooks.ts";
import {
  closeAssignment,
  createAssignment,
  generateAssignment,
  listBoardAssignments,
  recordPatternException,
  revokePatternException,
  savePattern,
  type PatternInput,
} from "./pattern-store.ts";
import { loadMySchedule } from "./mine.ts";
import {
  createOwnShiftRequest,
  listBoardShiftRequests,
  listSwapCandidates,
  respondToSwap,
  withdrawOwnShiftRequest,
} from "./requests.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
/** A refusal raised by a database guard arrives as the cause of the query error. */
const refused =
  (pattern: RegExp) =>
  (error: unknown): boolean => {
    for (
      let cause = error as { message?: unknown; cause?: unknown } | undefined;
      cause;
      cause = cause.cause as typeof cause
    ) {
      if (pattern.test(String(cause.message ?? ""))) return true;
    }
    return false;
  };
installEngineSeams();

type Org = Awaited<ReturnType<typeof createScratchOrg>>;
type Fixture = {
  org: Org;
  today: string;
  scheduler: string;
  approver: string;
  anaUser: string;
  benUser: string;
  ana: string;
  ben: string;
  roster: string;
  governed: string;
  people: string;
};

const affected = (result: { rowCount: number | null }, label: string) => {
  if (result.rowCount !== 1) throw new Error(`${label} did not affect one row`);
};

async function role(orgId: string, key: string, permissions: readonly string[]): Promise<void> {
  affected(
    await db.execute<never>(
      sql`update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb where org_id = ${orgId} and key = ${key}`,
    ),
    `${key} permissions`,
  );
}

async function person(
  orgId: string,
  subsidiaryId: string,
  name: string,
  userId?: string,
): Promise<string> {
  const id = randomUUID();
  affected(
    await db.execute<never>(
      sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${id}, ${orgId}, 'person', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`,
    ),
    "person",
  );
  affected(
    await db.execute<never>(
      sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values (${orgId}, ${id}, 'Nurse', '2026-01-01', true)`,
    ),
    "employee role",
  );
  if (userId)
    affected(
      await db.execute<never>(
        sql`update users set party_id = ${id} where org_id = ${orgId} and id = ${userId}`,
      ),
      "user person",
    );
  return id;
}

async function board(
  orgId: string,
  code: string,
  type: "people" | "shift_roster",
  policy: "live" | "staged",
): Promise<string> {
  const id = randomUUID();
  affected(
    await db.execute<never>(sql`insert into schedule_boards (id, org_id, code, name, row_kind, board_type, views, default_view, grain, time_zone, publish_policy)
    values (${id}, ${orgId}, ${code}, ${`Board ${code}`}, 'people', ${type}, '{timeline,grid}', 'timeline', 'timed', 'UTC', ${policy})`),
    "board",
  );
  return id;
}

async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const ids = await withBypassContext(async () => {
      const scheduler = await createScratchUser(org.orgId, "Scheduler", "scheduler");
      const approver = await createScratchUser(org.orgId, "Approver", "approver");
      const anaUser = await createScratchUser(org.orgId, "Ana", "employee");
      const benUser = await createScratchUser(org.orgId, "Ben", "employee");
      await role(org.orgId, "scheduler", [
        "hrm.shifts.read",
        "hrm.shifts.manage",
        "hrm.shifts.approve",
        "hrm.attendance.read",
        "hrm.attendance.manage",
      ]);
      await role(org.orgId, "approver", [
        "hrm.shifts.read",
        "hrm.shifts.manage",
        "hrm.shifts.approve",
      ]);
      await role(org.orgId, "employee", ["hrm.self.read", "hrm.self.request"]);
      affected(
        await db.execute<never>(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
        || '{"hrm":true,"hrmShiftPlanning":true,"hrmAttendance":true,"flows":true}'::jsonb) where id = ${org.orgId}`),
        "features",
      );
      await person(org.orgId, org.subsidiaryId, "Sam Scheduler", scheduler);
      await person(org.orgId, org.subsidiaryId, "Avery Approver", approver);
      const ana = await person(org.orgId, org.subsidiaryId, "Ana Nurse", anaUser);
      const ben = await person(org.orgId, org.subsidiaryId, "Ben Nurse", benUser);
      const today = (
        await db.execute<{ today: string }>(
          sql`select (now() at time zone 'UTC')::date::text as today`,
          "objects",
        )
      )[0]!.today;
      return {
        scheduler,
        approver,
        anaUser,
        benUser,
        ana,
        ben,
        today,
        roster: await board(org.orgId, "WARD", "shift_roster", "live"),
        governed: await board(org.orgId, "ICU", "shift_roster", "staged"),
        people: await board(org.orgId, "FIELD", "people", "live"),
      };
    });
    await run({ org, ...ids });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

const as = (f: Fixture, actorId: string) => ({ orgId: f.org.orgId, actorId });
const daily = (f: Fixture, code: string, overrides: Partial<PatternInput> = {}): PatternInput => ({
  subsidiaryId: f.org.subsidiaryId,
  code,
  name: `Pattern ${code}`,
  description: null,
  timeZone: "UTC",
  cycleDays: 1,
  cycleAnchor: f.today,
  slots: [
    { position: 0, starts: "09:00", ends: "17:00", breakMinutes: 30, qualificationTypeIds: [] },
  ],
  target: null,
  projectTaskId: null,
  departmentId: null,
  detail: "Ward A",
  horizonDays: 7,
  isActive: true,
  reason: "Day shift cover",
  ...overrides,
});
const live = async (f: Fixture, assignmentId: string) =>
  await withBypassContext(() =>
    db.execute<{
      id: string;
      status: string;
      occursOn: string;
      override: boolean;
      startsAt: string;
      revision: number;
      governed: boolean;
    }>(
      sql`
  select id, status, pattern_occurs_on::text as "occursOn", pattern_override as override, revision, governed,
    to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startsAt"
  from schedule_entries where org_id = ${f.org.orgId} and pattern_assignment_id = ${assignmentId} and status <> 'cancelled' order by pattern_occurs_on, status`,
      "objects",
    ),
  );

test(
  "board types fix their row kind and capabilities and refuse retired publication timing",
  enabled,
  async () =>
    fixture(async (f) => {
      await withBypassContext(async () => {
        await assert.rejects(
          withBypassContext(() =>
            db.execute(sql`insert into schedule_boards(id,org_id,code,name,row_kind,board_type,views,default_view,time_zone,publish_policy)
      values(${randomUUID()},${f.org.orgId},'BAD','Unsupported publication policy','people','people','{grid}','grid','UTC','governed')`),
          ),
          refused(/schedule_boards_(?:publish_policy_check|governed_from)/),
        );
        await assert.rejects(
          db.execute(
            sql`update schedule_boards set board_type = 'people' where org_id = ${f.org.orgId} and id = ${f.roster}`,
          ),
          refused(/keeps its type/),
        );
        const standard = randomUUID();
        affected(
          await db.execute<never>(sql`insert into schedule_boards (id, org_id, code, name, row_kind, views, default_view, time_zone)
      values (${standard}, ${f.org.orgId}, 'PLAIN', 'Plain', 'people', '{grid}', 'grid', 'UTC')`),
          "standard board",
        );
        const type = (
          await db.execute<{ boardType: string }>(
            sql`select board_type as "boardType" from schedule_boards where org_id = ${f.org.orgId} and id = ${standard}`,
            "objects",
          )
        )[0];
        assert.equal(
          type?.boardType,
          "people",
          "a board created without a type keeps its row kind's standard type",
        );
      });
      const pattern = await savePattern(as(f, f.scheduler), daily(f, "DAY"));
      await assert.rejects(
        createAssignment({
          ...as(f, f.scheduler),
          id: randomUUID(),
          boardId: f.people,
          patternId: pattern.id,
          workerPartyId: f.ana,
          effectiveFrom: addCalendarDays(f.today, 1),
          effectiveTo: null,
          reason: "Cover",
        }),
        (error: unknown) =>
          error instanceof ScheduleError && error.code === "schedule_capability_unavailable",
      );
    }),
);

test(
  "pattern generation is idempotent, keeps manual changes and honours omissions and assignment ends",
  enabled,
  async () =>
    fixture(async (f) => {
      const scheduler = as(f, f.scheduler);
      const pattern = await savePattern(scheduler, daily(f, "DAY"));
      const key = randomUUID();
      const start = addCalendarDays(f.today, 1);
      const created = await createAssignment({
        ...scheduler,
        id: key,
        boardId: f.roster,
        patternId: pattern.id,
        workerPartyId: f.ana,
        effectiveFrom: start,
        effectiveTo: null,
        reason: "Ana covers days",
      });
      assert.equal(
        created.generation.created,
        6,
        "the horizon from today holds six future occurrences",
      );
      assert.deepEqual(created.generation.failures, []);
      const replay = await createAssignment({
        ...scheduler,
        id: key,
        boardId: f.roster,
        patternId: pattern.id,
        workerPartyId: f.ana,
        effectiveFrom: start,
        effectiveTo: null,
        reason: "Ana covers days",
      });
      assert.equal(replay.assignment.id, key, "the request key replays the same assignment");
      const again = await generateAssignment({ ...scheduler, assignmentId: key });
      assert.deepEqual(
        [again.created, again.revised, again.removed, again.unchanged],
        [0, 0, 0, 6],
      );
      const bookings = await live(f, key);
      assert.ok(bookings.every((row) => row.status === "published"));
      assert.equal(bookings[0]!.startsAt, `${start}T09:00:00.000Z`);

      // A manual change on the board is kept by regeneration.
      const moved = await applyBoardChanges({
        ...scheduler,
        boardId: f.roster,
        changes: [
          {
            op: "update",
            id: bookings[0]!.id,
            expectedRevision: bookings[0]!.revision,
            fields: { span: { mode: "timed", starts: "10:00", ends: "18:00", breakMinutes: 30 } },
          },
        ],
      });
      assert.equal(moved.results[0]?.ok, true);
      // Removing a published occurrence on the board records an omission.
      await applyBoardChanges({
        ...scheduler,
        boardId: f.roster,
        changes: [{ op: "cancel", id: bookings[1]!.id, expectedRevision: bookings[1]!.revision }],
      });
      // A pattern revision changes only future generated bookings.
      await savePattern(scheduler, {
        ...daily(f, "DAY", {
          slots: [
            {
              position: 0,
              starts: "08:00",
              ends: "16:00",
              breakMinutes: 30,
              qualificationTypeIds: [],
            },
          ],
        }),
        id: pattern.id,
        expectedRevision: pattern.record.revision,
      } as never);
      const revised = await generateAssignment({ ...scheduler, assignmentId: key });
      assert.deepEqual([revised.created, revised.revised, revised.kept], [0, 4, 1]);
      const after = await live(f, key);
      assert.equal(after.length, 5);
      assert.equal(after[0]!.override, true);
      assert.equal(after[0]!.startsAt, `${start}T10:00:00.000Z`);
      assert.ok(
        !after.some((row) => row.occursOn === addCalendarDays(start, 1)),
        "the omitted occurrence is not booked again",
      );
      assert.equal(after[1]!.startsAt, `${addCalendarDays(start, 2)}T08:00:00.000Z`);

      // Revoking the omission books the occurrence again; ending the assignment removes the future.
      const omission = (await listBoardAssignments({ ...scheduler, boardId: f.roster }))[0]!
        .exceptions[0]!;
      const restored = await revokePatternException({
        ...scheduler,
        exceptionId: omission.id,
        reason: "Cover restored",
      });
      assert.equal(restored.generation.created, 1);
      const assignment = restored.assignment;
      const ended = await closeAssignment({
        ...scheduler,
        assignmentId: key,
        expectedRevision: assignment.revision,
        action: "end",
        effectiveTo: addCalendarDays(start, 3),
        reason: "Rotation ends",
      });
      assert.equal(ended.generation.removed, 3, JSON.stringify(ended.generation));
      assert.deepEqual(
        (await live(f, key)).map((row) => row.occursOn),
        [start, addCalendarDays(start, 1), addCalendarDays(start, 2)],
      );
      const omitted = await recordPatternException({
        ...scheduler,
        assignmentId: key,
        occursOn: addCalendarDays(start, 2),
        slotIndex: 0,
        kind: "omit",
        reason: "Ward closed",
      });
      assert.equal(omitted.generation.removed, 1);
    }),
);

const gate = async (f: Fixture, subjectKind: string, subjectId: string) =>
  (
    await withBypassContext(() =>
      db.execute<{ id: string }>(
        sql`select id from flow_gates
  where org_id = ${f.org.orgId} and subject_kind = ${subjectKind} and subject_id = ${subjectId} and status = 'pending'`,
        "objects",
      ),
    )
  )[0]?.id;
const decide = (
  f: Fixture,
  gateId: string,
  userId: string,
  decision: "approved" | "rejected",
  comment: string,
) => withOrgContext(f.org.orgId, () => decideGate({ gateId, decision, userId, comment }));

test(
  "without a Flow a governed publication applies at once, records that no approval applied and keeps published history immutable",
  enabled,
  async () =>
    fixture(async (f) => {
      const scheduler = as(f, f.scheduler);
      const pattern = await savePattern(scheduler, daily(f, "ICU", { horizonDays: 3 }));
      const key = randomUUID();
      const start = addCalendarDays(f.today, 1);
      const created = await createAssignment({
        ...scheduler,
        id: key,
        boardId: f.governed,
        patternId: pattern.id,
        workerPartyId: f.ana,
        effectiveFrom: start,
        effectiveTo: null,
        reason: "ICU rotation",
      });
      assert.equal(created.generation.created, 2);
      assert.ok((await live(f, key)).every((row) => row.status === "draft" && row.governed));
      await assert.rejects(
        publishScheduleBoard({
          ...as(f, f.anaUser),
          boardId: f.governed,
          from: start,
          through: addCalendarDays(start, 7),
        }),
        (error: unknown) => error instanceof ScopeNotFoundError,
        "publishing still needs the publish permission",
      );
      const published = await publishScheduleBoard({
        ...scheduler,
        boardId: f.governed,
        from: start,
        through: addCalendarDays(start, 7),
      });
      assert.deepEqual([published.published, published.pending], [2, false]);
      const record = (
        await withBypassContext(() =>
          db.execute<{
            status: string;
            released: boolean;
            decidedBy: string | null;
            reason: string;
          }>(
            sql`select status,
    released_without_approval as released, decided_by as "decidedBy", decision_reason as reason from schedule_publications where org_id = ${f.org.orgId} and id = ${published.publicationId}`,
            "objects",
          ),
        )
      )[0];
      assert.deepEqual(record, {
        status: "approved",
        released: true,
        decidedBy: null,
        reason: "No approval Flow applied; released when submitted.",
      });
      await assert.rejects(
        publishScheduleBoard({ ...scheduler, boardId: f.governed, from: start, through: start }),
        (error: unknown) =>
          error instanceof ScheduleError && error.code === "schedule_nothing_to_publish",
      );
      const [first] = await live(f, key);
      // A governed booking's notes and removal are revisions that are published.
      const notes = await applyBoardChanges({
        ...scheduler,
        boardId: f.governed,
        changes: [
          {
            op: "update",
            id: first!.id,
            expectedRevision: first!.revision,
            fields: { notes: "Bring badge" },
          },
        ],
      });
      assert.ok(
        notes.results[0]?.ok && notes.results[0].replacedId === first!.id,
        "a governed booking's notes change through a revision",
      );
      await assert.rejects(
        withBypassContext(() =>
          db.execute(
            sql`update schedule_entries set notes = 'direct', revision = revision + 1, updated_by = ${f.scheduler} where org_id = ${f.org.orgId} and id = ${first!.id}`,
          ),
        ),
        refused(/immutable history/),
      );
      await applyBoardChanges({
        ...scheduler,
        boardId: f.governed,
        changes: [
          {
            op: "cancel",
            id: notes.results[0]!.ok ? notes.results[0]!.entry!.id : "",
            expectedRevision: 1,
          },
        ],
      });
      const removal = await applyBoardChanges({
        ...scheduler,
        boardId: f.governed,
        changes: [{ op: "cancel", id: first!.id, expectedRevision: first!.revision }],
      });
      assert.ok(
        removal.results[0]?.ok && removal.results[0].entry?.removesPredecessor,
        "removing a governed booking records a removal revision",
      );
      assert.equal(
        (await live(f, key)).find((row) => row.id === first!.id)?.status,
        "published",
        "the booking stays published until the removal is published",
      );
      await publishScheduleBoard({
        ...scheduler,
        boardId: f.governed,
        from: start,
        through: start,
      });
      assert.ok(!(await live(f, key)).some((row) => row.id === first!.id));
    }),
);

test(
  "a Schedule publication Flow owns governed publishing: the changes wait, the submitter cannot decide, and the decider publishes exactly what was submitted",
  enabled,
  async () =>
    fixture(async (f) => {
      const scheduler = as(f, f.scheduler);
      const delivered: ScheduleNotice[][] = [];
      registerScheduleNoticeDelivery(async ({ notices }) => {
        delivered.push([...notices]);
      });
      await withBypassContext(() =>
        db.execute(
          sql`update schedule_boards set notify_assignees = true where org_id = ${f.org.orgId} and id = ${f.governed}`,
        ),
      );
      await withBypassContext(() =>
        seedApprovalFlow(f.org.orgId, {
          subjectKind: "schedule_publication",
          assignees: [
            { type: "user", userId: f.approver },
            { type: "user", userId: f.scheduler },
          ],
          mode: "any",
        }),
      );
      const pattern = await savePattern(scheduler, daily(f, "ICU", { horizonDays: 3 }));
      const key = randomUUID();
      const start = addCalendarDays(f.today, 1);
      await createAssignment({
        ...scheduler,
        id: key,
        boardId: f.governed,
        patternId: pattern.id,
        workerPartyId: f.ana,
        effectiveFrom: start,
        effectiveTo: null,
        reason: "ICU rotation",
      });
      const first = await publishScheduleBoard({
        ...scheduler,
        boardId: f.governed,
        from: start,
        through: addCalendarDays(start, 7),
      });
      assert.deepEqual([first.pending, first.published], [true, 0]);
      const replay = await publishScheduleBoard({
        ...scheduler,
        boardId: f.governed,
        from: start,
        through: addCalendarDays(start, 7),
      });
      assert.deepEqual(
        [replay.publicationId, replay.pending],
        [first.publicationId, true],
        "the same publication request retains its original submission",
      );
      const [draft] = await live(f, key);
      const edit = await applyBoardChanges({
        ...scheduler,
        boardId: f.governed,
        changes: [
          {
            op: "update",
            id: draft!.id,
            expectedRevision: draft!.revision,
            fields: { notes: "late change" },
          },
        ],
      });
      assert.equal(
        edit.results[0]?.ok,
        false,
        "a submitted change cannot be edited while its publication waits",
      );
      const pendingGate = (await gate(f, "schedule_publication", first.publicationId!))!;
      await assert.rejects(
        decide(f, pendingGate, f.scheduler, "approved", "Mine"),
        "the submitter may not decide their own publication",
      );
      await decide(f, pendingGate, f.approver, "rejected", "Staffing too thin");
      assert.ok(
        (await live(f, key)).every((row) => row.status === "draft"),
        "a declined publication publishes nothing",
      );
      const second = await publishScheduleBoard({
        ...scheduler,
        boardId: f.governed,
        from: start,
        through: addCalendarDays(start, 7),
      });
      await decide(
        f,
        (await gate(f, "schedule_publication", second.publicationId!))!,
        f.approver,
        "approved",
        "Covered",
      );
      assert.ok((await live(f, key)).every((row) => row.status === "published"));
      assert.equal(delivered.length, 1, "only the approved publication delivers notices");
      assert.ok(
        delivered[0]!.some(
          (notice) => notice.workerPartyId === f.ana && notice.change === "booked",
        ),
      );
      const decided = (
        await withBypassContext(() =>
          db.execute<{ decidedBy: string; released: boolean }>(
            sql`select decided_by as "decidedBy", released_without_approval as released
    from schedule_publications where org_id = ${f.org.orgId} and id = ${second.publicationId}`,
            "objects",
          ),
        )
      )[0];
      assert.deepEqual(decided, { decidedBy: f.approver, released: false });
    }),
);

test(
  "without a Flow employee releases, changes and swaps apply when submitted and record that no approval applied",
  enabled,
  async () =>
    fixture(async (f) => {
      const scheduler = as(f, f.scheduler),
        ana = as(f, f.anaUser),
        ben = as(f, f.benUser);
      const start = addCalendarDays(f.today, 2);
      const book = async (workerPartyId: string, onDate: string, starts: string, ends: string) => {
        const id = randomUUID();
        const result = await applyBoardChanges({
          ...scheduler,
          boardId: f.roster,
          changes: [
            {
              op: "create",
              id,
              workerPartyId,
              onDate,
              target: null,
              span: { mode: "timed", starts, ends, breakMinutes: 30 },
            },
          ],
        });
        assert.equal(result.results[0]?.ok, true);
        return id;
      };
      const anaShift = await book(f.ana, start, "09:00", "17:00");
      const benShift = await book(f.ben, addCalendarDays(start, 1), "07:00", "15:00");
      const anaLater = await book(f.ana, addCalendarDays(start, 3), "09:00", "17:00");
      const anaRelease = await book(f.ana, addCalendarDays(start, 5), "09:00", "17:00");
      const fieldDay = randomUUID();
      assert.equal(
        (
          await applyBoardChanges({
            ...scheduler,
            boardId: f.people,
            changes: [
              {
                op: "create",
                id: fieldDay,
                workerPartyId: f.ana,
                onDate: addCalendarDays(start, 6),
                target: null,
                span: { mode: "timed", starts: "09:00", ends: "17:00", breakMinutes: 30 },
              },
            ],
          })
        ).results[0]?.ok,
        true,
      );
      // My schedule offers requests only on boards whose type takes them.
      const mine = await loadMySchedule({
        ...ana,
        from: f.today,
        through: addCalendarDays(start, 7),
      });
      assert.deepEqual(
        new Set(mine.requestableEntryIds),
        new Set([anaShift, anaLater, anaRelease]),
      );
      assert.ok(
        mine.entries.some((entry) => entry.id === fieldDay),
        "the people-board booking still shows on My schedule",
      );
      await assert.rejects(
        createOwnShiftRequest({
          ...ana,
          id: randomUUID(),
          entryId: fieldDay,
          expectedRevision: await entryRevision(f.org.orgId, fieldDay),
          kind: "release",
          reason: "Not a roster",
        }),
        refused(/cannot be requested/),
      );
      await assert.rejects(
        createOwnShiftRequest({
          ...ben,
          id: randomUUID(),
          entryId: anaShift,
          expectedRevision: await entryRevision(f.org.orgId, anaShift),
          kind: "release",
          reason: "Not mine",
        }),
        (error: unknown) => error instanceof ScopeNotFoundError,
      );
      const change = await createOwnShiftRequest({
        ...ana,
        id: randomUUID(),
        entryId: anaShift,
        expectedRevision: await entryRevision(f.org.orgId, anaShift),
        kind: "change",
        change: { starts: "11:00", ends: "19:00", breakMinutes: 30 },
        reason: "Appointment",
      });
      assert.deepEqual(
        [
          change.request.status,
          change.request.releasedWithoutApproval,
          change.request.decisionReason,
        ],
        ["approved", true, "No approval Flow applied; applied when submitted."],
      );
      const changed = await withBypassContext(() =>
        db.execute<{ startsAt: string; origin: string | null }>(
          sql`select to_char(starts_at at time zone 'UTC', 'HH24:MI') as "startsAt", origin_request_id as origin
    from schedule_entries where org_id = ${f.org.orgId} and supersedes_id = ${anaShift} and status = 'published'`,
          "objects",
        ),
      );
      assert.deepEqual(changed, [{ startsAt: "11:00", origin: change.request.id }]);
      const afterChange = await loadMySchedule({
        ...ana,
        from: f.today,
        through: addCalendarDays(start, 7),
      });
      assert.ok(
        !afterChange.requestableEntryIds.includes(anaShift) &&
          afterChange.entries.every((entry) => entry.id !== anaShift),
        "the replaced shift is no longer offered",
      );
      const released = await createOwnShiftRequest({
        ...ana,
        id: randomUUID(),
        entryId: anaRelease,
        expectedRevision: await entryRevision(f.org.orgId, anaRelease),
        kind: "release",
        reason: "Sick child",
      });
      assert.equal(released.request.status, "approved");
      assert.equal(
        (
          await withBypassContext(() =>
            db.execute<{ status: string }>(
              sql`select status from schedule_entries where org_id = ${f.org.orgId} and id = ${anaRelease}`,
              "objects",
            ),
          )
        )[0]?.status,
        "cancelled",
      );
      // A swap waits for the colleague and applies when they accept.
      const candidates = await listSwapCandidates({ ...ana, entryId: anaLater });
      assert.ok(candidates.some((candidate) => candidate.entryId === benShift));
      const swap = await createOwnShiftRequest({
        ...ana,
        id: randomUUID(),
        entryId: anaLater,
        expectedRevision: await entryRevision(f.org.orgId, anaLater),
        kind: "swap",
        counterpartEntryId: benShift,
        counterpartRevision: await entryRevision(f.org.orgId, benShift),
        reason: "Trade days",
      });
      assert.equal(swap.request.status, "awaiting_counterpart");
      const accepted = await respondToSwap({
        ...ben,
        requestId: swap.request.id,
        expectedRevision: swap.request.revision,
        accept: true,
        reason: "Happy to",
      });
      assert.equal(accepted.request.status, "approved");
      const exchanged = await withBypassContext(() =>
        db.execute<{ worker: string; supersedes: string }>(
          sql`select worker_party_id as worker, supersedes_id as supersedes from schedule_entries
    where org_id = ${f.org.orgId} and origin_request_id = ${swap.request.id} and status = 'published' order by supersedes_id`,
          "objects",
        ),
      );
      assert.deepEqual(
        new Map(exchanged.map((row) => [row.supersedes, row.worker])),
        new Map([
          [anaLater, f.ben],
          [benShift, f.ana],
        ]),
      );
    }),
);

test(
  "a Shift request Flow owns the decision: the requester cannot decide, concurrent decisions apply once",
  enabled,
  async () =>
    fixture(async (f) => {
      const scheduler = as(f, f.scheduler),
        ana = as(f, f.anaUser);
      const delivered: ScheduleNotice[][] = [];
      registerScheduleNoticeDelivery(async ({ notices }) => {
        delivered.push([...notices]);
      });
      await withBypassContext(async () => {
        await db.execute(
          sql`update schedule_boards set notify_assignees = true where org_id = ${f.org.orgId} and id = ${f.roster}`,
        );
        const graph = {
          schemaVersion: 1,
          nodes: [
            {
              id: "trigger",
              position: { x: 0, y: 0 },
              data: { kind: "trigger", trigger: { trigger: "on_update" } },
            },
            {
              id: "email",
              position: { x: 200, y: 0 },
              data: { kind: "action", action: { action: "distribute_schedule" } },
            },
          ],
          edges: [{ id: "next", source: "trigger", target: "email", sourceHandle: "next" }],
        };
        await db.execute(
          sql`insert into flows(org_id,name,subject_kind,enabled,graph) values(${f.org.orgId},'Roster update','schedule_distribution',true,${JSON.stringify(graph)}::jsonb)`,
        );
      });
      await withBypassContext(() =>
        seedApprovalFlow(f.org.orgId, {
          subjectKind: "schedule_entry_request",
          assignees: [
            { type: "user", userId: f.approver },
            { type: "user", userId: f.scheduler },
            { type: "user", userId: f.anaUser },
          ],
          mode: "any",
        }),
      );
      const id = randomUUID();
      await applyBoardChanges({
        ...scheduler,
        boardId: f.roster,
        changes: [
          {
            op: "create",
            id,
            workerPartyId: f.ana,
            onDate: addCalendarDays(f.today, 2),
            target: null,
            span: { mode: "timed", starts: "09:00", ends: "17:00", breakMinutes: 30 },
          },
        ],
      });
      const submitted = await createOwnShiftRequest({
        ...ana,
        id: randomUUID(),
        entryId: id,
        expectedRevision: await entryRevision(f.org.orgId, id),
        kind: "release",
        reason: "Course",
      });
      assert.deepEqual([submitted.request.status, submitted.request.flowGated], ["pending", true]);
      await assert.rejects(
        withdrawOwnShiftRequest({
          ...ana,
          requestId: submitted.request.id,
          expectedRevision: submitted.request.revision,
        }),
        /with its approval Flow/,
      );
      const pendingGate = (await gate(f, "schedule_entry_request", submitted.request.id))!;
      await assert.rejects(
        decide(f, pendingGate, f.anaUser, "approved", "Mine"),
        "the requester may not decide their own request",
      );
      const outcomes = await Promise.allSettled([
        decide(f, pendingGate, f.approver, "approved", "Enjoy the course"),
        decide(f, pendingGate, f.scheduler, "approved", "Fine"),
      ]);
      assert.equal(
        outcomes.filter((outcome) => outcome.status === "fulfilled").length,
        1,
        "one decision resolves the gate",
      );
      const status = await withBypassContext(() =>
        db.execute<{ request: string; entry: string; released: boolean }>(
          sql`select r.status as request, e.status as entry,
    r.released_without_approval as released from schedule_entry_requests r join schedule_entries e on e.org_id = r.org_id and e.id = r.entry_id
    where r.org_id = ${f.org.orgId} and r.id = ${submitted.request.id}`,
          "objects",
        ),
      );
      assert.deepEqual(status[0], { request: "approved", entry: "cancelled", released: false });
      assert.equal(delivered.length, 1, "the approved release delivers its assignee notice once");
      assert.ok(
        delivered[0]!.some(
          (notice) => notice.workerPartyId === f.ana && notice.change === "removed",
        ),
      );
      const distributionRuns = await withBypassContext(() =>
        db.execute<{ n: number }>(
          sql`select count(*)::int as n from flow_runs where org_id = ${f.org.orgId} and subject_kind = 'schedule_distribution'`,
          "objects",
        ),
      );
      assert.ok(
        distributionRuns[0]!.n > 0,
        "an approved shift request fires the on_update schedule distribution Flow",
      );
      assert.deepEqual(
        (await listBoardShiftRequests({ ...scheduler, boardId: f.roster, status: "open" })).map(
          (request) => request.id,
        ),
        [],
      );
    }),
);

test("roster records stay inside their organization", enabled, async () =>
  fixture(async (f) => {
    const pattern = await savePattern(as(f, f.scheduler), daily(f, "ISO"));
    const key = randomUUID();
    await createAssignment({
      ...as(f, f.scheduler),
      id: key,
      boardId: f.roster,
      patternId: pattern.id,
      workerPartyId: f.ana,
      effectiveFrom: addCalendarDays(f.today, 1),
      effectiveTo: null,
      reason: "Cover",
    });
    const other = await withBypassContext(() => createScratchOrg());
    try {
      const stranger = await withBypassContext(async () => {
        const user = await createScratchUser(other.orgId, "Stranger", "scheduler");
        await role(other.orgId, "scheduler", [
          "hrm.shifts.read",
          "hrm.shifts.manage",
          "hrm.shifts.approve",
        ]);
        affected(
          await db.execute<never>(
            sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"hrm":true,"hrmShiftPlanning":true}'::jsonb) where id = ${other.orgId}`,
          ),
          "features",
        );
        return user;
      });
      await assert.rejects(
        generateAssignment({ orgId: other.orgId, actorId: stranger, assignmentId: key }),
        (error: unknown) => error instanceof ScopeNotFoundError,
      );
      await assert.rejects(
        listBoardAssignments({ orgId: other.orgId, actorId: stranger, boardId: f.roster }),
        (error: unknown) => error instanceof ScopeNotFoundError,
      );
      const visible = await withBypassContext(() =>
        db.execute<{ n: number }>(
          sql`select count(*)::int as n from schedule_pattern_assignments where org_id = ${other.orgId}`,
          "objects",
        ),
      );
      assert.equal(visible[0]!.n, 0);
    } finally {
      await dropScratchOrgReporting(other.orgId);
    }
  }),
);

test("live and staged publication both wait for every tenant Flow gate", enabled, async () =>
  fixture(async (f) => {
    const { seedApprovalFlow } = await import("../testing/fixtures.ts");
    const { decideGate } = await import("../flows/gates.ts");
    for (let index = 0; index < 10; index++)
      await withBypassContext(() =>
        seedApprovalFlow(f.org.orgId, {
          subjectKind: "schedule_publication",
          assignees: [{ type: "user", userId: f.approver }],
          mode: "all",
        }),
      );
    for (const [index, boardId] of [f.roster, f.governed].entries()) {
      const id = randomUUID(),
        onDate = addCalendarDays(f.today, 3 + index);
      const saved = await applyBoardChanges({
        ...as(f, f.scheduler),
        boardId,
        changes: [
          {
            op: "create",
            id,
            workerPartyId: f.ana,
            onDate,
            target: null,
            span: { mode: "timed", starts: "09:00", ends: "17:00", breakMinutes: 30 },
          },
        ],
      });
      assert.equal(saved.results[0]?.ok, true);
      if (index === 1) {
        const submitted = await publishScheduleBoard({
          ...as(f, f.scheduler),
          boardId,
          from: onDate,
          through: onDate,
        });
        assert.equal(submitted.pending, true);
      }
      const gates = await withBypassContext(() =>
        db.execute<{ id: string }>(
          sql`select g.id from schedule_publications p join flow_gates g on g.org_id=p.org_id and g.subject_kind='schedule_publication' and g.subject_id=p.id
      where p.org_id=${f.org.orgId} and ${id}::uuid=any(p.entry_ids) and g.status='pending' order by g.id`,
          "objects",
        ),
      );
      assert.equal(gates.length, 10);
      for (let gateIndex = 0; gateIndex < gates.length; gateIndex++) {
        const before = (
          await withBypassContext(() =>
            db.execute<{ status: string }>(
              sql`select status from schedule_entries where org_id=${f.org.orgId} and id=${id}`,
              "objects",
            ),
          )
        )[0];
        assert.equal(
          before?.status,
          "draft",
          "no publication timing can release before the final tenant decision",
        );
        await decideGate({
          gateId: gates[gateIndex]!.id,
          decision: "approved",
          userId: f.approver,
        });
      }
      assert.equal(
        (
          await withBypassContext(() =>
            db.execute<{ status: string }>(
              sql`select status from schedule_entries where org_id=${f.org.orgId} and id=${id}`,
              "objects",
            ),
          )
        )[0]?.status,
        "published",
      );
    }
  }),
);

async function entryRevision(orgId: string, id: string) {
  return (
    await db.execute<{ revision: number }>(
      sql`select revision from schedule_entries where org_id=${orgId} and id=${id}`,
      "objects",
    )
  )[0]!.revision;
}

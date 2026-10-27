import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SqlExecutor } from "../platform/db.ts";
import { drizzleSqlText as sqlText } from "../testing/sql-text.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { listOrgLeaveRequests } from "./leave-read.ts";

type FakeOptions = {
  permission: boolean;
  rows?: Record<string, unknown>[];
  statements: string[];
};

function fakeExec(options: FakeOptions): SqlExecutor {
  return {
    execute: (async (query: unknown, mode?: string) => {
      const inMode = <T extends { rows: unknown }>(result: T) =>
        mode === "objects" ? result.rows : result;
      const text = sqlText(query);
      options.statements.push(text);
      if (/from users/i.test(text))
        return inMode({ rows: [{ isSuperAdmin: false, isActive: true }] });
      if (/select role\.permissions/i.test(text)) {
        return inMode({ rows: [{ permissions: options.permission ? ["hrm.leave.read"] : [] }] });
      }
      if (/from user_permission_overrides/i.test(text)) return inMode({ rows: [] });
      if (/subsidiary_restriction as restriction/i.test(text)) {
        return inMode({ rows: [{ restriction: { mode: "all" } }] });
      }
      if (/from hrm_leave_requests/i.test(text)) return inMode({ rows: options.rows ?? [] });
      throw new Error(`fake leave-list executor has no route for ${text.slice(0, 140)}`);
    }) as SqlExecutor["execute"],
  };
}

function requestRow(id: string, startsOn: string): Record<string, unknown> {
  return {
    id,
    employment_id: randomUUID(),
    worker_party_id: randomUUID(),
    leave_type_id: randomUUID(),
    leave_type_code: "VAC",
    starts_on: startsOn,
    ends_on: startsOn,
    hours: "8.0000",
    reason: null,
    status: "submitted",
    decided_by: null,
    decided_at: null,
    decision_reason: null,
  };
}

test("org leave list uses one bounded scoped request query", async () => {
  const statements: string[] = [];
  const first = randomUUID();
  const second = randomUUID();
  const result = await listOrgLeaveRequests(
    fakeExec({
      permission: true,
      statements,
      rows: [requestRow(first, "2026-09-02"), requestRow(second, "2026-09-01")],
    }),
    randomUUID(),
    randomUUID(),
    { status: "submitted", limit: 1 },
  );

  assert.deepEqual(
    result.requests.map((row) => row.id),
    [first],
  );
  assert.equal(result.truncated, true);
  const requestStatements = statements.filter((text) => /from hrm_leave_requests/i.test(text));
  assert.equal(requestStatements.length, 1, "the queue never queries once per employment");
  assert.match(requestStatements[0]!, /e\.employer_subsidiary_id/i);
  assert.match(requestStatements[0]!, /limit/i);
});

test("org leave list maps recorded days beside requests in the same statement", async () => {
  const statements: string[] = [];
  const absenceId = randomUUID();
  const result = await listOrgLeaveRequests(
    fakeExec({
      permission: true,
      statements,
      rows: [
        { ...requestRow(randomUUID(), "2026-09-05"), status: "draft" },
        {
          ...requestRow(randomUUID(), "2026-08-03"),
          status: "recorded",
          source: "recorded",
          absence_id: absenceId,
          reason: "approved verbally by the owner",
          decided_by: null,
          decided_at: null,
          decision_reason: null,
        },
      ],
    }),
    randomUUID(),
    randomUUID(),
    {},
  );

  assert.equal(result.requests.length, 2);
  const day = result.requests.find((row) => row.source === "recorded")!;
  assert.equal(day.status, "recorded");
  assert.equal(day.absenceId, absenceId);
  assert.equal(day.startsOn, "2026-08-03");
  assert.equal(day.endsOn, "2026-08-03");
  assert.equal(day.reason, "approved verbally by the owner");
  assert.equal(result.requests.find((row) => row.source === "request")?.absenceId, null);
  const requestStatements = statements.filter((text) => /from hrm_leave_requests/i.test(text));
  assert.equal(
    requestStatements.length,
    1,
    "recorded days ride the same statement, never a second list",
  );
  assert.match(requestStatements[0]!, /union all/i);
  assert.match(requestStatements[0]!, /hrm_absences/i);
});

test("org leave list refuses a missing read grant before querying requests", async () => {
  const statements: string[] = [];
  await assert.rejects(
    listOrgLeaveRequests(fakeExec({ permission: false, statements }), randomUUID(), randomUUID()),
    (error: unknown) =>
      error instanceof HrmAuthorizationError && /hrm\.leave\.read/.test(error.message),
  );
  assert.equal(
    statements.some((text) => /from hrm_leave_requests/i.test(text)),
    false,
  );
});

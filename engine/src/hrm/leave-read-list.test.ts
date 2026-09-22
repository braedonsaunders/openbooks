import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SqlExecutor } from "../platform/db.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { listOrgLeaveRequests } from "./leave-read.ts";

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  let out = "";
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object" && Array.isArray((chunk as { value?: unknown }).value)) {
      out += ((chunk as { value: string[] }).value).join("");
    }
  }
  return out;
}

type FakeOptions = {
  permission: boolean;
  rows?: Record<string, unknown>[];
  statements: string[];
};

function fakeExec(options: FakeOptions): SqlExecutor {
  return {
    execute: (async (query: unknown) => {
      const text = sqlText(query);
      options.statements.push(text);
      if (/from users/i.test(text)) return { rows: [{ isSuperAdmin: false, isActive: true }] };
      if (/select role\.permissions/i.test(text)) {
        return { rows: [{ permissions: options.permission ? ["hrm.leave.read"] : [] }] };
      }
      if (/from user_permission_overrides/i.test(text)) return { rows: [] };
      if (/subsidiary_restriction as restriction/i.test(text)) {
        return { rows: [{ restriction: { mode: "all" } }] };
      }
      if (/from hrm_leave_requests/i.test(text)) return { rows: options.rows ?? [] };
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

  assert.deepEqual(result.requests.map((row) => row.id), [first]);
  assert.equal(result.truncated, true);
  const requestStatements = statements.filter((text) => /from hrm_leave_requests/i.test(text));
  assert.equal(requestStatements.length, 1, "the queue never queries once per employment");
  assert.match(requestStatements[0]!, /e\.employer_subsidiary_id/i);
  assert.match(requestStatements[0]!, /limit/i);
});

test("org leave list refuses a missing read grant before querying requests", async () => {
  const statements: string[] = [];
  await assert.rejects(
    listOrgLeaveRequests(
      fakeExec({ permission: false, statements }),
      randomUUID(),
      randomUUID(),
    ),
    (error: unknown) => error instanceof HrmAuthorizationError && /hrm\.leave\.read/.test(error.message),
  );
  assert.equal(statements.some((text) => /from hrm_leave_requests/i.test(text)), false);
});

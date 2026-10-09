import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { payrollEmploymentOverlapsPeriod, payrollEpisodeDate } from "./employment-roster.ts";

const ORG = "10000000-0000-4000-8000-000000000001";
const EMPLOYEE = "10000000-0000-4000-8000-000000000002";
const EMPLOYMENT = "10000000-0000-4000-8000-000000000003";
const EMPLOYER = "10000000-0000-4000-8000-000000000004";
const OTHER = "10000000-0000-4000-8000-000000000005";

test("dated roster coverage respects exclusive windows, recorded history and exact legal employment without inventing episode dates", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const baseline = { org: ORG, employee: EMPLOYEE, employment: EMPLOYMENT, employer: EMPLOYER,
    status: "active", from: "2026-01-23", to: "2026-01-24" as string | null,
    recordedUntil: null as string | null, hiredOn: "2026-04-20" as string | null,
    terminatedOn: "2026-05-08" as string | null };
  const cases = [
    { changes: {}, expected: true },
    { changes: { status: "on_leave" }, expected: true },
    { changes: { status: "terminated" }, expected: false },
    { changes: { status: "pending" }, expected: false },
    { changes: { org: OTHER }, expected: false },
    { changes: { employee: OTHER }, expected: false },
    { changes: { employer: OTHER }, expected: false },
    { changes: { employment: OTHER }, expected: false },
    { changes: { recordedUntil: "2026-10-09T00:00:00Z" }, expected: false },
    { changes: { from: "2026-01-25", to: null }, expected: false },
    { changes: { from: "2026-01-01", to: "2026-01-18" }, expected: false },
    { changes: { from: "2026-01-01", to: "2026-01-19" }, expected: true },
    { changes: { from: "2026-01-24", to: "2026-01-25" }, expected: true },
    { changes: { hiredOn: "2025-05-05", status: "terminated" }, expected: true },
    { changes: { hiredOn: null, terminatedOn: null, status: "terminated" }, expected: true },
    { changes: { hiredOn: "2025-05-05", terminatedOn: "2026-01-17", status: "terminated" }, expected: false },
  ];
  for (const example of cases) {
    const v = { ...baseline, ...example.changes };
    const columns = { org: sql`${ORG}::uuid`, employee: sql`${EMPLOYEE}::uuid`, employment: sql`${EMPLOYMENT}::uuid`,
      employer: sql`${EMPLOYER}::uuid`, hiredOn: sql`${v.hiredOn}::date`, terminatedOn: sql`${v.terminatedOn}::date`,
      periodStart: sql`'2026-01-18'::date`, periodEnd: sql`'2026-01-24'::date` };
    const result = (await db.execute<{ included: boolean; hired_on: string | null; terminated_on: string | null }>(sql`
      with worker_employments as (
        select ${v.org}::uuid as org_id, ${v.employment}::uuid as id,
               ${v.employee}::uuid as worker_party_id, ${v.employer}::uuid as employer_subsidiary_id
      ), worker_employment_versions as (
        select ${v.org}::uuid as org_id, ${v.employment}::uuid as employment_id, ${v.status}::text as status,
               ${v.from}::date as effective_from, ${v.to}::date as effective_to,
               ${v.recordedUntil}::timestamptz as recorded_until
      )
      select ${payrollEmploymentOverlapsPeriod(columns)} as included,
             (${payrollEpisodeDate(columns, columns.hiredOn)})::text as hired_on,
             (${payrollEpisodeDate(columns, columns.terminatedOn)})::text as terminated_on
    `)).rows[0]!;
    assert.equal(result.included, example.expected, JSON.stringify(v));
    if (v.hiredOn === baseline.hiredOn) {
      assert.equal(result.hired_on, null, "current rehire date does not establish a prior episode's start");
      assert.equal(result.terminated_on, null, "current release date does not establish a prior episode's end");
    }
  }
});

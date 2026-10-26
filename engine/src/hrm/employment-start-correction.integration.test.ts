import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { DB, seedEmployment, setupHarness, withHarness } from "../testing/hrm-harness.ts";
import { correctEmploymentStart } from "./employment-start-correction.ts";
import { installEngineSeams } from "../composition/install.ts";

installEngineSeams();
const SPEC = {
  users: [
    {
      key: "author",
      name: "Start Author",
      handle: "start_author",
      permissions: ["hrm.employment.read", "hrm.employment.manage"],
      link: true,
    },
    {
      key: "reader",
      name: "Start Reader",
      handle: "start_reader",
      permissions: ["hrm.employment.read"],
      link: true,
    },
  ],
} as const;

test(
  "a wrongly recorded employment start is corrected with evidence and moves the records that began with it",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(SPEC),
      async (h) => {
        const { employmentId, workerPartyId } = await seedEmployment(
          h.org.orgId,
          h.org.subsidiaryId,
          { from: "2025-01-06" },
        );
        await db.execute(sql`
      insert into employee_roles (org_id, party_id, hired_on) values (${h.org.orgId}, ${workerPartyId}, '2025-01-06')`);

        await assert.rejects(
          correctEmploymentStart({
            orgId: h.org.orgId,
            actorId: h.reader,
            employmentId,
            correctedStart: "2026-01-20",
            reason: "Hire date keyed a year early",
          }),
          (error: unknown) =>
            error instanceof Error && error.name !== "EmploymentStartCorrectionError",
          "the correction needs the employment manage grant",
        );
        await assert.rejects(
          correctEmploymentStart({
            orgId: h.org.orgId,
            actorId: h.author,
            employmentId,
            correctedStart: "2026-01-20",
            reason: "short",
          }),
          /10-500 characters/,
        );

        const result = await correctEmploymentStart({
          orgId: h.org.orgId,
          actorId: h.author,
          employmentId,
          correctedStart: "2026-01-20",
          reason: "Hire date keyed a year early",
        });
        assert.equal(result.previousStart, "2025-01-06");
        assert.equal(result.correctedStart, "2026-01-20");

        const live = await db.execute<{ effective_from: string; status: string }>(
          sql`
      select effective_from::text, status from worker_employment_versions
       where org_id = ${h.org.orgId} and employment_id = ${employmentId} and recorded_until is null`,
          "objects",
        );
        assert.deepEqual(live, [{ effective_from: "2026-01-20", status: "active" }]);
        const closed = await db.execute<{ effective_from: string; closed_by_change_id: string }>(
          sql`
      select effective_from::text, closed_by_change_id::text from worker_employment_versions
       where org_id = ${h.org.orgId} and employment_id = ${employmentId} and recorded_until is not null`,
          "objects",
        );
        assert.deepEqual(
          closed,
          [{ effective_from: "2025-01-06", closed_by_change_id: result.changeId }],
          "the wrong interval is kept as superseded evidence",
        );
        const change = (
          await db.execute<{ change_kind: string; reason: string }>(
            sql`
      select change_kind, reason from employment_changes where id = ${result.changeId}`,
            "objects",
          )
        )[0];
        assert.deepEqual(change, {
          change_kind: "corrected",
          reason: "Hire date keyed a year early",
        });
        const role = (
          await db.execute<{ hired_on: string }>(
            sql`
      select hired_on::text from employee_roles where org_id = ${h.org.orgId} and party_id = ${workerPartyId}`,
            "objects",
          )
        )[0];
        assert.equal(role?.hired_on, "2026-01-20");
        const aggregate = (
          await db.execute<{ service_start: string; revision: number }>(
            sql`
      select service_start::text, revision from worker_employments where id = ${employmentId}`,
            "objects",
          )
        )[0];
        assert.deepEqual(aggregate, { service_start: "2026-01-20", revision: 2 });

        await assert.rejects(
          correctEmploymentStart({
            orgId: h.org.orgId,
            actorId: h.author,
            employmentId,
            correctedStart: "2026-01-20",
            reason: "Hire date keyed a year early",
          }),
          /already starts on 2026-01-20/,
        );
      },
    );
  },
);

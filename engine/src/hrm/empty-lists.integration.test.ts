import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { DB, mkHr, seedNamedWorker, setupHarness, withHarness } from "../testing/hrm-harness.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { listQualifications } from "./qualifications/qualifications.ts";
import { loadQualification } from "./qualifications/qualifications.ts";
import { HrmPerformanceError } from "./performance/errors.ts";
import {
  competencyProfileForEmployment,
  getFramework,
  listFrameworks,
} from "./performance/competencies.ts";
import { listFeedback } from "./performance/feedback.ts";

/**
 * Empty HRM collections read 200 with [], never 404. A named employment the
 * caller cannot see answers as if it held nothing (the same answer as an
 * employment that holds nothing); only a genuinely missing record keeps
 * the not-found refusal, and detail reads keep theirs.
 */
const EMPTY_LISTS_SPEC = {
  features: ["hrm", "hrmCertifications", "hrmPerformance"],
  users: [
    {
      key: "viewerId",
      name: "Empty Lists Viewer",
      handle: "empty_viewer",
      permissions: ["hrm.self.read"],
      link: true,
      partyKey: "viewerParty",
    },
    {
      key: "hrId",
      name: "Empty Lists HR",
      handle: "empty_hr",
      permissions: ["hrm.certifications.read", "hrm.performance.read"],
    },
  ],
} as const;

async function seedOwnEmployment(
  orgId: string,
  partyId: string,
  subsidiaryId: string,
): Promise<string> {
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  return employmentId;
}

test(
  "qualification lists answer empty instead of not-found when nothing is visible",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(EMPTY_LISTS_SPEC),
      async (h) => {
        const own = await seedOwnEmployment(h.org.orgId, h.viewerParty, h.org.subsidiaryId);
        const stranger = await seedNamedWorker(h.org.orgId, h.org.subsidiaryId, "Stranger Hand");
        // Own employment with no qualifications: empty, not missing.
        assert.deepEqual(
          await listQualifications(db, {
            orgId: h.org.orgId,
            actorId: h.viewerId,
            employmentId: own,
          }),
          [],
        );
        // An existing employment outside the viewer's self/team scope answers
        // as if it held nothing — the route stays 200 with [].
        assert.deepEqual(
          await listQualifications(db, {
            orgId: h.org.orgId,
            actorId: h.viewerId,
            employmentId: stranger.employmentId,
          }),
          [],
        );
        // A genuinely missing employment keeps the refusal the route maps to 404.
        await assert.rejects(
          listQualifications(db, {
            orgId: h.org.orgId,
            actorId: h.viewerId,
            employmentId: randomUUID(),
          }),
          HrmAuthorizationError,
        );
        // The HR aggregate path is unchanged: strangers read empty too.
        assert.deepEqual(
          await listQualifications(db, {
            orgId: h.org.orgId,
            actorId: h.hrId,
            employmentId: stranger.employmentId,
          }),
          [],
        );
        // Detail reads keep their not-found: a missing qualification is null.
        assert.equal(
          await loadQualification(db, {
            orgId: h.org.orgId,
            actorId: h.hrId,
            qualificationId: randomUUID(),
          }),
          null,
        );
      },
    );
  },
);

test(
  "competency profile and framework lists answer empty instead of not-found",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(EMPTY_LISTS_SPEC),
      async (h) => {
        const own = await seedOwnEmployment(h.org.orgId, h.viewerParty, h.org.subsidiaryId);
        // No calibrated review exists: the profile is empty, not missing.
        assert.deepEqual(
          await competencyProfileForEmployment({
            orgId: h.org.orgId,
            actorId: h.viewerId,
            employmentId: own,
          }),
          [],
        );
        // A missing employment keeps the not-found refusal.
        await assert.rejects(
          competencyProfileForEmployment({
            orgId: h.org.orgId,
            actorId: h.viewerId,
            employmentId: randomUUID(),
          }),
          (error: unknown) => error instanceof HrmPerformanceError && error.code === "NOT_FOUND",
        );
        // No frameworks declared: empty, not missing.
        assert.deepEqual(await listFrameworks({ orgId: h.org.orgId, actorId: h.hrId }), []);
        // A missing framework keeps its not-found read.
        assert.equal(
          await getFramework({ orgId: h.org.orgId, actorId: h.hrId, id: randomUUID() }),
          null,
        );
      },
    );
  },
);

test(
  "competency profile outside an HR reader's subsidiaries answers empty",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(EMPTY_LISTS_SPEC),
      async (h) => {
        const westSubsidiary = randomUUID();
        await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${westSubsidiary}, ${h.org.orgId}, ${h.org.subsidiaryId}, 'West Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    `);
        const west = await seedNamedWorker(h.org.orgId, westSubsidiary, "West Hand");
        const restrictedHr = await mkHr(
          h.org.orgId,
          "West Blind",
          "west_blind",
          [h.org.subsidiaryId],
          ["hrm.performance.read"],
        );
        assert.deepEqual(
          await competencyProfileForEmployment({
            orgId: h.org.orgId,
            actorId: restrictedHr,
            employmentId: west.employmentId,
          }),
          [],
        );
      },
    );
  },
);

test("feedback lists answer empty when nothing exists", { skip: !DB }, async () => {
  await withHarness(
    () => setupHarness(EMPTY_LISTS_SPEC),
    async (h) => {
      const own = await seedOwnEmployment(h.org.orgId, h.viewerParty, h.org.subsidiaryId);
      assert.deepEqual(await listFeedback({ orgId: h.org.orgId, actorId: h.viewerId }), []);
      assert.deepEqual(
        await listFeedback({ orgId: h.org.orgId, actorId: h.viewerId, subjectEmploymentId: own }),
        [],
      );
    },
  );
});

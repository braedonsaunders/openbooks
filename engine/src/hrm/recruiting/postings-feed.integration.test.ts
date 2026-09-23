import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, orgContext } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../testing/fixtures.ts";
import {
  createRequisition,
  openRequisition,
} from "./requisitions.ts";
import {
  createFeedToken,
  listFeedPostings,
  publishPosting,
  resolveFeedOrg,
} from "./postings.ts";

/**
 * Public job feed under the constrained runtime role — DB-owned, one file
 * at a time. No skip guards: the integration partition guarantees a
 * database.
 *
 * The feed route is sessionless: no request carries an org scope, so the
 * listing runs under deny-by-default RLS with an empty ambient scope. The
 * test reproduces exactly that ambient (no org, no bypass) instead of the
 * trusted test bypass — under bypass this test would pass vacuously even
 * with the bug, because the pool would see every row.
 */

async function grant(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function enableBoards(orgId: string): Promise<void> {
  for (const key of ["hrm", "hrmRecruiting", "hrmJobBoards"] as const) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), string_to_array(${`features,${key}`}, ','), 'true'::jsonb, true)
       where id = ${orgId}`);
  }
}

test("public feed lists published postings with no ambient org scope", async () => {
  const org = await createScratchOrg();
  try {
    await enableBoards(org.orgId);
    const recruiterId = await createScratchUser(org.orgId, "Feed Recruiter", "feed_recruiter");
    await grant(org.orgId, recruiterId, ["hrm.recruiting.read", "hrm.recruiting.manage"]);
    const requisition = await createRequisition({
      orgId: org.orgId,
      actorId: recruiterId,
      title: "Backend engineer",
      employerSubsidiaryId: org.subsidiaryId,
      headcount: 1,
    });
    const opened = await openRequisition({ orgId: org.orgId, actorId: recruiterId, requisitionId: requisition.id });
    const posting = await publishPosting({
      orgId: org.orgId,
      actorId: recruiterId,
      requisitionId: opened.id,
      boardKey: "feed",
    });
    assert.equal(posting.status, "published");
    // The route's view of the world: token resolves the org under bypass,
    // then the listing runs with no ambient scope and no bypass.
    const resolved = await resolveFeedOrg(createFeedToken(org.orgId));
    assert.equal(resolved, org.orgId);
    const jobs = await orgContext.run({ orgId: null, bypass: false }, () =>
      listFeedPostings(resolved),
    );
    assert.equal(jobs.length, 1, "the public feed serves the published posting under deny-by-default RLS");
    assert.equal(jobs[0]!.postingId, posting.id);
    assert.equal(jobs[0]!.title, "Backend engineer");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

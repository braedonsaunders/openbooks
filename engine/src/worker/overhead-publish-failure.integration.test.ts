import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import {
  ensureOverheadPublishFailedNotice,
  OVERHEAD_PUBLISH_FAILED_NOTICE_KIND,
  resolveOverheadPublishFailedNotices,
} from "./overhead-scheduler.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type NoticeRow = { title: string; body: string | null; href: string | null };

async function unreadFailureNotices(orgId: string, userId: string): Promise<NoticeRow[]> {
  return withOrgContext(orgId, async () =>
    (await db.execute<NoticeRow>(sql`
      select title, body, href from notifications
       where org_id = ${orgId} and user_id = ${userId}
         and kind = ${OVERHEAD_PUBLISH_FAILED_NOTICE_KIND} and read_at is null
       order by created_at
    `)).rows,
  );
}

test("a failed publish raises one named notice, never spams, and resolves on success (C-55)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Overhead Admin", "overhead_admin");
    await db.execute(sql`update users set is_super_admin = true where id = ${userId}`);
    await withOrgContext(org.orgId, async () => {
      // RED before the fix: the failure reached nobody — console.error only.
      assert.equal(await ensureOverheadPublishFailedNotice(org.orgId, "2026-09-01", "fetch failed"), 1);
      // A second failing tick finds the unread notice and writes nothing.
      assert.equal(await ensureOverheadPublishFailedNotice(org.orgId, "2026-09-01", "fetch failed"), 0);
      const notices = await unreadFailureNotices(org.orgId, userId);
      assert.equal(notices.length, 1);
      assert.match(notices[0]!.title, /Overhead scheduled publish failed for 2026-09-01/);
      assert.match(notices[0]!.body ?? "", /fetch failed/);
      assert.match(notices[0]!.body ?? "", /OPENBOOKS_INTERNAL_TOKEN/);
      assert.equal(notices[0]!.href, "/admin/setup/overhead");
      // Success resolves the notice, so a later failure re-fires.
      assert.equal(await resolveOverheadPublishFailedNotices(org.orgId), 1);
      assert.deepEqual(await unreadFailureNotices(org.orgId, userId), []);
      assert.equal(await ensureOverheadPublishFailedNotice(org.orgId, "2026-10-01", "HTTP 500"), 1);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

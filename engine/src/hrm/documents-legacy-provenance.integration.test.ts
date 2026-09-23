import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { getDocumentDetail } from "./documents/documents.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableHrm(orgId: string) {
  for (const feature of ["hrm", "hrmDocuments", "hrmDocumentRetention"]) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
       where id = ${orgId}
    `);
  }
}

/**
 * 0274 froze the retention action from the live schedule, so completions
 * predating an action edit inherit the new action. Those completions read
 * legacy (0326): the drawer names the inherited action as unverified
 * instead of presenting it as the action in force at completion, while
 * honestly frozen completions read current.
 */
test("an inherited completion reads unverified; a frozen one reads current", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const actorId = await createScratchUser(org.orgId, "HR Reader", "hr_admin");
  await db.execute(sql`
    insert into user_permission_overrides (org_id, user_id, permission, effect)
    values (${org.orgId}, ${actorId}, 'hrm.documents.read', 'grant')
    on conflict (user_id, permission) do update set effect = 'grant'`);
  const legacyDay = "2020-01-15";
  const legacyDoc = randomUUID();
  const freshDoc = randomUUID();
  try {
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into hrm_retention_schedules (id, org_id, category_key, retain_years, from_event, action, is_active)
      values (${scheduleId}, ${org.orgId}, 'legacy-contracts', 7, 'completion', 'anonymize', true)`);
    await db.execute(sql`
      insert into hrm_documents
        (id, org_id, category_key, title, status, completed_at, retention_rule_id, retain_until, retention_action,
         created_at, updated_at)
      values (${legacyDoc}, ${org.orgId}, 'legacy-contracts', 'Legacy agreement', 'signed', ${legacyDay}::timestamptz,
              ${scheduleId}, '2027-01-15', 'anonymize', ${legacyDay}::timestamptz, ${legacyDay}::timestamptz)`);
    await db.execute(sql`
      insert into hrm_documents
        (id, org_id, category_key, title, status, completed_at, retention_rule_id, retain_until, retention_action)
      values (${freshDoc}, ${org.orgId}, 'legacy-contracts', 'Fresh agreement', 'signed', now(),
              ${scheduleId}, '2033-01-15', 'anonymize')`);
    await db.execute(sql`
      insert into upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
      values (${org.orgId}, '0274_retention_action_completion_snapshot', 'hrm_documents', ${legacyDoc}, 'test mark')`);

    const legacy = await getDocumentDetail({ orgId: org.orgId, actorId, documentId: legacyDoc });
    assert.equal(legacy.retentionAction, "anonymize");
    assert.equal(legacy.retainUntil, "2027-01-15");
    assert.equal(legacy.retentionUnverified, true);

    const fresh = await getDocumentDetail({ orgId: org.orgId, actorId, documentId: freshDoc });
    assert.equal(fresh.retentionAction, "anonymize");
    assert.equal(fresh.retentionUnverified, false);
  } finally {
    await db.execute(sql`delete from upgrade_legacy_provenance where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

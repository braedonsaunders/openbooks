import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../platform/db.ts";
import {
  findDuplicateProjects,
  mergeProjects,
  previewProjectMerge,
  ProjectMergeError,
} from "./merge.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

// Admin merge for duplicate projects (the same job under two ids): the
// tenant mirrors as two rows sharing a job code, name+customer, and source
// envelope. The survivor keeps every reference; the duplicate deactivates
// with a merged_into pointer; the same pair re-runs as a no-op.

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedProject(
  orgId: string,
  subsidiaryId: string,
  customerId: string,
  code: string,
  name: string,
  custom: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
    values (${id}, ${orgId}, ${subsidiaryId}, ${code}, ${name}, ${customerId},
            'active', true, ${JSON.stringify(custom)}::jsonb)`);
  return id;
}

async function seedReferences(
  orgId: string,
  subsidiaryId: string,
  projectId: string,
  tag: string,
  actorId: string,
): Promise<void> {
  const employee = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employee}, ${orgId}, 'person', 'Merge worker', true, '{}'::jsonb)`);
  const doc = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, subsidiary_id, kind, status, document_number, document_date, currency, project_id)
    values (${doc}, ${orgId}, ${subsidiaryId}, 'vendor_bill', 'draft', ${doc}, '2026-08-04', 'CAD', ${projectId})`);
  await db.execute(sql`
    insert into document_lines (org_id, document_id, line_number, account_id, amount, project_id)
    select ${orgId}, ${doc}, 1, id, '10.0000', ${projectId} from accounts
     where org_id = ${orgId} and id <> ${subsidiaryId} limit 1`);
  // The merge moves draft lines; approved lines are storage-frozen and
  // refuse (covered by the second test), so the moving doc stays draft.
  await db.execute(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id,
                              status, is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${orgId}, ${employee}, '2026-08-04', '2', ${projectId},
            'approved', false, 'unbilled', 'actual', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into change_orders (org_id, project_id, number, amount)
    values (${orgId}, ${projectId}, ${`CO-${tag}`}, '100.0000')`);
  await db.execute(sql`
    insert into sov_lines (org_id, project_id, description)
    values (${orgId}, ${projectId}, ${`SOV ${tag}`})`);
}

test("duplicate projects merge every reference and deactivate with a pointer", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const survivor = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-1", "Same job", {
      source: { system: "other", externalId: "100" },
      nsId: "100",
    });
    // The mirror row carries the legacy connector identity but no envelope —
    // the exact shape of the tenant's fence-blind loader rows.
    const duplicate = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-1", "Same job", {
      nsId: "100",
    });
    await seedReferences(org.orgId, org.subsidiaryId, duplicate, "DUP", actor);
    // A project custom reference pointing at the duplicate follows the merge.
    await db.execute(sql`
      insert into custom_field_defs (org_id, target_table, key, label, field_type, config)
      values (${org.orgId}, 'documents', 'job_ref', 'Job', 'reference', '{"referenceTable":"projects"}'::jsonb)`);
    await db.execute(sql`
      update documents set custom = jsonb_build_object('job_ref', ${duplicate}::text)
       where org_id = ${org.orgId} and project_id = ${duplicate}`);

    const groups = await findDuplicateProjects(org.orgId);
    const kinds = new Set(groups.flatMap((group) => group.projects.map((p) => p.id).includes(duplicate) ? [group.kind] : []));
    assert.ok(kinds.has("source_ref") && kinds.has("name_customer") && kinds.has("job_number"));

    const preview = await previewProjectMerge(org.orgId, survivor, duplicate);
    assert.equal(preview.alreadyMerged, false);
    const moved = new Map(preview.moved.map((m) => [m.table, m.rows]));
    assert.equal(moved.get("documents"), 1);
    assert.equal(moved.get("document_lines"), 1);
    assert.equal(moved.get("time_entries"), 1);
    assert.equal(moved.get("change_orders"), 1);
    assert.equal(moved.get("sov_lines"), 1);
    assert.equal(preview.customRefs.length, 1);

    const result = await mergeProjects(org.orgId, { survivorId: survivor, duplicateId: duplicate, actorId: actor });
    assert.equal(result.alreadyMerged, false);
    assert.ok(result.auditId);
    for (const table of ["documents", "document_lines", "time_entries", "change_orders", "sov_lines"]) {
      const left = await db.execute<{ n: string }>(sql`
        select count(*)::text as n from ${sql.identifier(table)}
         where org_id = ${org.orgId} and project_id = ${duplicate}`);
      assert.equal(left.rows[0]?.n, "0", table);
    }
    const customLeft = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from documents
       where org_id = ${org.orgId} and custom ->> 'job_ref' = ${duplicate}`);
    assert.equal(customLeft.rows[0]?.n, "0");
    const docs = await db.execute<{ project_id: string }>(sql`
      select project_id from documents where org_id = ${org.orgId} and project_id = ${survivor}`);
    assert.equal(docs.rows.length, 1);
    const marker = await db.execute<{ is_active: boolean; custom: Record<string, unknown> }>(sql`
      select is_active, custom from projects where id = ${duplicate} and org_id = ${org.orgId}`);
    assert.equal(marker.rows[0]?.is_active, false);
    assert.deepEqual(
      (marker.rows[0]?.custom?.["merged_into"] as Record<string, unknown>)?.["survivor"],
      survivor,
    );
    const audit = await db.execute<{ action: string }>(sql`
      select action from audit_log
       where org_id = ${org.orgId} and table_name = 'projects' and row_id = ${duplicate}`);
    assert.deepEqual(audit.rows.map((row) => row.action), ["merge"]);

    const again = await mergeProjects(org.orgId, { survivorId: survivor, duplicateId: duplicate, actorId: actor });
    assert.equal(again.alreadyMerged, true);
    assert.equal(again.auditId, null);
    const after = await findDuplicateProjects(org.orgId);
    assert.ok(!after.some((group) => group.projects.some((p) => p.id === duplicate)));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a committing merge takes both project row locks before planning", async () => {
  // Two merges racing on overlapping pairs used to plan against unlocked
  // reads: the loser moved zero refs, overwrote merged_into, and audited
  // success. The committing merge now locks both rows (deterministic order)
  // and re-checks merged_into on locked state. This test holds the
  // duplicate row in a separate session, fires a merge, and asserts the
  // merge blocks on the row lock instead of planning past it.
  const org = await createScratchOrg();
  const holder = await pool.connect();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const survivor = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-L1", "Lock one");
    const duplicate = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-L2", "Lock two");
    await holder.query("BEGIN");
    await holder.query("select set_config('app.bypass_rls', 'on', false)");
    await holder.query("select id from projects where id = $1 for update", [duplicate]);
    const pending = mergeProjects(org.orgId, { survivorId: survivor, duplicateId: duplicate, actorId: actor });
    const deadline = Date.now() + 15000;
    for (;;) {
      const waiting = await db.execute<{ waiting: boolean }>(sql`
        select exists(
          select 1 from pg_stat_activity
           where wait_event_type = 'Lock' and query ilike '%from projects%for update%'
        ) as waiting`);
      if (waiting.rows[0]?.waiting) break;
      if (Date.now() > deadline) throw new Error("merge never took the project row locks");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await holder.query("COMMIT");
    const result = await pending;
    assert.equal(result.alreadyMerged, false);
    assert.ok(result.auditId);
    const audits = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from audit_log
       where org_id = ${org.orgId} and table_name = 'projects' and row_id = ${duplicate} and action = 'merge'`);
    assert.equal(audits.rows[0]?.n, "1");
  } finally {
    try { await holder.query("ROLLBACK"); } catch { /* already committed */ }
    holder.release();
    await dropScratchOrg(org.orgId);
  }
});

test("project merge refuses cross-subsidiary pairs", async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const otherSubsidiary = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${otherSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Other entity', 'CAD', 'CA')`);
    const survivor = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-S1", "Home job");
    const duplicate = await seedProject(org.orgId, otherSubsidiary, org.customerId, "JOB-S2", "Away job");
    await assert.rejects(
      mergeProjects(org.orgId, { survivorId: survivor, duplicateId: duplicate, actorId: actor }),
      /cannot merge projects from different subsidiaries/,
    );
    await assert.rejects(
      previewProjectMerge(org.orgId, survivor, duplicate),
      /cannot merge projects from different subsidiaries/,
    );
    // Same-subsidiary pairs still merge.
    const same = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-S3", "Home twin");
    const result = await mergeProjects(org.orgId, { survivorId: survivor, duplicateId: same, actorId: actor });
    assert.equal(result.alreadyMerged, false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project merge refuses cycles, collisions, and spent duplicates", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const a = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-A", "Alpha");
    const b = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-B", "Beta");
    await assert.rejects(
      mergeProjects(org.orgId, { survivorId: a, duplicateId: a, actorId: actor }),
      ProjectMergeError,
    );
    await assert.rejects(
      mergeProjects(org.orgId, { survivorId: a, duplicateId: randomUUID(), actorId: actor }),
      /both projects must exist/,
    );
    // Change-order number on both sides: conflicting posted structure.
    await db.execute(sql`
      insert into change_orders (org_id, project_id, number, amount)
      values (${org.orgId}, ${a}, 'CO-1', '10.0000'), (${org.orgId}, ${b}, 'CO-1', '20.0000')`);
    await assert.rejects(
      mergeProjects(org.orgId, { survivorId: a, duplicateId: b, actorId: actor }),
      /change order number CO-1 exists on both projects/,
    );
    // Hierarchy cycle: the survivor sits under the duplicate.
    const parent = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-P", "Parent");
    const child = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-C", "Child");
    await db.execute(sql`
      update projects set parent_id = ${parent} where id = ${child} and org_id = ${org.orgId}`);
    await assert.rejects(
      mergeProjects(org.orgId, { survivorId: child, duplicateId: parent, actorId: actor }),
      /cycle/,
    );
    // Lines on an approved document freeze the merge with a named refusal.
    const frozen = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-F", "Frozen");
    const frozenDoc = randomUUID();
    await db.execute(sql`
      insert into documents (id, org_id, subsidiary_id, kind, status, document_number, document_date, currency, project_id)
      values (${frozenDoc}, ${org.orgId}, ${org.subsidiaryId}, 'vendor_bill', 'draft', ${frozenDoc}, '2026-08-04', 'CAD', ${frozen})`);
    await db.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, amount, project_id)
      select ${org.orgId}, ${frozenDoc}, 1, id, '10.0000', ${frozen} from accounts
       where org_id = ${org.orgId} limit 1`);
    await db.execute(sql`
      update documents set status = 'approved' where id = ${frozenDoc} and org_id = ${org.orgId}`);
    await assert.rejects(
      mergeProjects(org.orgId, { survivorId: a, duplicateId: frozen, actorId: actor }),
      /cannot move lines of 1 non-draft/,
    );
    // A spent duplicate cannot merge elsewhere.
    await db.execute(sql`
      delete from change_orders where org_id = ${org.orgId} and project_id in (${a}, ${b})`);
    await mergeProjects(org.orgId, { survivorId: a, duplicateId: b, actorId: actor });
    const c = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-D", "Delta");
    await assert.rejects(
      mergeProjects(org.orgId, { survivorId: c, duplicateId: b, actorId: actor }),
      /already merged into another project/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

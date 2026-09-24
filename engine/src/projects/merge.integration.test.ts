import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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

async function seedPostedEntry(args: {
  orgId: string;
  subsidiaryId: string;
  bookId: string;
  periodId: string;
  date: string;
  adjustmentAccount: string;
  bankAccount: string;
  projectId: string;
  tag: string;
}): Promise<void> {
  const entry = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${entry}, ${args.orgId}, ${args.bookId}, ${args.subsidiaryId}, ${`JE-${args.tag}`},
            ${args.date}, ${args.periodId}, 'merge posted lines', 'draft', 'manual')`);
  // One balanced pair: the deferred entry-balance trigger fires at commit.
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
    values
      (${args.orgId}, ${entry}, 1, ${args.adjustmentAccount}, ${args.subsidiaryId}, ${args.projectId}, '25', 'CAD', '25', '1'),
      (${args.orgId}, ${entry}, 2, ${args.bankAccount}, ${args.subsidiaryId}, ${args.projectId}, '-25', 'CAD', '-25', '1')`);
  await db.execute(sql`update journal_entries set status = 'posted' where id = ${entry} and org_id = ${args.orgId}`);
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

test("merge enforces the caller subsidiary scope inside the locked transaction", async () => {
  // The route used to scope-check in a pre-transaction SELECT while the
  // engine merged later without caller scope — a narrowing mid-flight
  // merged out-of-scope rows. The allowlist is now enforced on the locked
  // rows inside the merge transaction itself.
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const a = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-G1", "Scoped one");
    const b = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-G2", "Scoped two");
    // A scope covering the pair merges.
    const ok = await mergeProjects(org.orgId, {
      survivorId: a, duplicateId: b, actorId: actor, allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    });
    assert.equal(ok.alreadyMerged, false);
    // A scope excluding the pair refuses before anything moves.
    const c = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-G3", "Hidden one");
    const d = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-G4", "Hidden two");
    const excluded = new Set([randomUUID()]);
    await assert.rejects(
      mergeProjects(org.orgId, { survivorId: c, duplicateId: d, actorId: actor, allowedSubsidiaryIds: excluded }),
      /outside the caller subsidiary scope/,
    );
    await assert.rejects(
      previewProjectMerge(org.orgId, c, d, excluded),
      /outside the caller subsidiary scope/,
    );
    const marker = await db.execute<{ is_active: boolean }>(sql`
      select is_active from projects where id = ${d} and org_id = ${org.orgId}`);
    assert.equal(marker.rows[0]?.is_active, true, "a refused merge deactivates nothing");
    // Unrestricted callers still merge.
    const unrestricted = await mergeProjects(org.orgId, {
      survivorId: c, duplicateId: d, actorId: actor, allowedSubsidiaryIds: null,
    });
    assert.equal(unrestricted.alreadyMerged, false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("merge routes pass the caller scope into the locked merge", () => {
  const route = readFileSync(new URL("../../../web/app/api/projects/merge/route.ts", import.meta.url), "utf8");
  assert.match(route, /previewProjectMerge\(gate\.user\.orgId, survivorId, duplicateId, gate\.allowedSubsidiaryIds\)/);
  assert.match(route, /allowedSubsidiaryIds: gate\.allowedSubsidiaryIds,/);
});

test("merge moves posted journal lines in open periods through the amend path", async () => {
  // A plain in-place rewrite of posted lines dies in the journal guard
  // ("lines of a posted journal entry are immutable"). The merge runs the
  // move through the governed amend path instead, so open-period posted
  // history follows the survivor.
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const survivor = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-J1", "Posted one");
    const duplicate = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-J2", "Posted two");
    await seedPostedEntry({
      orgId: org.orgId, subsidiaryId: org.subsidiaryId, bookId: org.bookId, periodId: org.periodId,
      date: org.date, adjustmentAccount: org.accounts.adjustment, bankAccount: org.accounts.bank,
      projectId: duplicate, tag: "JOPEN",
    });
    const preview = await previewProjectMerge(org.orgId, survivor, duplicate);
    assert.equal(preview.moved.find((m) => m.table === "journal_lines")?.rows, 2);
    const result = await mergeProjects(org.orgId, { survivorId: survivor, duplicateId: duplicate, actorId: actor });
    assert.equal(result.alreadyMerged, false);
    const left = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from journal_lines
       where org_id = ${org.orgId} and project_id = ${duplicate}`);
    assert.equal(left.rows[0]?.n, "0");
    const moved = await db.execute<{ n: string; status: string }>(sql`
      select count(*)::text as n, max(e.status) as status
        from journal_lines jl join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id
       where jl.org_id = ${org.orgId} and jl.project_id = ${survivor}`);
    assert.equal(moved.rows[0]?.n, "2");
    assert.equal(moved.rows[0]?.status, "posted", "the entry stays posted through the move");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("merge refuses posted journal lines in a closed GL period", async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const survivor = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-J3", "Closed one");
    const duplicate = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-J4", "Closed two");
    await seedPostedEntry({
      orgId: org.orgId, subsidiaryId: org.subsidiaryId, bookId: org.bookId, periodId: org.periodId,
      date: org.date, adjustmentAccount: org.accounts.adjustment, bankAccount: org.accounts.bank,
      projectId: duplicate, tag: "JCLOSED",
    });
    await db.execute(sql`
      insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId}, 'gl', 'closed', now(), ${actor})`);
    await assert.rejects(
      mergeProjects(org.orgId, { survivorId: survivor, duplicateId: duplicate, actorId: actor }),
      /cannot merge: 2 posted journal line\(s\) sit in a closed GL period; reopen the period before merging/,
    );
    await assert.rejects(
      previewProjectMerge(org.orgId, survivor, duplicate),
      /closed GL period/,
    );
    const marker = await db.execute<{ is_active: boolean }>(sql`
      select is_active from projects where id = ${duplicate} and org_id = ${org.orgId}`);
    assert.equal(marker.rows[0]?.is_active, true, "a refused merge deactivates nothing");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("merge refuses when billing terms differ", async () => {
  // The survivor's contract value, project type, and invoicing preference
  // price every moved line: a mismatch refuses naming the field, instead of
  // silently repricing the duplicate's history. Reconciling all three lets
  // the same pair merge.
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const typeA = randomUUID();
    const typeB = randomUUID();
    for (const [typeId, key] of [[typeA, "merge-a"], [typeB, "merge-b"]] as const) {
      await db.execute(sql`
        insert into project_types (id, org_id, key, name, billing_method, invoicing_profile, backup_profile)
        values (${typeId}, ${org.orgId}, ${key}, ${key}, 'fixed_price', '{}'::jsonb, '{}'::jsonb)`);
    }
    const survivor = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-B1", "Terms one");
    const duplicate = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-B2", "Terms two");
    const setTerms = (id: string, value: string, type: string, pref: unknown) => db.execute(sql`
      update projects
         set contract_value = ${value}, project_type_id = ${type},
             invoicing_preference = ${JSON.stringify(pref)}::jsonb
       where id = ${id} and org_id = ${org.orgId}`);
    const attempt = () => mergeProjects(org.orgId, { survivorId: survivor, duplicateId: duplicate, actorId: actor });
    await setTerms(survivor, "100.0000", typeA, { procedure: "standard" });
    await setTerms(duplicate, "200.0000", typeA, { procedure: "standard" });
    await assert.rejects(attempt(), /disagree on contract value/);
    await setTerms(duplicate, "100.0000", typeB, { procedure: "standard" });
    await assert.rejects(attempt(), /disagree on project type/);
    await setTerms(duplicate, "100.0000", typeA, { procedure: "milestone" });
    await assert.rejects(attempt(), /disagree on invoicing preference/);
    await assert.rejects(
      previewProjectMerge(org.orgId, survivor, duplicate),
      /disagree on invoicing preference/,
    );
    await setTerms(duplicate, "100.0000", typeA, { procedure: "standard" });
    const result = await attempt();
    assert.equal(result.alreadyMerged, false);
    assert.ok(result.auditId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("duplicate listing hides null-subsidiary projects from restricted callers", async () => {
  // The restricted listing used to include `or subsidiary_id is null`
  // while the record gate denies null-subsidiary projects to restricted
  // callers — GET /api/projects/duplicates leaked rows its own guard
  // refuses. Restricted scopes now list only allowlisted rows.
  const org = await createScratchOrg();
  try {
    const nullA = randomUUID();
    const nullB = randomUUID();
    for (const id of [nullA, nullB]) {
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${id}, ${org.orgId}, null, 'NULLJOB', 'Null job', ${org.customerId}, 'active', true, '{}'::jsonb)`);
    }
    const unrestricted = await findDuplicateProjects(org.orgId, { subsidiaryIds: null });
    assert.ok(
      unrestricted.some((group) => group.kind === "job_number" && group.projects.some((p) => p.id === nullA)),
      "unrestricted callers still see the null-subsidiary pair",
    );
    const restricted = await findDuplicateProjects(org.orgId, { subsidiaryIds: [org.subsidiaryId] });
    assert.ok(
      !restricted.some((group) => group.projects.some((p) => p.id === nullA || p.id === nullB)),
      "restricted callers must not see null-subsidiary rows",
    );
    assert.deepEqual(await findDuplicateProjects(org.orgId, { subsidiaryIds: [] }), []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("merge refuses while the projects feature is disabled", async () => {
  // The API checks the feature gate before calling the engine, but the
  // engine merge had no in-transaction fence — an in-flight merge could
  // rewrite references and deactivate a project under a disabled gate.
  // Both preview and commit re-check under the org's shared feature lock.
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const survivor = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-F1", "Gated one");
    const duplicate = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-F2", "Gated two");
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features,projects}', 'false'::jsonb, true)
       where id = ${org.orgId}`);
    await assert.rejects(
      mergeProjects(org.orgId, { survivorId: survivor, duplicateId: duplicate, actorId: actor }),
      /projects feature is disabled/,
    );
    await assert.rejects(
      previewProjectMerge(org.orgId, survivor, duplicate),
      /projects feature is disabled/,
    );
    const marker = await db.execute<{ is_active: boolean }>(sql`
      select is_active from projects where id = ${duplicate} and org_id = ${org.orgId}`);
    assert.equal(marker.rows[0]?.is_active, true, "a refused merge deactivates nothing");
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features,projects}', 'true'::jsonb, true)
       where id = ${org.orgId}`);
    const result = await mergeProjects(org.orgId, { survivorId: survivor, duplicateId: duplicate, actorId: actor });
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

test("project merge refuses a second primary baseline and moves schedule rows", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const a = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-SB-A", "Baseline Alpha");
    const b = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-SB-B", "Baseline Beta");
    await db.execute(sql`
      insert into schedule_baselines (org_id, project_id, name, is_primary)
      values (${org.orgId}, ${a}, 'Primary A', true), (${org.orgId}, ${b}, 'Primary B', true)`);
    await assert.rejects(
      mergeProjects(org.orgId, { survivorId: a, duplicateId: b, actorId: actor }),
      /both projects hold a primary schedule baseline/,
    );
    // A non-primary baseline is no conflict: it follows the merge, and the
    // survivor keeps its own primary.
    await db.execute(sql`
      update schedule_baselines set is_primary = false
       where org_id = ${org.orgId} and project_id = ${b}`);
    await db.execute(sql`
      insert into schedule_calendars (org_id, project_id, name)
      values (${org.orgId}, ${b}, 'Crew calendar')`);
    const result = await mergeProjects(org.orgId, { survivorId: a, duplicateId: b, actorId: actor });
    assert.equal(result.alreadyMerged, false);
    for (const table of ["schedule_baselines", "schedule_calendars"]) {
      const left = await db.execute<{ n: string }>(sql`
        select count(*)::text as n from ${sql.identifier(table)}
         where org_id = ${org.orgId} and project_id = ${b}`);
      assert.equal(left.rows[0]?.n, "0", table);
    }
    const kept = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from schedule_baselines
       where org_id = ${org.orgId} and project_id = ${a} and is_primary`);
    assert.equal(kept.rows[0]?.n, "1");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project merge refuses pay-application collisions and moves revenue contracts", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const a = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-PA-A", "Payapp Alpha");
    const b = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-PA-B", "Payapp Beta");
    await db.execute(sql`
      insert into pay_applications (org_id, project_id, application_number, period_end, status)
      values (${org.orgId}, ${a}, 7, '2026-08-31', 'approved'),
             (${org.orgId}, ${b}, 7, '2026-08-31', 'posted')`);
    await assert.rejects(
      mergeProjects(org.orgId, { survivorId: a, duplicateId: b, actorId: actor }),
      /pay application number 7 exists on both projects/,
    );
    // Same number reconciled away, but both sides still hold an open
    // application: the partial unique index would fire on the move.
    await db.execute(sql`
      update pay_applications set application_number = 8
       where org_id = ${org.orgId} and project_id = ${b}`);
    await db.execute(sql`
      insert into pay_applications (org_id, project_id, application_number, period_end, status)
      values (${org.orgId}, ${b}, 9, '2026-08-31', 'submitted')`);
    await assert.rejects(
      mergeProjects(org.orgId, { survivorId: a, duplicateId: b, actorId: actor }),
      /both projects hold an open pay application/,
    );
    // Closed applications and revenue contracts follow the merge.
    await db.execute(sql`update pay_applications set status = 'posted' where org_id = ${org.orgId}`);
    await db.execute(sql`
      insert into revenue_contracts (org_id, project_id, contract_number, customer_id)
      values (${org.orgId}, ${b}, 'RC-1', ${org.customerId})`);
    const result = await mergeProjects(org.orgId, { survivorId: a, duplicateId: b, actorId: actor });
    assert.equal(result.alreadyMerged, false);
    for (const table of ["pay_applications", "revenue_contracts"]) {
      const left = await db.execute<{ n: string }>(sql`
        select count(*)::text as n from ${sql.identifier(table)}
         where org_id = ${org.orgId} and project_id = ${b}`);
      assert.equal(left.rows[0]?.n, "0", table);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

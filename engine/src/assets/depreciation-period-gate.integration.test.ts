import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { setPeriodLockState } from "../close/close.ts";
import {
  buildSchedule,
  recordDepreciationInput,
  runDepreciation,
} from "./depreciation.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

/**
 * One period gate for depreciation (fleet 8, P7): recordDepreciationInput and
 * the runDepreciation claim route through assertPeriodModulesOpen /
 * arePeriodModulesOpen instead of raw period_module_is_closed SQL. Policy is
 * preserved — recording and posting depreciation is new local activity, not
 * historical replay, so a source-owned imported lock refuses exactly like a
 * user lock. Each test below pins both lock flavors.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

const IMPORTED_REASON = "close.importedPeriodLockReason";

async function seedStraightLineAsset(
  org: ScratchOrg,
  actorId: string,
  tag: string,
): Promise<string> {
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`insert into asset_categories
    (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
     depreciation_expense_account_id, default_method, default_life_months, default_convention,
     tax_attributes, is_active)
    values (${categoryId}, ${org.orgId}, ${`Equipment ${tag}`}, ${org.accounts.invAsset}, ${org.accounts.clearing},
            ${org.accounts.adjustment}, 'straight_line', 12, 'full_month', '{}'::jsonb, true)`);
  await db.execute(sql`insert into fixed_assets
    (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquired_on, in_service_on,
     acquisition_cost, salvage_value, depreciation_method, useful_life_months, custom)
    values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, ${`GATE-SL-${tag}`},
            ${`Gate asset ${tag}`}, 'in_service', ${org.date}, ${org.date},
            '12000.0000', '2000.0000', 'straight_line', 12, '{}'::jsonb)`);
  await buildSchedule(assetId, org.orgId, actorId, org.bookId);
  return assetId;
}

async function seedManualAsset(
  org: ScratchOrg,
  actorId: string,
  tag: string,
): Promise<{ assetId: string; evidenceFileId: string }> {
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`insert into asset_categories
    (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
     depreciation_expense_account_id, default_method, default_life_months, default_convention,
     tax_attributes, is_active)
    values (${categoryId}, ${org.orgId}, ${`Manual cat ${tag}`}, ${org.accounts.invAsset}, ${org.accounts.clearing},
            ${org.accounts.adjustment}, 'manual', null, 'full_month', '{}'::jsonb, true)`);
  await db.execute(sql`insert into fixed_assets
    (id, org_id, subsidiary_id, category_id, asset_number, name, status,
     acquired_on, in_service_on, acquisition_cost, salvage_value,
     depreciation_method, custom)
    values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, ${`GATE-M-${tag}`},
            ${`Gate manual ${tag}`}, 'in_service', ${org.date}, ${org.date}, '12000.0000', '2000.0000',
            'manual', '{}'::jsonb)`);
  await buildSchedule(assetId, org.orgId, actorId, org.bookId);
  const folderId = randomUUID();
  const evidenceFileId = await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into folders (id, org_id, name, record_table, record_id, created_by, updated_by)
      values (${folderId}, ${org.orgId}, 'Asset evidence', 'fixed_assets', ${assetId}, ${actorId}, ${actorId})`);
    const fileId = (await tx.execute<{ id: string }>(sql`
      insert into files (org_id, folder_id, name, file_type, content_type, size_bytes, created_by, updated_by)
      values (${org.orgId}, ${folderId}, 'meter-evidence.pdf', 'pdf', 'application/pdf', 1, ${actorId}, ${actorId}) returning id`)).rows[0]!.id;
    await tx.execute(sql`
      insert into file_attachments (org_id, file_id, target_table, target_id, created_by)
      values (${org.orgId}, ${fileId}, 'fixed_assets', ${assetId}, ${actorId})`);
    return fileId;
  });
  return { assetId, evidenceFileId };
}

/** User-owned close, through the same lock writer the close flow uses. */
async function closeGlForUser(org: ScratchOrg, actorId: string): Promise<void> {
  await setPeriodLockState({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    module: "gl",
    state: "closed",
    actorId,
    reason: "fleet8 f2: user-owned GL close",
  });
}

/**
 * Source-owned close, mirroring exactly what the migration mirror lands
 * (engine/src/sync/migrate.ts): every module locked with the imported reason.
 * A later user edit would gain a user reason; nothing here does.
 */
async function closeAllImported(org: ScratchOrg): Promise<void> {
  for (const module of ["ar", "ap", "banking", "assets", "tax", "gl"] as const) {
    await db.execute(sql`
      insert into period_locks
        (org_id, period_id, book_id, module, state, locked_at, reason)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${module},
              'closed', now(), ${IMPORTED_REASON})
      on conflict (org_id, period_id, book_id, subsidiary_id, module)
      do update set state = excluded.state,
        locked_at = excluded.locked_at,
        reason = excluded.reason,
        reopen_expires_at = null,
        version = period_locks.version + 1,
        updated_at = now()`);
  }
}

async function journalCount(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId}`));
  return r.rows[0]!.n;
}

test("open period: the runner still posts (setup can post, refusal is load-bearing)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const assetId = await seedStraightLineAsset(org, actorId, "open");
    const run = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
    assert.equal(run.posted, 1, `expected one posting, got ${JSON.stringify(run.problems)}`);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("runDepreciation skips a user-closed GL period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const assetId = await seedStraightLineAsset(org, actorId, "user");
    await closeGlForUser(org, actorId);
    const before = await journalCount(org.orgId);
    const run = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
    assert.equal(run.posted, 0, "a user-closed period must post nothing");
    assert.ok(run.skipped >= 1, "the closed line must be skipped, not posted");
    assert.ok(
      run.problems.some((p) => /closed/i.test(p)),
      `problems must name the closed period, got ${JSON.stringify(run.problems)}`,
    );
    assert.equal(await journalCount(org.orgId), before, "skipped depreciation left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("runDepreciation skips a source-owned imported lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const assetId = await seedStraightLineAsset(org, actorId, "imported");
    await closeAllImported(org);
    const before = await journalCount(org.orgId);
    const run = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
    assert.equal(run.posted, 0, "an imported lock must post nothing: posting is new activity, not replay");
    assert.ok(run.skipped >= 1, "the locked line must be skipped, not posted");
    assert.ok(
      run.problems.some((p) => /closed/i.test(p)),
      `problems must name the closed period, got ${JSON.stringify(run.problems)}`,
    );
    assert.equal(await journalCount(org.orgId), before, "skipped depreciation left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("recordDepreciationInput refuses a user-closed period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const { assetId, evidenceFileId } = await seedManualAsset(org, actorId, "user");
    await closeGlForUser(org, actorId);
    await assert.rejects(
      recordDepreciationInput({
        orgId: org.orgId, assetId, effectiveDate: org.date, kind: "manual",
        value: "100.0000", memo: "Gate probe user-closed", evidenceFileId, actorId,
      }),
      /the asset or GL period is closed/,
      "manual input into a user-closed period must be refused",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("recordDepreciationInput refuses a source-owned imported lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const { assetId, evidenceFileId } = await seedManualAsset(org, actorId, "imported");
    await closeAllImported(org);
    await assert.rejects(
      recordDepreciationInput({
        orgId: org.orgId, assetId, effectiveDate: org.date, kind: "manual",
        value: "100.0000", memo: "Gate probe imported", evidenceFileId, actorId,
      }),
      /the asset or GL period is closed/,
      "manual input into an imported lock must be refused: recording evidence is not replay",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

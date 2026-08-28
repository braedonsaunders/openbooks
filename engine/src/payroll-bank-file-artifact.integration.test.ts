import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool, withOrgContext } from "./db.ts";
import { releasePayRunBankFile } from "./payroll-bank-file-artifact.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const MIGRATION = readFileSync(
  new URL("../../schema/migrations/generated/0075_payroll_bank_file_release_status_evidence.sql", import.meta.url),
  "utf8",
);

type BankFileFixture = {
  org: ScratchOrg;
  artifactId: string;
  documentId: string;
  actorId: string;
};

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current && typeof current === "object") {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string") messages.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return messages.join("\n");
}

/**
 * Keep this fixture deliberately below the payroll generation pipeline. These
 * tests exercise the database release boundary and the release reader; a
 * complete pay-run calculation is already covered by payroll-bank-file.test.ts.
 */
async function bankFileFixture(): Promise<BankFileFixture> {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    const documentId = randomUUID();
    const scheduleId = randomUUID();
    const formatId = randomUUID();
    const profileId = randomUUID();
    const folderId = randomUUID();
    const fileId = randomUUID();
    const versionId = randomUUID();
    const artifactId = randomUUID();
    const bytes = Buffer.from("payroll-bank-file-release-evidence\n", "utf8");
    const contentHash = createHash("sha256").update(bytes).digest("hex");

    await db.execute(sql`
      insert into pay_schedules
        (id, org_id, name, frequency, periods_per_year, anchor_period_end,
         pay_date_offset_days, is_active)
      values
        (${scheduleId}, ${org.orgId}, ${"Release evidence " + artifactId.slice(0, 8)},
         'biweekly', 26, '2026-07-18', 3, true)`);
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, document_date, currency, status,
         subtotal, tax_total, total, custom, extra_dims)
      values
        (${documentId}, ${org.orgId}, 'pay_run', ${"PAY-" + artifactId.slice(0, 8)},
         '2026-07-18', 'CAD', 'committed', '1', '0', '1', '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`
      insert into pay_runs
        (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
         tax_year, run_status, run_type, gross_total, net_total, employer_cost_total,
         employee_count)
      values
        (${documentId}, ${org.orgId}, ${scheduleId}, '2026-07-05', '2026-07-18',
         '2026-07-21', 2026, 'committed', 'regular', '1', '1', '1', 1)`);
    await db.execute(sql`
      insert into payment_formats
        (id, org_id, code, name, rail, direction, country, currency,
         file_extension, content_type, settings, is_active)
      values
        (${formatId}, ${org.orgId}, ${"RELEASE-" + artifactId.slice(0, 8)},
         'Release evidence test format', 'nacha_credit', 'credit', 'CA', 'CAD',
         'ach', 'text/plain; charset=us-ascii', '{}'::jsonb, true)`);
    await db.execute(sql`
      insert into payment_bank_profiles
        (id, org_id, name, bank_account_id, payment_format_id, currency, country,
         settings, is_active)
      values
        (${profileId}, ${org.orgId}, ${"Release evidence " + artifactId.slice(0, 8)},
         ${org.accounts.bank}, ${formatId}, 'CAD', 'CA', '{}'::jsonb, true)`);
    await db.execute(sql`
      insert into folders
        (id, org_id, name, is_system, is_private)
      values
        (${folderId}, ${org.orgId}, ${"Release evidence " + artifactId.slice(0, 8)}, false, true)`);
    await db.execute(sql`
      insert into files
        (id, org_id, folder_id, name, extension, file_type, content_type,
         size_bytes, storage_kind, content_hash)
      values
        (${fileId}, ${org.orgId}, ${folderId}, 'release-evidence.ach', 'ach', 'other',
         'text/plain; charset=us-ascii', ${bytes.length}, 'db', ${contentHash})`);
    await db.execute(sql`
      insert into file_versions
        (id, file_id, version_number, size_bytes, content_type, storage_kind, content_hash)
      values
        (${versionId}, ${fileId}, 1, ${bytes.length}, 'text/plain; charset=us-ascii',
         'db', ${contentHash})`);
    await db.execute(sql`
      update files set current_version_id = ${versionId} where id = ${fileId}`);
    await db.execute(sql`
      insert into file_blobs (version_id, bytes) values (${versionId}, ${bytes})`);
    await db.execute(sql`
      insert into pay_run_bank_files
        (id, org_id, pay_run_document_id, payment_bank_profile_id, format,
         sequence_number, file_number, sequence_value, file_id_modifier,
         filename, content_type, content_hash, size_bytes, file_id, file_version_id,
         entry_count, control_total, currency, excluded_cheque, excluded_total,
         status)
      values
        (${artifactId}, ${org.orgId}, ${documentId}, ${profileId}, 'nacha',
         1, ${"PBF-" + artifactId.slice(0, 8)}, 1, 'A',
         'release-evidence.ach', 'text/plain; charset=us-ascii', ${contentHash},
         ${bytes.length}, ${fileId}, ${versionId}, 1, '1', 'CAD', '[]'::jsonb, '0',
         'generated')`);

    return { org, artifactId, documentId, actorId };
  } catch (error) {
    await dropScratchOrgReporting(org.orgId);
    throw error;
  }
}

test("payroll bank-file release records valid evidence at the storage boundary", { skip: !DB }, async () => {
  const fixture = await bankFileFixture();
  try {
    const released = await releasePayRunBankFile(
      fixture.org.orgId,
      fixture.artifactId,
      fixture.actorId,
    );
    assert.equal(released.artifact.status, "released");
    assert.equal(released.artifact.releaseCount, 1);
    assert.ok(released.artifact.firstReleasedAt);
    assert.ok(released.artifact.lastReleasedAt);

    const row = (await db.execute<{
      status: string;
      releaseCount: number;
      firstReleasedAt: string | null;
      lastReleasedAt: string | null;
    }>(sql`
      select status, release_count as "releaseCount",
             first_released_at as "firstReleasedAt",
             last_released_at as "lastReleasedAt"
        from pay_run_bank_files
       where org_id = ${fixture.org.orgId} and id = ${fixture.artifactId}`)).rows[0]!;
    assert.deepEqual(row, {
      status: "released",
      releaseCount: 1,
      firstReleasedAt: row.firstReleasedAt,
      lastReleasedAt: row.lastReleasedAt,
    });
  } finally {
    await dropScratchOrgReporting(fixture.org.orgId);
  }
});

test("payroll bank-file status cannot be changed without release evidence", { skip: !DB }, async () => {
  const fixture = await bankFileFixture();
  try {
    await assert.rejects(
      db.execute(sql`
        update pay_run_bank_files
           set status = 'released'
         where org_id = ${fixture.org.orgId} and id = ${fixture.artifactId}`),
      (error) => errorChain(error).includes("pay_run_bank_files_release_evidence"),
    );
    await assert.rejects(
      db.execute(sql`
        update pay_run_bank_files
           set release_count = 1,
               first_released_at = now(),
               last_released_at = now()
         where org_id = ${fixture.org.orgId} and id = ${fixture.artifactId}`),
      (error) => errorChain(error).includes("pay_run_bank_files_release_evidence"),
    );
  } finally {
    await dropScratchOrgReporting(fixture.org.orgId);
  }
});

test("0075 payroll bank-file release migration replays cleanly", { skip: !DB }, async () => {
  await pool.query(MIGRATION);
  await pool.query(MIGRATION);
  const constraint = (await db.execute<{ validated: boolean }>(sql`
    select convalidated as validated
      from pg_constraint
     where conrelid = 'public.pay_run_bank_files'::regclass
       and conname = 'pay_run_bank_files_release_evidence'`)).rows[0];
  assert.deepEqual(constraint, { validated: true });
});

test("payroll bank-file release is tenant-isolated", { skip: !DB }, async () => {
  const fixture = await bankFileFixture();
  const otherOrg = await createScratchOrg();
  try {
    await assert.rejects(
      withOrgContext(otherOrg.orgId, () =>
        releasePayRunBankFile(otherOrg.orgId, fixture.artifactId, fixture.actorId)),
      /payroll bank file not found/,
    );
    const row = (await db.execute<{ status: string; releaseCount: number }>(sql`
      select status, release_count as "releaseCount"
        from pay_run_bank_files
       where org_id = ${fixture.org.orgId} and id = ${fixture.artifactId}`)).rows[0]!;
    assert.deepEqual(row, { status: "generated", releaseCount: 0 });
  } finally {
    await dropScratchOrgReporting(otherOrg.orgId);
    await dropScratchOrgReporting(fixture.org.orgId);
  }
});

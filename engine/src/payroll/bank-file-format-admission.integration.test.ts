import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const MIGRATION_0201 = readFileSync(
  new URL("../../../schema/migrations/generated/0201_pay_run_bank_file_sepa_cemtex.sql", import.meta.url),
  "utf8",
);
const MIGRATION_0206 = readFileSync(
  new URL("../../../schema/migrations/generated/0206_pay_run_bank_file_bacs.sql", import.meta.url),
  "utf8",
);
const MIGRATION_0211 = readFileSync(
  new URL("../../../schema/migrations/generated/0211_pay_run_bank_file_zengin_cnab240.sql", import.meta.url),
  "utf8",
);

/**
 * Migration 0201 admits `sepa` and `cemtex` to pay_run_bank_files; migration
 * 0206 admits `bacs` on top of 0201; migration 0211 admits `zengin` and
 * `cnab240` on top of 0206 — one ordinal for both formats together.
 *
 * The defect (both times): the format CHECK admitted only the formats known
 * so far, AND the numbering twin was an OR of exactly N arms, each REQUIRING
 * a format-specific shape — so widening only the format CHECK would still
 * have refused every new-format row. Each migration drops and re-adds BOTH
 * constraints with one honest arm per format.
 *
 * The positive inserts below replicate the artifact writer's own write
 * column-for-column. Verified against the code (not inferred):
 * engine/src/payroll/bank-file-artifact.ts writes
 * `fileCreationNumber = format === "cpa005" ? ... : null` and
 * `fileIdModifier = format === "nacha" ? ... : null`, so sepa, cemtex and
 * bacs all store NULL in BOTH numbering columns, with traceability in
 * sequence_value (SEPA's messageId is the fileNumber derived from that same
 * allocation; the Bacs VOL1 serial and UHL1 file number are locals passed to
 * the renderer and live in the file bytes, the Cemtex precedent — and the
 * same holds for zengin's bank-facing identity and cnab240's NSA arquivo
 * sequence, whose writers live on their own branches). A full
 * generatePayRunBankFile drive is not possible here: no EUR/AUD/GBP
 * calculation fixture exists on main to produce a committed run for those
 * rails, so the insert asserts exactly what the writer emits.
 *
 * The negative half is the point: admitting two formats must not stop
 * checking the other two. Every malformed row below must still be refused
 * BY CONSTRAINT NAME.
 */

type BankFileParents = {
  org: ScratchOrg;
  documentId: string;
  profileId: string;
  fileId: string;
  versionId: string;
  contentHash: string;
  sizeBytes: number;
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

/** First SQLSTATE found walking the error/cause chain (drizzle nests the driver error). */
function errorCode(error: unknown): unknown {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Scratch org with every parent row a pay_run_bank_files insert requires. */
async function bankFileParents(tag: string): Promise<BankFileParents> {
  const org = await createScratchOrg();
  try {
    const documentId = randomUUID();
    const scheduleId = randomUUID();
    const formatId = randomUUID();
    const profileId = randomUUID();
    const folderId = randomUUID();
    const fileId = randomUUID();
    const versionId = randomUUID();
    const bytes = Buffer.from(`payroll-bank-file-format-admission-${tag}\n`, "utf8");
    const contentHash = createHash("sha256").update(bytes).digest("hex");

    await db.execute(sql`
      insert into pay_schedules
        (id, org_id, name, frequency, periods_per_year, anchor_period_end,
         pay_date_offset_days, is_active)
      values
        (${scheduleId}, ${org.orgId}, ${"Format admission " + tag},
         'biweekly', 26, '2026-07-18', 3, true)`);
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, document_date, currency, status,
         subtotal, tax_total, total, custom, extra_dims)
      values
        (${documentId}, ${org.orgId}, 'pay_run', ${"PAY-" + tag},
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
        (${formatId}, ${org.orgId}, ${"ADMIT-" + tag},
         'Format admission test format', 'nacha_credit', 'credit', 'CA', 'CAD',
         'ach', 'text/plain; charset=us-ascii', '{}'::jsonb, true)`);
    await db.execute(sql`
      insert into payment_bank_profiles
        (id, org_id, name, bank_account_id, payment_format_id, currency, country,
         settings, is_active)
      values
        (${profileId}, ${org.orgId}, ${"Format admission " + tag},
         ${org.accounts.bank}, ${formatId}, 'CAD', 'CA', '{}'::jsonb, true)`);
    await db.execute(sql`
      insert into folders
        (id, org_id, name, is_system, is_private)
      values
        (${folderId}, ${org.orgId}, ${"Format admission " + tag}, false, true)`);
    await db.execute(sql`
      insert into files
        (id, org_id, folder_id, name, extension, file_type, content_type,
         size_bytes, storage_kind, content_hash)
      values
        (${fileId}, ${org.orgId}, ${folderId}, 'format-admission.ach', 'ach', 'other',
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

    return { org, documentId, profileId, fileId, versionId, contentHash, sizeBytes: bytes.length };
  } catch (error) {
    await dropScratchOrgReporting(org.orgId);
    throw error;
  }
}

async function insertArtifact(
  fx: BankFileParents,
  row: {
    format: string;
    sequenceNumber: number;
    sequenceValue: number;
    fileCreationNumber: number | null;
    fileIdModifier: string | null;
  },
): Promise<string> {
  const artifactId = randomUUID();
  await db.execute(sql`
    insert into pay_run_bank_files
      (id, org_id, pay_run_document_id, payment_bank_profile_id, format,
       sequence_number, file_number, sequence_value, file_creation_number, file_id_modifier,
       filename, content_type, content_hash, size_bytes, file_id, file_version_id,
       entry_count, control_total, currency, excluded_cheque, excluded_total,
       status)
    values
      (${artifactId}, ${fx.org.orgId}, ${fx.documentId}, ${fx.profileId}, ${row.format},
       ${row.sequenceNumber}, ${"PBF-" + String(row.sequenceValue).padStart(6, "0")},
       ${row.sequenceValue}, ${row.fileCreationNumber}, ${row.fileIdModifier},
       'format-admission.ach', 'text/plain; charset=us-ascii', ${fx.contentHash},
       ${fx.sizeBytes}, ${fx.fileId}, ${fx.versionId}, 1, '1', 'CAD', '[]'::jsonb, '0',
       'generated')`);
  return artifactId;
}

before(async () => {
  if (DB) {
    // Each migration assumes its predecessor has run: apply in ordinal
    // order, each twice to prove the replay the header promises.
    await pool.query(MIGRATION_0201);
    await pool.query(MIGRATION_0201);
    await pool.query(MIGRATION_0206);
    await pool.query(MIGRATION_0206);
    await pool.query(MIGRATION_0211);
    await pool.query(MIGRATION_0211);
  }
});

test("0201 payroll bank-file format migration replays cleanly", { skip: !DB }, async () => {
  for (const name of ["pay_run_bank_files_format", "pay_run_bank_files_format_numbering"]) {
    const constraint = (await db.execute<{ validated: boolean }>(sql`
      select convalidated as validated
        from pg_constraint
       where conrelid = 'public.pay_run_bank_files'::regclass
         and conname = ${name}`)).rows[0];
    assert.deepEqual(constraint, { validated: true }, `${name} must be present and validated`);
  }
});

test("0206 admits bacs to both constraints with a fifth null-null arm", { skip: !DB }, async () => {
  const defs = (await db.execute<{ name: string; def: string }>(sql`
    select conname as name, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conrelid = 'public.pay_run_bank_files'::regclass
       and conname in ('pay_run_bank_files_format', 'pay_run_bank_files_format_numbering')`)).rows;
  const format = defs.find((row) => row.name === "pay_run_bank_files_format")!;
  const numbering = defs.find((row) => row.name === "pay_run_bank_files_format_numbering")!;
  assert.ok(format.def.includes("'bacs'"), `format gate must name bacs, got: ${format.def}`);
  assert.ok(
    numbering.def.includes("format = 'bacs'")
      && numbering.def.includes("file_creation_number IS NULL")
      && numbering.def.includes("file_id_modifier IS NULL"),
    `numbering gate must carry an exact bacs null-null arm, got: ${numbering.def}`,
  );
  // No permissive catch-all: every arm names its format.
  assert.doesNotMatch(numbering.def, /NOT IN/i);
});

test("sepa and cemtex artifacts insert with the writer's null-null numbering shape", { skip: !DB }, async () => {
  const fx = await bankFileParents("sepa-cemtex-ok");
  try {
    const sepaId = await insertArtifact(fx, {
      format: "sepa", sequenceNumber: 1, sequenceValue: 7,
      fileCreationNumber: null, fileIdModifier: null,
    });
    const cemtexId = await insertArtifact(fx, {
      format: "cemtex", sequenceNumber: 2, sequenceValue: 8,
      fileCreationNumber: null, fileIdModifier: null,
    });
    const rows = (await db.execute<{
      id: string; format: string; sequenceValue: number;
      fileCreationNumber: number | null; fileIdModifier: string | null;
    }>(sql`
      select id, format, sequence_value as "sequenceValue",
             file_creation_number as "fileCreationNumber",
             file_id_modifier as "fileIdModifier"
        from pay_run_bank_files
       where org_id = ${fx.org.orgId} and id in (${sepaId}, ${cemtexId})
       order by sequence_number`)).rows;
    assert.deepEqual(rows, [
      { id: sepaId, format: "sepa", sequenceValue: 7, fileCreationNumber: null, fileIdModifier: null },
      { id: cemtexId, format: "cemtex", sequenceValue: 8, fileCreationNumber: null, fileIdModifier: null },
    ]);
  } finally {
    await dropScratchOrgReporting(fx.org.orgId);
  }
});

test("the cpa005 and nacha arms still admit their own shapes", { skip: !DB }, async () => {
  const fx = await bankFileParents("legacy-ok");
  try {
    const cpaId = await insertArtifact(fx, {
      format: "cpa005", sequenceNumber: 1, sequenceValue: 1,
      fileCreationNumber: 7, fileIdModifier: null,
    });
    const nachaId = await insertArtifact(fx, {
      format: "nacha", sequenceNumber: 2, sequenceValue: 2,
      fileCreationNumber: null, fileIdModifier: "B",
    });
    const rows = (await db.execute<{ id: string; format: string }>(sql`
      select id, format from pay_run_bank_files
       where org_id = ${fx.org.orgId} and id in (${cpaId}, ${nachaId})`)).rows;
    assert.equal(rows.length, 2);
  } finally {
    await dropScratchOrgReporting(fx.org.orgId);
  }
});

test("bacs artifacts insert with the writer's null-null numbering shape", { skip: !DB }, async () => {
  const fx = await bankFileParents("bacs-ok");
  try {
    // sequence_value 9 derives bacsVolSerial 000009 / bacsFileNumber 009 in
    // the file bytes; the ROW carries NULL/NULL, the Cemtex precedent.
    const bacsId = await insertArtifact(fx, {
      format: "bacs", sequenceNumber: 1, sequenceValue: 9,
      fileCreationNumber: null, fileIdModifier: null,
    });
    const rows = (await db.execute<{
      id: string; format: string; sequenceValue: number;
      fileCreationNumber: number | null; fileIdModifier: string | null;
    }>(sql`
      select id, format, sequence_value as "sequenceValue",
             file_creation_number as "fileCreationNumber",
             file_id_modifier as "fileIdModifier"
        from pay_run_bank_files
       where org_id = ${fx.org.orgId} and id = ${bacsId}`)).rows;
    assert.deepEqual(rows, [
      { id: bacsId, format: "bacs", sequenceValue: 9, fileCreationNumber: null, fileIdModifier: null },
    ]);
  } finally {
    await dropScratchOrgReporting(fx.org.orgId);
  }
});

test("malformed bank-file rows are still refused by constraint name", { skip: !DB }, async () => {
  const fx = await bankFileParents("refused");
  try {
    // sepa must not carry a cpa005 number: the new arm states null-null.
    await assert.rejects(
      insertArtifact(fx, {
        format: "sepa", sequenceNumber: 11, sequenceValue: 11,
        fileCreationNumber: 1, fileIdModifier: null,
      }),
      (error) => errorChain(error).includes("pay_run_bank_files_format_numbering"),
      "sepa with a file_creation_number must be refused",
    );
    // cemtex must not carry a nacha modifier either.
    await assert.rejects(
      insertArtifact(fx, {
        format: "cemtex", sequenceNumber: 12, sequenceValue: 12,
        fileCreationNumber: null, fileIdModifier: "A",
      }),
      (error) => errorChain(error).includes("pay_run_bank_files_format_numbering"),
      "cemtex with a file_id_modifier must be refused",
    );
    // The legacy arms keep checking: cpa005 with a zero number, a modifier,
    // and nacha with a number are all still refused.
    await assert.rejects(
      insertArtifact(fx, {
        format: "cpa005", sequenceNumber: 13, sequenceValue: 13,
        fileCreationNumber: 0, fileIdModifier: null,
      }),
      (error) => errorChain(error).includes("pay_run_bank_files_format_numbering"),
      "cpa005 with file_creation_number = 0 must be refused",
    );
    await assert.rejects(
      insertArtifact(fx, {
        format: "cpa005", sequenceNumber: 14, sequenceValue: 14,
        fileCreationNumber: 3, fileIdModifier: "A",
      }),
      (error) => errorChain(error).includes("pay_run_bank_files_format_numbering"),
      "cpa005 with a file_id_modifier must be refused",
    );
    await assert.rejects(
      insertArtifact(fx, {
        format: "nacha", sequenceNumber: 15, sequenceValue: 15,
        fileCreationNumber: 5, fileIdModifier: "A",
      }),
      (error) => errorChain(error).includes("pay_run_bank_files_format_numbering"),
      "nacha with a file_creation_number must be refused",
    );
    // And the format gate still closes on unknown rails.
    await assert.rejects(
      insertArtifact(fx, {
        format: "swift", sequenceNumber: 16, sequenceValue: 16,
        fileCreationNumber: null, fileIdModifier: null,
      }),
      (error) => errorChain(error).includes("pay_run_bank_files_format"),
      "an unknown format must be refused by the format gate",
    );
    // bacs must not carry a cpa005 number or a nacha modifier either: its
    // arm states null-null, the writer never allocates either for bacs.
    await assert.rejects(
      insertArtifact(fx, {
        format: "bacs", sequenceNumber: 17, sequenceValue: 17,
        fileCreationNumber: 4, fileIdModifier: null,
      }),
      (error) => errorChain(error).includes("pay_run_bank_files_format_numbering"),
      "bacs with a file_creation_number must be refused",
    );
    await assert.rejects(
      insertArtifact(fx, {
        format: "bacs", sequenceNumber: 18, sequenceValue: 18,
        fileCreationNumber: null, fileIdModifier: "C",
      }),
      (error) => errorChain(error).includes("pay_run_bank_files_format_numbering"),
      "bacs with a file_id_modifier must be refused",
    );
    // zengin and cnab240 carry neither number: their arms state null-null,
    // and neither writer allocates either column.
    await assert.rejects(
      insertArtifact(fx, {
        format: "zengin", sequenceNumber: 19, sequenceValue: 19,
        fileCreationNumber: 6, fileIdModifier: null,
      }),
      (error) => errorChain(error).includes("pay_run_bank_files_format_numbering"),
      "zengin with a file_creation_number must be refused",
    );
    await assert.rejects(
      insertArtifact(fx, {
        format: "cnab240", sequenceNumber: 20, sequenceValue: 20,
        fileCreationNumber: null, fileIdModifier: "D",
      }),
      (error) => errorChain(error).includes("pay_run_bank_files_format_numbering"),
      "cnab240 with a file_id_modifier must be refused",
    );
    // None of the refused rows may have landed.
    const count = (await db.execute<{ count: string }>(sql`
      select count(*) as count from pay_run_bank_files
       where org_id = ${fx.org.orgId}`)).rows[0]!;
    assert.equal(count.count, "0");
  } finally {
    await dropScratchOrgReporting(fx.org.orgId);
  }
});

test("0211 admits zengin and cnab240 to both constraints with sixth and seventh null-null arms", { skip: !DB }, async () => {
  const defs = (await db.execute<{ name: string; def: string }>(sql`
    select conname as name, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conrelid = 'public.pay_run_bank_files'::regclass
       and conname in ('pay_run_bank_files_format', 'pay_run_bank_files_format_numbering')`)).rows;
  const format = defs.find((row) => row.name === "pay_run_bank_files_format")!;
  const numbering = defs.find((row) => row.name === "pay_run_bank_files_format_numbering")!;
  assert.ok(format.def.includes("'zengin'") && format.def.includes("'cnab240'"), `format gate must name zengin and cnab240, got: ${format.def}`);
  // The five earlier formats stay admitted: the re-ADD lists all seven.
  for (const name of ["'cpa005'", "'nacha'", "'sepa'", "'cemtex'", "'bacs'"]) {
    assert.ok(format.def.includes(name), `format gate must keep ${name}, got: ${format.def}`);
  }
  for (const name of ["zengin", "cnab240"]) {
    assert.ok(
      numbering.def.includes(`format = '${name}'`)
        && numbering.def.includes("file_creation_number IS NULL")
        && numbering.def.includes("file_id_modifier IS NULL"),
      `numbering gate must carry an exact ${name} null-null arm, got: ${numbering.def}`,
    );
  }
  // No permissive catch-all: every arm names its format.
  assert.doesNotMatch(numbering.def, /NOT IN/i);
});

test("zengin and cnab240 artifacts insert with the writer's null-null numbering shape", { skip: !DB }, async () => {
  const fx = await bankFileParents("zengin-cnab240-ok");
  try {
    // zengin's bank-facing identity is a renderer local derived from the
    // same sequenceValue allocation and lives in the file bytes; cnab240's
    // NSA arquivo sequence (sequence_value 7 derives NSA 000007) likewise.
    // Both ROWS carry NULL/NULL, the sepa/cemtex/bacs precedent.
    const zenginId = await insertArtifact(fx, {
      format: "zengin", sequenceNumber: 1, sequenceValue: 7,
      fileCreationNumber: null, fileIdModifier: null,
    });
    const cnabId = await insertArtifact(fx, {
      format: "cnab240", sequenceNumber: 2, sequenceValue: 8,
      fileCreationNumber: null, fileIdModifier: null,
    });
    const rows = (await db.execute<{
      id: string; format: string; sequenceValue: number;
      fileCreationNumber: number | null; fileIdModifier: string | null;
    }>(sql`
      select id, format, sequence_value as "sequenceValue",
             file_creation_number as "fileCreationNumber",
             file_id_modifier as "fileIdModifier"
        from pay_run_bank_files
       where org_id = ${fx.org.orgId} and id in (${zenginId}, ${cnabId})
       order by sequence_number`)).rows;
    assert.deepEqual(rows, [
      { id: zenginId, format: "zengin", sequenceValue: 7, fileCreationNumber: null, fileIdModifier: null },
      { id: cnabId, format: "cnab240", sequenceValue: 8, fileCreationNumber: null, fileIdModifier: null },
    ]);
  } finally {
    await dropScratchOrgReporting(fx.org.orgId);
  }
});

test("red-proof: without 0206 the bacs insert dies on the format gate", { skip: !DB }, async () => {
  // It temporarily restores the 0201-only state (both constraints dropped
  // and re-added without bacs), proves the bacs row is refused there, then
  // re-applies 0206 and proves the same row inserts again. The 0211
  // red-proof runs after this one and leaves 0211 applied.
  const fx = await bankFileParents("bacs-redproof");
  try {
    await pool.query(MIGRATION_0201);
    const outcome: { inserted: true } | { inserted: false; code: unknown; chain: string } =
      await insertArtifact(fx, {
        format: "bacs", sequenceNumber: 1, sequenceValue: 21,
        fileCreationNumber: null, fileIdModifier: null,
      }).then(
        () => ({ inserted: true as const }),
        (error: unknown) => ({
          inserted: false as const,
          code: errorCode(error),
          chain: errorChain(error),
        }),
      );
    assert.equal(outcome.inserted, false, "without 0206 the bacs insert must be refused");
    if (!outcome.inserted) {
      // The exact refusal the gate must produce: SQLSTATE 23514 naming the
      // format CHECK. The code rides on the nested driver error, not the
      // outer message — assert both halves so the quote below is literal.
      assert.equal(outcome.code, "23514", `expected SQLSTATE 23514, got: ${outcome.chain}`);
      assert.ok(
        outcome.chain.includes('violates check constraint "pay_run_bank_files_format"'),
        `without 0206 the bacs insert must die on the format gate, got: ${outcome.chain}`,
      );
    }
    const refused = (await db.execute<{ count: string }>(sql`
      select count(*) as count from pay_run_bank_files
       where org_id = ${fx.org.orgId}`)).rows[0]!;
    assert.equal(refused.count, "0");
    await pool.query(MIGRATION_0206);
    const bacsId = await insertArtifact(fx, {
      format: "bacs", sequenceNumber: 1, sequenceValue: 21,
      fileCreationNumber: null, fileIdModifier: null,
    });
    const rows = (await db.execute<{ id: string }>(sql`
      select id from pay_run_bank_files
       where org_id = ${fx.org.orgId} and id = ${bacsId}`)).rows;
    assert.equal(rows.length, 1);
  } finally {
    await dropScratchOrgReporting(fx.org.orgId);
  }
});

test("red-proof: without 0211 the zengin and cnab240 inserts die on the format gate", { skip: !DB }, async () => {
  // Defined last so it runs last: it temporarily restores the 0206-only
  // state (both constraints dropped and re-added without zengin/cnab240),
  // proves both rows are refused there, then re-applies 0211 and proves the
  // same rows insert again — so the file leaves the database exactly as it
  // found it.
  const fx = await bankFileParents("zengin-cnab240-redproof");
  try {
    await pool.query(MIGRATION_0206);
    for (const format of ["zengin", "cnab240"]) {
      const outcome: { inserted: true } | { inserted: false; code: unknown; chain: string } =
        await insertArtifact(fx, {
          format, sequenceNumber: 1, sequenceValue: 21,
          fileCreationNumber: null, fileIdModifier: null,
        }).then(
          () => ({ inserted: true as const }),
          (error: unknown) => ({
            inserted: false as const,
            code: errorCode(error),
            chain: errorChain(error),
          }),
        );
      assert.equal(outcome.inserted, false, `without 0211 the ${format} insert must be refused`);
      if (!outcome.inserted) {
        // The exact refusal the gate must produce: SQLSTATE 23514 naming
        // the format CHECK. The code rides on the nested driver error, not
        // the outer message — assert both halves so the quote is literal.
        assert.equal(outcome.code, "23514", `expected SQLSTATE 23514, got: ${outcome.chain}`);
        assert.ok(
          outcome.chain.includes('violates check constraint "pay_run_bank_files_format"'),
          `without 0211 the ${format} insert must die on the format gate, got: ${outcome.chain}`,
        );
      }
    }
    const refused = (await db.execute<{ count: string }>(sql`
      select count(*) as count from pay_run_bank_files
       where org_id = ${fx.org.orgId}`)).rows[0]!;
    assert.equal(refused.count, "0");
    await pool.query(MIGRATION_0211);
    const zenginId = await insertArtifact(fx, {
      format: "zengin", sequenceNumber: 1, sequenceValue: 21,
      fileCreationNumber: null, fileIdModifier: null,
    });
    const cnabId = await insertArtifact(fx, {
      format: "cnab240", sequenceNumber: 2, sequenceValue: 22,
      fileCreationNumber: null, fileIdModifier: null,
    });
    const rows = (await db.execute<{ id: string }>(sql`
      select id from pay_run_bank_files
       where org_id = ${fx.org.orgId} and id in (${zenginId}, ${cnabId})`)).rows;
    assert.equal(rows.length, 2);
  } finally {
    await dropScratchOrgReporting(fx.org.orgId);
  }
});

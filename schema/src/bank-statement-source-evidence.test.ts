/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..", "..");
const migration = readFileSync(
  join(
    root,
    "schema",
    "migrations",
    "generated",
    "0010_bank_statement_source_evidence.sql",
  ),
  "utf8",
);
const sourceIdempotencyMigration = readFileSync(
  join(
    root,
    "schema",
    "migrations",
    "generated",
    "0036_bank_statement_source_idempotency.sql",
  ),
  "utf8",
);
const bootstrap = readFileSync(join(root, "scripts", "bootstrap.ts"), "utf8");
const bankingSchema = readFileSync(
  join(root, "schema", "src", "banking.ts"),
  "utf8",
);

test("legacy statements receive honest append-only gap evidence before NOT NULL", () => {
  const backfillStart = migration.indexOf("WITH legacy_statement AS MATERIALIZED");
  const verificationStart = migration.indexOf(
    "DO $bank_statement_source_evidence_verification$",
  );
  const notNullStart = migration.indexOf("ALTER COLUMN raw_file_ref SET NOT NULL");

  assert.notEqual(backfillStart, -1);
  assert.ok(verificationStart > backfillStart);
  assert.ok(notNullStart > verificationStart);

  const backfill = migration.slice(backfillStart, verificationStart);
  assert.match(backfill, /INSERT INTO public\.audit_log/);
  assert.match(backfill, /'provenance', 'legacy_source_unavailable'/);
  assert.match(backfill, /'sourceAvailable', false/);
  assert.match(backfill, /#evidence=legacy-source-unavailable/);
  assert.doesNotMatch(backfill, /sha256/i);
  assert.match(
    backfill,
    /UPDATE public\.bank_statements[\s\S]*SET raw_file_ref = format/,
  );

  assert.match(migration, /WHERE raw_file_ref IS NULL/);
  assert.match(migration, /RAISE EXCEPTION/);
  assert.doesNotMatch(
    migration,
    /cannot require bank statement source evidence/,
  );
  assert.match(
    sourceIdempotencyMigration,
    /raw_file_ref ~ '#sha256=\[0-9a-f\]\{64\}\$'/,
  );
  assert.doesNotMatch(
    "audit-log:00000000-0000-0000-0000-000000000001#evidence=legacy-source-unavailable",
    /#sha256=[0-9a-f]{64}$/,
  );
});

test("the published migration advances only through its exact reapply digest", () => {
  const digest = createHash("sha256").update(migration).digest("hex");
  const transitionStart = bootstrap.indexOf(
    'filename: "generated/0010_bank_statement_source_evidence.sql"',
  );
  assert.notEqual(transitionStart, -1);

  const transition = bootstrap.slice(transitionStart, transitionStart + 1_500);
  assert.match(
    transition,
    /from: "577f345ac58b2b585fce5802f2895234c2a0494e2835677ad223d735280e2ec6"/,
  );
  assert.match(transition, new RegExp(`to: "${digest}"`));
  assert.match(transition, /strategy: "reapply"/);

  assert.match(
    bootstrap,
    /transition\.strategy === "reapply"[\s\S]*executeTrackedMigration\(filename, content, digest, recorded\)/,
  );
  assert.match(
    bootstrap,
    /where filename = \$2 and sha256 = \$3/,
  );
  assert.match(
    bootstrap,
    /changed after it was applied; published migrations are immutable/,
  );
});

test("the schema contract distinguishes exact bytes from a legacy gap attestation", () => {
  assert.match(bankingSchema, /audit-log:<id>#sha256=<hash>/);
  assert.match(
    bankingSchema,
    /audit-log:<id>#evidence=legacy-source-unavailable/,
  );
});

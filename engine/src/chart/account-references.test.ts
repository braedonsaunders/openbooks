import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { releaseSchemaFiles } from "../../../scripts/release-schema-sql.mjs";
import {
  ACCOUNT_JSON_REFERENCES,
  ACCOUNT_REFERENCE_OWNED,
  ACCOUNT_REFERENCE_RULES,
  classifyAccountReference,
} from "./account-references.ts";

// source-pin-contract: merge reference classification — every foreign key into accounts that the release schema declares must be classified as configuration or history; subjects derived from the schema, never hand-listed.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Every published foreign key into accounts, read from the release schema
 * (baseline, then forward migrations in apply order):
 * `ALTER TABLE [ONLY] ... ADD CONSTRAINT ... FOREIGN KEY (org_id, col)
 * REFERENCES public.accounts(...)` and inline table constraints alike, with
 * later table renames carried forward.
 */
function publishedAccountForeignKeys(): Set<string> {
  const found = new Set<string>();
  for (const { path } of releaseSchemaFiles(REPO_ROOT)) {
    const source = readFileSync(path, "utf8");
    for (const rename of source.matchAll(
      /ALTER TABLE (?:ONLY )?(?:public\.)?([a-z_0-9]+)\s+RENAME TO ([a-z_0-9]+)\s*;/gi,
    )) {
      for (const key of [...found]) {
        if (key.startsWith(`${rename[1]}.`)) {
          found.delete(key);
          found.add(`${rename[2]}.${key.slice(rename[1]!.length + 1)}`);
        }
      }
    }
    for (const statement of source.matchAll(
      /ALTER TABLE (?:ONLY )?(?:public\.)?([a-z_0-9]+)\s+([\s\S]*?);/gi,
    )) {
      for (const fk of statement[2]!.matchAll(
        /FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES (?:public\.)?accounts\s*\(/gi,
      )) {
        for (const column of fk[1]!.split(",").map((part) => part.trim())) {
          if (column !== "org_id") found.add(`${statement[1]}.${column}`);
        }
      }
    }
    for (const table of source.matchAll(
      /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?([a-z_0-9]+)\s*\(([\s\S]*?)\n\);/gi,
    )) {
      for (const fk of table[2]!.matchAll(
        /FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES (?:public\.)?accounts\s*\(/gi,
      )) {
        for (const column of fk[1]!.split(",").map((part) => part.trim())) {
          if (column !== "org_id") found.add(`${table[1]}.${column}`);
        }
      }
    }
  }
  return found;
}

test("every published foreign key into accounts is classified for a merge", () => {
  const published = publishedAccountForeignKeys();
  assert.ok(
    published.size > 50,
    `expected the account foreign keys to be found, saw ${published.size}`,
  );
  const unclassified = [...published].filter((key) => {
    const [table, column] = key.split(".") as [string, string];
    return classifyAccountReference({ table, column }) === null;
  });
  assert.deepEqual(
    unclassified,
    [],
    "classify each new reference as configuration (redirect) or history in ACCOUNT_REFERENCE_RULES",
  );
});

test("rules and merge-owned columns never overlap, and keys name one column", () => {
  for (const key of Object.keys(ACCOUNT_REFERENCE_RULES)) {
    assert.match(key, /^[a-z_0-9]+\.[a-z_0-9]+$/);
    assert.equal(ACCOUNT_REFERENCE_OWNED.has(key), false, `${key} is both owned and ruled`);
  }
  assert.equal(classifyAccountReference({ table: "journal_lines", column: "account_id" }), "owned");
  assert.equal(classifyAccountReference({ table: "brand_new_table", column: "account_id" }), null);
});

test("posted facts are history and in-flight documents block rather than move", () => {
  assert.equal(
    ACCOUNT_REFERENCE_RULES["pay_stub_lines.expense_account_id"]?.disposition,
    "history",
  );
  assert.equal(ACCOUNT_REFERENCE_RULES["bank_statements.account_id"]?.disposition, "history");
  const lines = ACCOUNT_REFERENCE_RULES["document_lines.account_id"]!;
  assert.equal(lines.disposition, "redirect");
  assert.ok(lines.redirectWhere, "only draft document lines move");
  assert.ok(lines.blockWhere, "documents awaiting approval block the merge");
  assert.equal(ACCOUNT_REFERENCE_RULES["tax_codes.collected_account_id"]?.disposition, "redirect");
  assert.equal(ACCOUNT_REFERENCE_RULES["tax_codes.collected_account_id"]?.redirectWhere, undefined);
});

test("JSON references are uniquely keyed and organization-scoped", () => {
  const keys = ACCOUNT_JSON_REFERENCES.map((ref) => ref.key);
  assert.equal(new Set(keys).size, keys.length);
  const controls = ACCOUNT_JSON_REFERENCES.find(
    (ref) => ref.key === "orgs.settings.controlAccounts",
  );
  assert.equal(controls?.orgColumn, "id");
  assert.equal(controls?.path, "controlAccounts");
  const camPools = ACCOUNT_JSON_REFERENCES.find(
    (ref) => ref.key === "cam_pools.expense_account_ids",
  );
  assert.ok(camPools?.scope, "only editable CAM pools can move account references");
  assert.ok(camPools?.blockWhere, "sealed CAM pools block account merges");
  assert.ok(
    ACCOUNT_JSON_REFERENCES.filter((ref) => ref.table !== "orgs").every(
      (ref) => ref.orgColumn === "org_id",
    ),
  );
});

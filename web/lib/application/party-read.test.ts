import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./party-read.ts", import.meta.url), "utf8");
const VIEW = readFileSync(new URL("../../app/(app)/parties/view.ts", import.meta.url), "utf8");

test("party role lists use the directory role predicates and keep credit limit exact", () => {
  assert.match(SOURCE, /from customer_roles r where r\.party_id = p\.id and r\.org_id = p\.org_id and r\.is_active/);
  assert.match(SOURCE, /from vendor_roles r where r\.party_id = p\.id and r\.org_id = p\.org_id and r\.is_active/);
  assert.match(SOURCE, /from employee_roles r where r\.party_id = p\.id and r\.org_id = p\.org_id and r\.is_active/);
  assert.match(VIEW, /from customer_roles r where r\.party_id = p\.id and r\.org_id = p\.org_id and r\.is_active/);
  assert.match(SOURCE, /credit_limit::text as credit_limit/);
  assert.match(SOURCE, /normalizeMoneyValue\(String\(row\.credit_limit\)\)/);
  assert.doesNotMatch(SOURCE, /\bnum\(/);
  assert.match(SOURCE, /subsidiaryVisibleFilter\(sql`p\.subsidiary_id`/);
  assert.match(SOURCE, /orgWideNull: true/);
});

test("party role lists never select sealed identity columns", () => {
  assert.doesNotMatch(SOURCE, /tin_encrypted|tin_last4|birth_date|government_id/i);
});

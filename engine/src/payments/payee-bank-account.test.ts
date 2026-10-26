import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { payablePayeeBankAccountSql, payeeBankStateSql } from "./payee-bank-account.ts";
import { classifyPayeeBankAccount } from "./payment-contracts.ts";

const account = (overrides: Partial<Parameters<typeof classifyPayeeBankAccount>[0]> = {}) => ({
  approvalStatus: "approved",
  approvedAt: "2026-09-01",
  isActive: true,
  retiredAt: null,
  ...overrides,
});

const render = (fragment: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(fragment).sql;

test("an approved, dated, active bank account is the only payable state", () => {
  assert.equal(classifyPayeeBankAccount(account()), "approved");
});

test("an approved status without an approval date is undated, not payable", () => {
  assert.equal(classifyPayeeBankAccount(account({ approvedAt: null })), "undated");
});

test("pending details wait for approval and rejected details are missing", () => {
  assert.equal(
    classifyPayeeBankAccount(
      account({ approvalStatus: "pending", approvedAt: null, isActive: false }),
    ),
    "pending",
  );
  assert.equal(
    classifyPayeeBankAccount(
      account({ approvalStatus: "rejected", approvedAt: null, isActive: false }),
    ),
    "missing",
  );
});

test("a retired or inactive approved account is missing", () => {
  assert.equal(classifyPayeeBankAccount(account({ retiredAt: "2026-09-10" })), "missing");
  assert.equal(classifyPayeeBankAccount(account({ isActive: false })), "missing");
});

test("the payable predicate requires active, approved status, an approval date, and no retirement", () => {
  const text = render(payablePayeeBankAccountSql("b"));
  assert.match(text, /b\.is_active/);
  assert.match(text, /b\.approval_status = 'approved'/);
  assert.match(text, /b\.approved_at is not null/);
  assert.match(text, /b\.retired_at is null/);
});

test("the per-payee state ranks a payable account above pending above undated", () => {
  const text = render(payeeBankStateSql(sql`d.party_id`, sql`d.org_id`));
  const payable = text.indexOf("'approved'");
  const pending = text.indexOf("'pending'");
  const undated = text.indexOf("'undated'");
  const missing = text.indexOf("else 'missing'");
  assert.ok(payable > 0 && pending > payable && undated > pending && missing > undated, text);
  assert.match(text, /b\.party_id = d\.party_id and b\.org_id = d\.org_id/);
});

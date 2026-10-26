import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { LIABILITY_TYPES } from "@openbooks/engine/records/account-types";
import { LIABILITY_STATEMENT_ACCOUNT_TYPES } from "@openbooks/engine/banking/banking";
import { bankAccountMembership, reconcilableBankMembership } from "./banking-accounts";

const dialect = new PgDialect();

function render(query: ReturnType<typeof bankAccountMembership>) {
  return dialect.sqlToQuery(query);
}

test("the statement-capable liability set is the chart liability class", () => {
  assert.deepEqual([...LIABILITY_STATEMENT_ACCOUNT_TYPES].sort(), [...LIABILITY_TYPES].sort());
});

test("banking lists bank and card accounts unconditionally and other liabilities only when reconcilable", () => {
  const { sql: text, params } = render(bankAccountMembership());
  assert.match(
    text,
    /a\.reconcilable and a\.type in \(/,
    "statement-capable types are gated on the reconcilable flag",
  );
  const [unconditional = [], reconcilableOnly = []] = splitTypeLists(params);
  assert.deepEqual(unconditional, ["asset_bank", "liability_card"]);
  assert.deepEqual([...reconcilableOnly].sort(), [
    "asset_bank",
    "liability_card",
    "liability_current_other",
    "liability_long_term",
    "liability_payable",
  ]);
});

test("reconciliation eligibility keeps the reconcilable flag on top of banking membership", () => {
  const { sql: text } = render(reconcilableBankMembership());
  assert.match(text, /\)\s+and a\.reconcilable$/);
});

/** The membership predicate renders two type lists: the unconditional one, then the reconcilable one. */
function splitTypeLists(params: unknown[]): [string[], string[]] {
  const values = params.map(String);
  const unconditional = values.slice(0, 2);
  const reconcilableOnly = values.slice(2);
  return [unconditional, reconcilableOnly];
}

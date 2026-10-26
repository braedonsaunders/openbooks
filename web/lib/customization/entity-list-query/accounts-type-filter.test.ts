import assert from "node:assert/strict";
import test from "node:test";

const { defaultListView } = await import("@openbooks/customization");
const { accountWhere } = await import("./accounts.ts");
const { PgDialect } = await import("drizzle-orm/pg-core");

const ORG = "00000000-0000-0000-0000-000000000001";
const dialect = new PgDialect();

function compiled(query: Parameters<typeof dialect.sqlToQuery>[0]) {
  return dialect.sqlToQuery(query);
}

test("accountWhere narrows the list to one account type and binds the value", () => {
  const where = accountWhere(
    defaultListView("account"),
    { showInactive: true, filters: { type: "expense" } },
    ORG,
    null,
  );
  const { sql: text, params } = compiled(where);
  assert.match(text, /a\.type = \$\d+/);
  assert.ok(params.includes("expense"), "the type value must be a bound parameter");
});

test("accountWhere without a type filter does not constrain the type column", () => {
  const where = accountWhere(
    defaultListView("account"),
    { showInactive: true, filters: {} },
    ORG,
    null,
  );
  const { sql: text } = compiled(where);
  assert.doesNotMatch(text, /a\.type = \$/);
});

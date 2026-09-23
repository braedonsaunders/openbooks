import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGovernedSearchSql,
  searchFilterLiteral,
  unknownSearchTableRefusal,
} from "./scripting.ts";

const COLUMNS = ["id", "number", "name"];

// The injected key from the finding: spliced raw it rewrote the WHERE
// clause. The builder must refuse it BY NAME before any SQL runs.
test("an injected filter key is refused by name and builds no SQL", () => {
  const key = "1=1 UNION SELECT password FROM users --";
  assert.throws(
    () => buildGovernedSearchSql("accounts", { [key]: 1 }, COLUMNS),
    (e: unknown) =>
      e instanceof Error &&
      e.message.includes(`unknown search column "${key}"`) &&
      e.message.includes("accounts"),
  );
});

test("a shape-valid but unknown column is refused by name", () => {
  assert.throws(
    () => buildGovernedSearchSql("accounts", { password: "x" }, COLUMNS),
    /unknown search column "password" on accounts/,
  );
});

test("an invalid table name is refused", () => {
  assert.throws(
    () => buildGovernedSearchSql("accounts; DROP TABLE x", {}, COLUMNS),
    /invalid table/,
  );
});

test("non-object filters are refused", () => {
  assert.throws(
    () => buildGovernedSearchSql("accounts", "number = '5100'", COLUMNS),
    /must be an object of column = value pairs/,
  );
});

test("valid keys build quoted-identifier SQL with bound-style literals", () => {
  assert.equal(
    buildGovernedSearchSql("accounts", { number: "5100" }, COLUMNS),
    `select * from openbooks_query."accounts" where "number" = '5100' limit 1000`,
  );
});

test("filter values are data, never syntax", () => {
  assert.equal(searchFilterLiteral("O'Brien"), "'O''Brien'");
  assert.equal(searchFilterLiteral(null), "NULL");
  assert.equal(searchFilterLiteral(undefined), "NULL");
  assert.equal(searchFilterLiteral(12.5), "12.5");
  assert.equal(searchFilterLiteral(true), "TRUE");
  assert.equal(
    buildGovernedSearchSql("accounts", { name: `x' OR '1'='1` }, COLUMNS),
    `select * from openbooks_query."accounts" where "name" = 'x'' OR ''1''=''1' limit 1000`,
  );
});

test("empty filters read the whole view with no WHERE clause", () => {
  assert.equal(
    buildGovernedSearchSql("accounts", {}, COLUMNS),
    `select * from openbooks_query."accounts" limit 1000`,
  );
});

test("unknown-table refusal names the table and the remedy", () => {
  assert.match(unknownSearchTableRefusal("pg_shadow"), /unknown search table "pg_shadow"/);
  assert.match(unknownSearchTableRefusal("pg_shadow"), /openbooks_query/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cli = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
const provisionStart = cli.indexOf("async function provision()");
const provisionEnd = cli.indexOf("async function openbooksVoucherSnapshot(", provisionStart);
assert.ok(provisionStart >= 0 && provisionEnd > provisionStart);
const provision = cli.slice(provisionStart, provisionEnd);

test("parity provisioning derives bank currency from authoritative company and subsidiary data", () => {
  // A reconcilable account cannot silently assume a fixture currency. The
  // ERPNext company and OpenBooks subsidiary are the two sides of this
  // parity tenant; provisioning must validate them and use the validated
  // value for both bank-account representations.
  assert.match(provision, /default_currency/);
  assert.match(provision, /base_currency/);
  assert.match(provision, /resolveParityCurrency/);
  assert.match(provision, /currency_restriction/);
  assert.match(provision, /account_currency: parityCurrency/);
  assert.match(provision, /currency_restriction[\s\S]*?\$\{parityCurrency\}/);
  assert.doesNotMatch(provision, /account_currency:\s*["']CAD["']/);
  assert.doesNotMatch(provision, /currency_restriction[\s\S]{0,220}["']CAD["']/);
  assert.match(provision, /ledger parity currently supports CAD only/);
});

test("parity currency resolution fails closed instead of falling back", () => {
  // The resolver's guard is intentionally structural here because cli.ts is
  // an executable entrypoint. A missing source value or disagreement must be
  // an error, never a default such as CAD.
  const resolverStart = cli.indexOf("function resolveParityCurrency");
  assert.ok(resolverStart >= 0);
  const resolver = cli.slice(resolverStart, provisionStart);
  assert.match(resolver, /throw new Error/);
  assert.match(resolver, /erpCompanyCurrency/);
  assert.match(resolver, /openBooksSubsidiaryCurrency/);
  assert.match(resolver, /!==/);
  assert.doesNotMatch(resolver, /\?\?\s*["']CAD["']/);
});

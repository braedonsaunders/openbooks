import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migrationSource = readFileSync("engine/src/sync/source.ts", "utf8");
const loader = readFileSync("engine/src/sync/migrate.ts", "utf8");
const fieldTicketImporter = readFileSync(
  "engine/src/validation/import-field-tickets.ts",
  "utf8",
);

test("connector identity is adapter-scoped and has no cross-source fallback", () => {
  assert.match(
    migrationSource,
    /never compared to[\s\S]{0,30}another adapter's id/i,
  );
  assert.match(migrationSource, /explicit, reviewed one-to-one mapping/i);
  assert.match(loader, /custom->>\$\{refKey\} = \$\{sourceRef\}/);
  assert.match(loader, /contains multiple rows for connector identity/);
  assert.match(loader, /contains duplicate connector identity/);
  assert.match(loader, /connector name must be a stable source namespace/);
  assert.doesNotMatch(loader, /findProjectByRef[\s\S]{0,500}custom->'source'/);
  assert.doesNotMatch(loader, /findPartyByRef[\s\S]{0,500}custom->'source'/);
});

test("role upserts pin the known tenant on the party_id conflict write", () => {
  assert.match(
    loader,
    /on conflict \(party_id\) do update set[\s\S]*?where org_id = \$\{orgId\}/,
  );
});

test("loaded entities retain canonical source identity alongside the adapter key", () => {
  assert.match(loader, /\[refKey\]: rec\.sourceRef/);
  assert.match(
    loader,
    /source:\s*\{\s*system:\s*ctx\.sourceName,\s*externalId:\s*rec\.sourceRef\s*\}/,
  );
  assert.match(loader, /\$\{custom\}::jsonb \|\| parties\.custom/);
});

test("time type persist writes cost_multiplier through canonicalDecimal then normalizeMoney", () => {
  const helperStart = loader.indexOf("function persistTimeTypeCostMultiplier");
  const helperEnd = loader.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistTimeTypeCostMultiplier helper is defined");
  const helper = loader.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);

  const start = loader.indexOf('if (resource === "time_types")');
  const next = loader.indexOf('if (resource === "tax_codes")');
  const body = loader.slice(start, next > start ? next : undefined);
  assert.match(body, /persistTimeTypeCostMultiplier\(/);
  assert.doesNotMatch(body, /normalizeMoney\("1"\)/);
});

test("tax-code persist writes ratePercent through canonicalDecimal then normalizeMoney", () => {
  const helperStart = loader.indexOf("function persistTaxCodeRatePercent");
  const helperEnd = loader.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistTaxCodeRatePercent helper is defined");
  const helper = loader.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);

  const start = loader.indexOf('if (resource === "tax_codes")');
  const next = loader.indexOf('if (resource === "items")');
  const body = loader.slice(start, next > start ? next : undefined);
  assert.match(body, /persistTaxCodeRatePercent\(/);
  assert.doesNotMatch(body, /moneyOrNull\(f\.ratePercent\)/);
  assert.doesNotMatch(body, /normalizeMoney\("0"\)/);
});

test("payment-term insert persist writes discountPercent through canonicalDecimal then normalizeMoney", () => {
  const helperStart = loader.indexOf("function persistPaymentTermDiscountPercent");
  const helperEnd = loader.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistPaymentTermDiscountPercent helper is defined");
  const helper = loader.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);

  const start = loader.indexOf("insert into payment_terms");
  const next = loader.indexOf('if (resource === "time_types")');
  const body = loader.slice(start, next > start ? next : undefined);
  assert.match(body, /persistPaymentTermDiscountPercent\(/);
  assert.doesNotMatch(body, /moneyOrNull\(f\.discountPercent\)/);
});

test("payment-term update persist writes discountPercent through canonicalDecimal then normalizeMoney", () => {
  const start = loader.indexOf("update payment_terms");
  const next = loader.indexOf("insert into payment_terms");
  const body = loader.slice(start, next > start ? next : undefined);
  assert.ok(start >= 0 && next > start, "payment-term discount UPDATE persist is defined");
  assert.match(body, /persistPaymentTermDiscountPercent\(/);
  assert.doesNotMatch(body, /moneyOrNull\(f\.discountPercent\)/);
});

test("time-entry insert persist writes hours through canonicalDecimal then normalizeMoney", () => {
  const helperStart = loader.indexOf("function persistTimeEntryHours");
  const helperEnd = loader.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistTimeEntryHours helper is defined");
  const helper = loader.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);

  const start = loader.indexOf("const flush = async () => {");
  const next = loader.indexOf("for (const rec of records)", start);
  const body = loader.slice(start, next > start ? next : undefined);
  assert.match(body, /persistTimeEntryHours\(/);
  assert.doesNotMatch(body, /moneyOrNull\(f\.hours\)/);
});

test("time-entry insert persist writes costRate through canonicalDecimal then normalizeMoney", () => {
  const helperStart = loader.indexOf("function persistTimeEntryCostRate");
  const helperEnd = loader.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistTimeEntryCostRate helper is defined");
  const helper = loader.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);

  const start = loader.indexOf("const flush = async () => {");
  const next = loader.indexOf("for (const rec of records)", start);
  const body = loader.slice(start, next > start ? next : undefined);
  assert.match(body, /persistTimeEntryCostRate\(/);
  assert.doesNotMatch(body, /moneyOrNull\(f\.costRate\)/);
});

test("time-entry update persist writes hours through canonicalDecimal then normalizeMoney", () => {
  const start = loader.indexOf("update time_entries set worked_on=");
  const next = loader.indexOf("if (billingChanged || costingChanged)", start);
  const body = loader.slice(start, next > start ? next : undefined);
  assert.ok(start >= 0 && next > start, "time-entry hours UPDATE persist is defined");
  assert.match(body, /persistTimeEntryHours\(/);
  assert.doesNotMatch(body, /moneyOrNull\(f\.hours\)/);
  assert.doesNotMatch(body, /normalizeMoney\("0"\)/);
});

test("item persist writes defaultCost through canonicalDecimal then normalizeMoney", () => {
  const helperStart = loader.indexOf("function persistItemDefaultCost");
  const helperEnd = loader.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistItemDefaultCost helper is defined");
  const helper = loader.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);

  const start = loader.indexOf('if (resource === "items")');
  const next = loader.indexOf('if (resource === "projects")');
  const body = loader.slice(start, next > start ? next : undefined);
  assert.match(body, /persistItemDefaultCost\(/);
  assert.doesNotMatch(body, /moneyOrNull\(f\.defaultCost\)/);
});

test("item persist writes defaultRate through canonicalDecimal then normalizeMoney", () => {
  const helperStart = loader.indexOf("function persistItemDefaultRate");
  const helperEnd = loader.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistItemDefaultRate helper is defined");
  const helper = loader.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);

  const start = loader.indexOf('if (resource === "items")');
  const next = loader.indexOf('if (resource === "projects")');
  const body = loader.slice(start, next > start ? next : undefined);
  assert.match(body, /persistItemDefaultRate\(/);
  assert.doesNotMatch(body, /moneyOrNull\(f\.defaultRate\)/);
});

test("project persist writes contractValue through canonicalDecimal then normalizeMoney", () => {
  const helperStart = loader.indexOf("function persistProjectContractValue");
  const helperEnd = loader.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistProjectContractValue helper is defined");
  const helper = loader.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);

  const start = loader.indexOf('if (resource === "projects")');
  const next = loader.indexOf('if (resource === "addresses")');
  const body = loader.slice(start, next > start ? next : undefined);
  assert.match(body, /persistProjectContractValue\(/);
  assert.doesNotMatch(body, /moneyOrNull\(f\.contractValue\)/);
});

test("connector field-ticket imports require an explicit source namespace", () => {
  assert.match(fieldTicketImporter, /--source-system is required/);
  assert.match(fieldTicketImporter, /select base_currency from orgs/);
  assert.match(fieldTicketImporter, /externalId: t\.sourceId/);
  assert.doesNotMatch(fieldTicketImporter, /'CAD'/);
});

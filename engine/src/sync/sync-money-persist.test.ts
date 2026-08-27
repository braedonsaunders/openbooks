import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { persistSyncLineQuantity } from "./sync.ts";

const source = readFileSync(new URL("./sync.ts", import.meta.url), "utf8");

test("a synced line quantity persists at the source adapter's own eight-place scale", () => {
  // The native adapters emit quantity and rate padded to eight places — see the
  // NetSuite invoice-line contract, which pins "2.00000000". Clamping that to
  // ledger money precision rejected every mirrored line outright.
  assert.equal(persistSyncLineQuantity("2.00000000", "quantity"), "2.00000000");
  assert.equal(persistSyncLineQuantity("1", "quantity"), "1.00000000");
  assert.equal(persistSyncLineQuantity("0.00012345", "quantity"), "0.00012345");
  assert.equal(persistSyncLineQuantity("1.2355303E2", "unit price"), "123.55303000");
  // Still fail closed: a significant digit past the column's scale, or a value
  // that is not a decimal at all, is never silently truncated.
  assert.throws(
    () => persistSyncLineQuantity("0.000000001", "quantity"),
    /quantity must be an exact decimal/,
  );
  assert.throws(
    () => persistSyncLineQuantity("", "unit price"),
    /unit price must be an exact decimal/,
  );
});

test("insertImportedLines persists document-line quantity and unitPrice at the numeric(28,8) column scale", () => {
  const helperStart = source.indexOf("function persistSyncLineQuantity");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistSyncLineQuantity helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  // Quantities are not money: eight places, matching document_lines.quantity
  // and the canonical change key, so ordinary 8dp source lines are not rejected
  // and stored documents do not read as permanently amended.
  assert.match(helper, /normalizeDecimal\(String\(value\), 8\)/);
  assert.doesNotMatch(helper, /canonicalDecimal/);
  assert.doesNotMatch(helper, /normalizeMoney/);
  assert.match(helper, /must be an exact decimal/);

  const fn = source.indexOf("async function insertImportedLines");
  const next = source.indexOf("async function runSync(");
  const body = source.slice(fn, next > fn ? next : undefined);
  assert.match(body, /persistSyncLineQuantity\(line\.quantity \?\? "1", "quantity"\)/);
  assert.match(body, /persistSyncLineQuantity\(line\.unitPrice \?\? line\.amount, "unit price"\)/);
  assert.doesNotMatch(body, /normalizeDecimal\(line\.unitPrice \?\? line\.amount, 8\)/);
  assert.doesNotMatch(body, /quantity: line\.quantity \?\? "1"/);
});

test("insertImportedLines persists document-line amount, taxAmount, and billAmount through persistSyncLineMoney", () => {
  const fn = source.indexOf("async function insertImportedLines");
  const next = source.indexOf("async function runSync(");
  const body = source.slice(fn, next > fn ? next : undefined);
  assert.match(body, /persistSyncLineMoney\(line\.amount, "amount"\)/);
  assert.match(body, /persistSyncLineMoney\(line\.taxAmount, "tax amount"\)/);
  assert.match(body, /line\.billAmount == null \? null : persistSyncLineMoney\(line\.billAmount, "bill amount"\)/);
  assert.doesNotMatch(body, /amount: normalizeMoney\(line\.amount\)/);
  assert.doesNotMatch(body, /taxAmount: normalizeMoney\(line\.taxAmount\)/);
  assert.doesNotMatch(body, /billAmount: line\.billAmount == null \? null : normalizeMoney\(line\.billAmount\)/);
});

test("document insert persists subtotal and total through persistSyncLineMoney", () => {
  const insert = source.indexOf(".insert(schema.documents)");
  const returning = source.indexOf(".returning({ id: schema.documents.id })", insert);
  const body = source.slice(insert, returning > insert ? returning : undefined);
  assert.match(body, /persistSyncLineMoney\(doc\.subtotal \?\? "0", "subtotal"\)/);
  assert.match(body, /persistSyncLineMoney\(doc\.total \?\? "0", "total"\)/);
  assert.match(body, /taxTotal: "0"/);
  assert.doesNotMatch(body, /normalizeMoney\(doc\.subtotal/);
  assert.doesNotMatch(body, /normalizeMoney\(doc\.total/);
});

test("document insert persists fxRate through canonicalDecimal then normalizeDecimal at FX scale", () => {
  const helperStart = source.indexOf("function persistSyncFxRate");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistSyncFxRate helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 10\)/);
  assert.match(helper, /normalizeDecimal\(exact, 10\)/);
  assert.match(helper, /FX rate must be an exact decimal/);

  const insert = source.indexOf(".insert(schema.documents)");
  const returning = source.indexOf(".returning({ id: schema.documents.id })", insert);
  const body = source.slice(insert, returning > insert ? returning : undefined);
  assert.match(body, /persistSyncFxRate\(doc\.fxRate \?\? "1"\)/);
  assert.doesNotMatch(body, /normalizeDecimal\(doc\.fxRate \?\? "1", 10\)/);
});

test("document amend persists fx_rate through persistSyncFxRate", () => {
  const amend = source.indexOf("update documents set");
  const where = source.indexOf("where id = ${have.id} and org_id = ${org.id}", amend);
  const body = source.slice(amend, where > amend ? where : undefined);
  assert.match(body, /fx_rate = \$\{persistSyncFxRate\(doc\.fxRate \?\? "1"\)\}/);
  assert.doesNotMatch(body, /normalizeDecimal\(doc\.fxRate \?\? "1", 10\)/);
});

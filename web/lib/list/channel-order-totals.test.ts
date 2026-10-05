import assert from "node:assert/strict";
import test from "node:test";
import { entityListSource } from "./entity-sources.ts";

async function enriched(rows: Record<string, unknown>[], recordType = "channel_order") {
  const source = entityListSource(recordType);
  assert.ok(source?.enrichRows, `${recordType} must enrich its totals`);
  const pending = rows.map((row) => ({ ...row }));
  await source.enrichRows("org-1", pending);
  return pending;
}

test("channel order totals price in the order's own currency", async () => {
  const [row] = await enriched([{ total_minor: "200000", shop_currency: "eur" }]);
  assert.equal(row?.total, "2000.0000");
  assert.equal(row?.totalError ?? null, null);
});

test("a channel order without a currency omits its total and names the gap", async () => {
  for (const shop_currency of [null, undefined, ""]) {
    const [row] = await enriched([{ total_minor: "200000", shop_currency }]);
    assert.equal(row?.total, null, `currency ${String(shop_currency)} must not fall back to another currency`);
    assert.match(
      String(row?.totalError ?? ""),
      /currency/i,
      `currency ${String(shop_currency)} must name the missing currency`,
    );
  }
});

test("a channel order with an unreadable total omits it instead of zeroing", async () => {
  const [row] = await enriched([{ total_minor: "not-a-number", shop_currency: "usd" }]);
  assert.equal(row?.total, null, "an unreadable total must not render as zero");
  assert.match(String(row?.totalError ?? ""), /total/i, "an unreadable total must name the gap");
});

test("channel exceptions price in the order's own currency too", async () => {
  const [row] = await enriched([{ total_minor: "100", shop_currency: "jpy" }], "channel_exception");
  assert.equal(row?.total, "100.0000");
});
